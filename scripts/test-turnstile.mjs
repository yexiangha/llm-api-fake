#!/usr/bin/env node
/**
 * 人机认证（Cloudflare Turnstile）端到端测试 —— 顺序是「先人机验证，后输密码」，且每次都跳。
 *
 *   node scripts/test-turnstile.mjs [baseUrl] [adminPassword]
 *
 * 配合 scripts/mock-turnstile.mjs 使用（本地把 TURNSTILE_VERIFY_URL 指向假端，
 * 并把 GATE_TTL_SECONDS 设小以便验证"会话过期后重新要求验证"）。
 * 打线上真实 Turnstile 时，正确 token 需要浏览器人工过一次，脚本会自动跳过那几项。
 */

const base = (process.argv[2] || 'http://127.0.0.1:8799').replace(/\/+$/, '');
const adminToken = process.argv[3] || 'dev-local-password';

let pass = 0;
let fail = 0;
let skip = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  \x1b[32mPASS\x1b[0m  ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? `  → ${detail}` : ''}`);
  }
}
function skipped(name) {
  skip++;
  console.log(`  \x1b[33mSKIP\x1b[0m  ${name}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (path, body, headers = {}) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

const verifyHuman = async (token, headers = {}) => {
  const res = await post('/admin/api/verify-human', { token }, headers);
  return { status: res.status, body: await res.json().catch(() => ({})), setCookie: res.headers.get('set-cookie') || '' };
};
const login = async (password, headers = {}) => {
  const res = await post('/admin/api/login', { password }, headers);
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

console.log(`\n\x1b[36m== 人机认证测试（先验证 → 后密码，每次进入都要验证）: ${base} ==\x1b[0m`);

/* 1. 页面静态部分 */
let gateEnabled = false;
let ttlMinutes = 0;
{
  const html = await (await fetch(`${base}/admin`)).text();
  const cfg = JSON.parse((html.match(/var CFG = (\{.*?\});/s) || [])[1] || '{}');
  gateEnabled = cfg.gateEnabled === true;
  ttlMinutes = cfg.gateTtlMinutes || 0;
  check('页面引用 Turnstile 脚本', html.includes('challenges.cloudflare.com/turnstile/v0/api.js'));
  check('页面同时含验证容器与密码框（按步切换）', html.includes('id="gateHuman"') && html.includes('id="gateToken"'));
  check('未登录时 humanVerified=false', cfg.humanVerified === false, JSON.stringify(cfg));
  check('后台页面带 noindex', (await fetch(`${base}/admin`)).headers.get('x-robots-tag') === 'noindex');
  if (gateEnabled) console.log(`  \x1b[90m验证会话窗口: ${ttlMinutes} 分钟\x1b[0m`);
  else console.log('\n\x1b[33m该实例没开启人机认证（未配置 TURNSTILE_*），后续验证项跳过。\x1b[0m');
}

/* 2. 没验证时：后台 API 一律 403，且连"密码对不对"都探测不到 */
{
  const noCookie = await fetch(`${base}/admin/api/rules`);
  const j = await noCookie.json().catch(() => ({}));
  if (gateEnabled) {
    check('未验证访问后台 API 返回 403', noCookie.status === 403, `HTTP ${noCookie.status}`);
    check('403 标记 human_verification_required', j.code === 'human_verification_required', JSON.stringify(j).slice(0, 120));

    // 关键：带正确密码也进不去（验证优先）
    const withPassword = await login(adminToken);
    check('未过验证时即使密码正确也被拦（403）', withPassword.status === 403, `HTTP ${withPassword.status}`);
    check('被拦响应仍是 human_verification_required', withPassword.body.code === 'human_verification_required', JSON.stringify(withPassword.body).slice(0, 120));
  } else {
    check('未带密码访问后台 API 返回 401', noCookie.status === 401, `HTTP ${noCookie.status}`);
  }
}

if (gateEnabled) {
  /* 3. 假 token 必须被真 siteverify 拒 */
  {
    const bad = await verifyHuman('NOT-A-REAL-TOKEN');
    check('假 token → 400', bad.status === 400, `HTTP ${bad.status} ${JSON.stringify(bad.body).slice(0, 100)}`);
    check('标记 human_failed', bad.body.code === 'human_failed', JSON.stringify(bad.body).slice(0, 120));
    check('假 token 不下发会话 Cookie', !bad.setCookie, bad.setCookie.slice(0, 60));
    const still = await fetch(`${base}/admin/api/rules`);
    check('假 token 后依然进不去后台', still.status === 403, `HTTP ${still.status}`);
  }

  /* 4. 正确 token → 下发会话 Cookie，然后才允许输密码 */
  let cookie = '';
  let cookieTtlSeconds = 0;
  {
    const ok = await verifyHuman('PASS-mock-token-1');
    if (ok.status === 200) {
      cookie = (ok.setCookie || '').split(';')[0];
      cookieTtlSeconds = Number((ok.setCookie.match(/Max-Age=(\d+)/) || [])[1] || 0);
      check('正确 token → 200', true);
      check('下发会话 Cookie', cookie.startsWith('llm_fake_gate='), ok.setCookie.slice(0, 80));
      check('Cookie 带 HttpOnly', /HttpOnly/i.test(ok.setCookie));
      check('Cookie 带 Secure', /Secure/i.test(ok.setCookie));
      check('Cookie 带 SameSite=Lax', /SameSite=Lax/i.test(ok.setCookie));
      check('会话窗口很短（≤60 分钟，体现"每次都验"）', cookieTtlSeconds > 0 && cookieTtlSeconds <= 3600, `${cookieTtlSeconds}s`);
    } else {
      skipped(`正确 token 通过（本实例用真实 Turnstile，需浏览器人工验证）: HTTP ${ok.status} ${JSON.stringify(ok.body).slice(0, 80)}`);
    }
  }

  if (cookie) {
    /* 5. 有了会话才轮到密码 */
    const wrongPw = await login('definitely-wrong', { cookie });
    check('过了验证但密码错 → 401 bad_password', wrongPw.status === 401 && wrongPw.body.code === 'bad_password', `HTTP ${wrongPw.status} ${JSON.stringify(wrongPw.body)}`);

    const goodPw = await login(adminToken, { cookie });
    check('过了验证且密码对 → 200', goodPw.status === 200 && goodPw.body.ok === true, `HTTP ${goodPw.status}`);

    const rules = await fetch(`${base}/admin/api/rules`, { headers: { cookie, 'x-admin-token': adminToken } });
    const rj = await rules.json();
    check('会话 + 密码 → 可读后台规则', rules.status === 200 && rj.ok === true, `HTTP ${rules.status}`);

    if (!Array.isArray(rj.rules) || rj.rules.length === 0) {
      await fetch(`${base}/admin/api/rules`, {
        method: 'POST',
        headers: { cookie, 'x-admin-token': adminToken, 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'turnstile-test', name: '人机认证测试规则', content: '命中：{{user}}', priority: 1 }),
      });
    }
    const rj2 = await (await fetch(`${base}/admin/api/rules`, { headers: { cookie, 'x-admin-token': adminToken } })).json();
    check('规则数据可读且非空', Array.isArray(rj2.rules) && rj2.rules.length > 0, `${rj2.rules?.length}`);

    const page = await (await fetch(`${base}/admin`, { headers: { cookie } })).text();
    check('页面进入 humanVerified=true 状态', /"humanVerified":true/.test(page));

    /* 6. 只有会话、没有密码 → 依然读不到数据 */
    const noPw = await fetch(`${base}/admin/api/rules`, { headers: { cookie } });
    check('只有会话没有密码 → 401', noPw.status === 401, `HTTP ${noPw.status}`);

    /* 7. Cookie 防篡改 */
    const tampered = cookie.replace(/llm_fake_gate=(\d+)\./, (_m, ts) => `llm_fake_gate=${Number(ts) + 99999}.`);
    check('改过期时间戳 → 被拒', (await fetch(`${base}/admin/api/rules`, { headers: { cookie: tampered, 'x-admin-token': adminToken } })).status === 403);
    check('改签名 → 被拒', (await fetch(`${base}/admin/api/rules`, { headers: { cookie: cookie.slice(0, -2) + 'xx', 'x-admin-token': adminToken } })).status === 403);
    const fake = `llm_fake_gate=${Math.floor(Date.now() / 1000 + 86400)}.deadbeefdeadbeef`;
    check('伪造 12 小时 Cookie → 被拒（不能靠伪造换长期免验证）', (await fetch(`${base}/admin/api/rules`, { headers: { cookie: fake, 'x-admin-token': adminToken } })).status === 403);

    /* 8. 会话过期 → 重新要求验证（本地用小 TTL 才能实测） */
    if (cookieTtlSeconds > 0 && cookieTtlSeconds <= 30) {
      console.log(`  \x1b[90m等待会话过期（${cookieTtlSeconds}s）…\x1b[0m`);
      await sleep((cookieTtlSeconds + 2) * 1000);
      const expired = await fetch(`${base}/admin/api/rules`, { headers: { cookie, 'x-admin-token': adminToken } });
      const ej = await expired.json().catch(() => ({}));
      check('会话过期后 → 重新要求人机验证（403）', expired.status === 403 && ej.code === 'human_verification_required', `HTTP ${expired.status}`);
      const html = await (await fetch(`${base}/admin`, { headers: { cookie } })).text();
      check('过期后页面回到 humanVerified=false', /"humanVerified":false/.test(html));
    } else {
      skipped(`会话过期行为（TTL ${cookieTtlSeconds}s，需 GATE_TTL_SECONDS≤30 才能实测）`);
    }
  }
}

/* 9. 公开接口不受影响 */
{
  check('公开 API /health 不受影响', (await fetch(`${base}/health`)).status === 200);
  const c = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'fake-gpt-4o', messages: [{ role: 'user', content: '人机认证测试' }] }),
  });
  check('推理接口 /v1/chat/completions 不受影响', c.status === 200, `HTTP ${c.status}`);
}

console.log(`\n== 通过 ${pass} 项，失败 ${fail} 项${skip ? `，跳过 ${skip} 项` : ''} ==`);
if (fail > 0) {
  console.log('失败项：\n - ' + failures.join('\n - '));
  process.exit(1);
}
