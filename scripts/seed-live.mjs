#!/usr/bin/env node
/**
 * 给线上（或本地）实例灌入一套开箱即用的示例规则，并做一次 UTF-8 中文往返验证。
 *
 *   node scripts/seed-live.mjs https://llm.yexiangha.top 后台密码
 */

const base = (process.argv[2] || 'https://llm.yexiangha.top').replace(/\/+$/, '');
const token = process.argv[3];
if (!token) {
  console.error('用法: node scripts/seed-live.mjs <baseUrl> <adminPassword>');
  process.exit(2);
}

const H = { 'content-type': 'application/json', 'x-admin-token': token };

const rules = [
  {
    id: 'default',
    name: '默认回复（兜底）',
    enabled: true,
    isDefault: true,
    priority: -10,
    match: {},
    content:
      '你好，我是跑在 Cloudflare Workers 上的「假 LLM」。\n\n' +
      '你说的是：{{user}}\n' +
      '模型：{{model}} · 消息指纹 {{hash}} · 时间 {{time}}\n\n' +
      '这条回复完全来自 KV 里存好的自定义文本，没有任何真实模型被调用。\n' +
      '想改剧本？打开 /admin 后台，写什么它就答什么。',
    finishReason: 'stop',
    note: '兜底规则：所有没被其它规则命中的请求都走这条',
  },
  {
    id: 'identity',
    name: '示例 · 被问身份时坦白',
    enabled: true,
    priority: 10,
    match: { keyword: '你是谁' },
    content: '我是一个假的 AI。所有回复都是 llm.yexiangha.top 后台里预先写好的文本，后端一行模型推理代码都没有 🙂',
    finishReason: 'stop',
    note: '关键词匹配示例',
  },
  {
    id: 'demo-placeholders',
    name: '示例 · 占位符全家桶',
    enabled: true,
    priority: 20,
    match: { keyword: '占位符' },
    content:
      '本次请求信息如下：\n\n' +
      '用户消息：{{user}}\n' +
      '角色文本：{{messages}}\n' +
      '模型名：{{model}}\n' +
      '请求 id：{{id}}\n' +
      '路径/方法：{{method}} {{path}}\n' +
      '时间：{{time}} · 指纹：{{hash}} · 随机串：{{rand}}\n' +
      '字数：{{len}} · 词数：{{words}} · key：{{key}}',
    finishReason: 'stop',
    note: '演示所有可用占位符',
  },
  {
    id: 'demo-regex',
    name: '示例 · 正则匹配「帮我…代码」',
    enabled: true,
    priority: 30,
    match: { regex: '^帮我.*代码' },
    content: '（假装认真）好的，我"写"给你：\n\n```js\n// 这段代码是后台规则里写死的，跟你的需求无关 🙂\nconsole.log("{{user}}");\n```',
    finishReason: 'stop',
    note: '正则匹配示例（只匹配用户最后一句）',
  },
];

async function main() {
  let ok = 0;
  for (const rule of rules) {
    const res = await fetch(`${base}/admin/api/rules`, { method: 'POST', headers: H, body: JSON.stringify(rule) });
    const j = await res.json().catch(() => ({}));
    if (res.ok && j.ok) {
      ok++;
      console.log(`  ✔ 写入规则 ${j.action === 'created' ? '新建' : '更新'}: ${rule.id} (${rule.name})`);
    } else {
      console.log(`  ✘ 规则 ${rule.id} 失败: ${res.status} ${j.error || ''}`);
    }
  }
  console.log(`\n共写入 ${ok}/${rules.length} 条规则`);

  console.log('\n等 11 秒让 worker 内的规则缓存过期…');
  await new Promise((r) => setTimeout(r, 11_000));

  console.log('\n== UTF-8 中文往返验证 ==');
  const probe = '你好，测试中文与 emoji 🚀';
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer sk-seed-check' },
    body: JSON.stringify({ model: 'fake-gpt-4o', messages: [{ role: 'user', content: probe }] }),
  });
  const j = await res.json();
  const content = j.choices?.[0]?.message?.content || '';
  console.log(`  发送: ${probe}`);
  console.log(`  收到: ${content.split('\n').filter(Boolean)[1] || content.slice(0, 80)}`);
  console.log(`  中文无损: ${content.includes('测试中文与 emoji 🚀') ? '✅ 是' : '❌ 否'}`);

  const hit = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'fake-gpt-4o', messages: [{ role: 'user', content: '你是谁呀' }] }),
  });
  const hj = await hit.json();
  console.log(`  关键词规则命中: ${(hj.choices?.[0]?.message?.content || '').slice(0, 40)}…`);
  console.log(`  命中规则 id: ${decodeURIComponent(hit.headers.get('x-fake-rule') || '')}`);
}

main().catch((e) => {
  console.error('失败:', e.message);
  process.exit(1);
});
