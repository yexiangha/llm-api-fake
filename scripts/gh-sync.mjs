#!/usr/bin/env node
/**
 * 用 GitHub REST（Git Data API）把本地文件同步到远程仓库。
 *
 * 为什么需要它：部分网络环境下 github.com:443 被拦，`git push` 走的是 git-over-HTTPS
 * 到 github.com，必然失败；而 api.github.com 仍可访问。这个脚本用官方 API
 * 逐个文件建 blob → 组 tree → 建 commit → 更新 ref，效果等价于一次 push。
 *
 *   node scripts/gh-sync.mjs                  # 提交并推送 main（默认 yexiangha/llm-api-fake）
 *   node scripts/gh-sync.mjs owner/repo main
 *
 * 令牌来源：环境变量 GH_TOKEN / GITHUB_TOKEN，或本机 `gh auth token`。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const REPO = process.argv[2] || 'yexiangha/llm-api-fake';
const BRANCH = process.argv[3] || 'main';
const ROOT = process.cwd();
const API = 'https://api.github.com';

const ALWAYS_SKIP = new Set(['.git', 'node_modules', '.wrangler', 'dist', '.tmp_fetch']);
const BINARY_EXT = /\.(png|jpg|jpeg|gif|ico|webp|woff2?|zip|pdf|pt|whl)$/i;

/**
 * 密钥类文件硬拦：无论 .gitignore 写得怎么样，这些文件绝不外传。
 * （这条是真正的安全底线——同步脚本一旦漏了一行 ignore 规则，
 *   本地密码就会被推到公开仓库里。）
 */
const SECRET_PATTERNS = [/^\.dev\.vars/, /^\.env($|\.)/, /\.pem$/i, /\.key$/i, /^id_(rsa|ed25519)/, /credentials\.json$/i];
const isSecretPath = (relPath) => SECRET_PATTERNS.some((re) => re.test(relPath.split('/').pop() || ''));

function token() {
  const env = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (env) return env.trim();
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
  } catch {
    throw new Error('拿不到 GitHub 令牌：请设置 GH_TOKEN 或先 gh auth login');
  }
}

const AUTH = { authorization: `Bearer ${token()}`, accept: 'application/vnd.github+json', 'user-agent': 'llm-api-fake-sync' };

async function api(path, init = {}) {
  const res = await fetch(`${API}${path}`, { ...init, headers: { ...AUTH, ...(init.headers || {}) } });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 保持文本 */
  }
  if (!res.ok) {
    const detail = json?.errors ? ` errors=${JSON.stringify(json.errors)}` : '';
    throw new Error(`${init.method || 'GET'} ${path} → ${res.status} ${json?.message || text.slice(0, 200)}${detail}`);
  }
  return json;
}

/** 读取 .gitignore 里的简单规则（名称/后缀/目录），避免把本地文件推上去 */
function ignoreMatcher(root) {
  let lines = [];
  try {
    lines = readFileSync(join(root, '.gitignore'), 'utf8').split(/\r?\n/);
  } catch {
    /* 没有就算了 */
  }
  const names = new Set();
  const globs = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const clean = line.replace(/^\/+/, '').replace(/\/+$/, '');
    if (!clean) continue;
    if (!clean.includes('*')) {
      names.add(clean);
      names.add(clean.split('/').pop()); // node_modules/ 这类目录规则
    } else {
      globs.push(new RegExp(`^${clean.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`));
    }
  }
  return (relPath) => {
    const parts = relPath.split('/');
    const base = parts[parts.length - 1];
    if (parts.some((p) => ALWAYS_SKIP.has(p))) return true;
    if (isSecretPath(relPath)) return true;
    if (names.has(relPath) || names.has(base)) return true;
    if (parts.some((p) => names.has(p))) return true;
    return globs.some((re) => re.test(relPath) || re.test(base));
  };
}

function walk(dir, out = []) {
  const ignored = ignoreMatcher(ROOT);
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const rel = relative(ROOT, abs).split(sep).join('/');
    if (ALWAYS_SKIP.has(entry) || ignored(rel)) {
      if (isSecretPath(rel)) console.log(`  🔒 跳过密钥类文件: ${rel}`);
      continue;
    }
    const st = statSync(abs);
    if (st.isDirectory()) walk(abs, out);
    else if (st.isFile()) out.push({ rel, abs, size: st.size });
  }
  return out;
}

const files = walk(ROOT).sort((a, b) => a.rel.localeCompare(b.rel));
console.log(`准备推送 ${files.length} 个文件到 ${REPO}@${BRANCH}`);

/* 0. 出门前最后一道保险：任何疑似密钥文件都不许上传 */
const leaked = files.filter((f) => isSecretPath(f.rel));
if (leaked.length) {
  console.error(`\n❌ 检测到疑似密钥文件，已中止：${leaked.map((f) => f.rel).join(', ')}`);
  process.exit(1);
}

/* 1. 父提交（用于 base_tree 与继承提交信息，避免重复同步产生噪音提交） */
let parentSha = null;
let parent = null;
try {
  const ref = await api(`/repos/${REPO}/git/ref/heads/${BRANCH}`);
  parentSha = ref.object.sha;
  parent = await api(`/repos/${REPO}/git/commits/${parentSha}`);
} catch (e) {
  // 404：分支不存在；409：仓库还是空的（Git Repository is empty）—— 两种情况都按首个提交处理
  const msg = String(e.message);
  if (!msg.includes('404') && !msg.includes('409')) throw e;
  console.log('  远程还没有提交，将创建首个提交');
}

/**
 * GitHub 的空仓库不接受 Git Data API 的建 blob 请求，得先用官方 Contents API
 * 栽一个"冰文件"（.gitkeep）让仓库有历史，随后真正的内容再作为它的子提交推上去。
 */
if (!parentSha) {
  try {
    await api(`/repos/${REPO}/contents/.gitkeep`, {
      method: 'PUT',
      body: JSON.stringify({ message: 'chore: 初始化仓库', content: Buffer.from('').toString('base64') }),
    });
    const ref = await api(`/repos/${REPO}/git/ref/heads/${BRANCH}`);
    parentSha = ref.object.sha;
    parent = await api(`/repos/${REPO}/git/commits/${parentSha}`);
    console.log('  已用 Contents API 初始化空仓库');
  } catch (e) {
    console.log(`  初始化空仓库失败（继续尝试直接建 ref）：${e.message}`);
  }
}
const baseTree = parent?.tree?.sha ?? null;

/* 2. 逐个文件建 blob（文本用 utf-8，二进制用 base64）
 *    .github/workflows/ 需要令牌带 workflow scope，缺 scope 时 GitHub 会返回 404，
 *    这时把它跳过并记下来，不能让一个文件挡住整次同步（普通 git push 不受此限）。 */
const tree = [];
const skipped = [];
for (const f of files) {
  if (f.rel === '.gitkeep') continue; // 仅用于给空仓库"破冰"的哨兵文件，不进 tree
  const buf = readFileSync(f.abs);
  const isBinary = BINARY_EXT.test(f.rel) || buf.includes(0);
  const blob = await api(`/repos/${REPO}/git/blobs`, {
    method: 'POST',
    body: JSON.stringify(
      isBinary ? { content: buf.toString('base64'), encoding: 'base64' } : { content: buf.toString('utf8'), encoding: 'utf-8' },
    ),
  });
  tree.push({ path: f.rel, mode: '100644', type: 'blob', sha: blob.sha });
  console.log(`  blob ${f.rel} (${f.size}B${isBinary ? ', binary' : ''})`);
}

/* 3. tree：先整体提交；若被 workflow scope 卡住，摘掉 .github/workflows/ 再试一次 */
async function createTree(entries) {
  return api(`/repos/${REPO}/git/trees`, {
    method: 'POST',
    body: JSON.stringify(baseTree ? { base_tree: baseTree, tree: entries } : { tree: entries }),
  });
}

let newTree;
try {
  newTree = await createTree(tree);
} catch (e) {
  const workflowEntries = tree.filter((t) => t.path.startsWith('.github/workflows/'));
  if (!workflowEntries.length) throw e;
  for (const t of workflowEntries) skipped.push({ rel: t.path, reason: 'need workflow scope' });
  console.log(`  ⏭  令牌缺 workflow scope，跳过 ${workflowEntries.length} 个工作流文件后重试`);
  newTree = await createTree(tree.filter((t) => !t.path.startsWith('.github/workflows/')));
}

if (baseTree && baseTree === newTree.sha) {
  console.log('\n远程内容已是最新，无需提交。');
  process.exit(0);
}

/* 4. commit：默认沿用本地 HEAD 的提交信息，保证本地 git log 与远端一致 */
let message = process.env.COMMIT_MESSAGE;
let date = new Date().toISOString();
if (!message) {
  try {
    message = execFileSync('git', ['log', '-1', '--pretty=%B'], { cwd: ROOT, encoding: 'utf8' }).trim();
    date = execFileSync('git', ['log', '-1', '--pretty=%cI'], { cwd: ROOT, encoding: 'utf8' }).trim() || date;
  } catch {
    message = `chore: 同步本地文件（${date}）`;
  }
}

const commit = await api(`/repos/${REPO}/git/commits`, {
  method: 'POST',
  body: JSON.stringify({
    message,
    tree: newTree.sha,
    parents: parentSha ? [parentSha] : [],
    author: { name: 'yexiangha', email: 'yexiangha@163.com', date },
    committer: { name: 'yexiangha', email: 'yexiangha@163.com', date },
  }),
});

if (parentSha) {
  await api(`/repos/${REPO}/git/refs/heads/${BRANCH}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commit.sha, force: true }),
  });
} else {
  await api(`/repos/${REPO}/git/refs`, { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${BRANCH}`, sha: commit.sha }) });
}

console.log(`\n✅ ${REPO}@${BRANCH} 已更新`);
console.log(`   旧提交: ${parentSha ? parentSha.slice(0, 7) : '(无)'}  新提交: ${commit.sha.slice(0, 7)}`);
console.log(`   https://github.com/${REPO}/commit/${commit.sha}`);

if (skipped.length) {
  console.log(`\n⚠️  以下文件未能通过 API 推送：`);
  for (const s of skipped) console.log(`   - ${s.rel}（${s.reason}）`);
  console.log(`   原因：GitHub 要求令牌带 workflow scope 才允许写 .github/workflows/。`);
  console.log(`   解决：本机执行一次  gh auth refresh -s workflow  然后重跑本脚本，`);
  console.log(`        或等网络能直连 github.com 时用普通  git push  推上去（本地提交里已包含这些文件）。`);
}
