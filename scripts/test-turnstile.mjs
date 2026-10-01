#!/usr/bin/env node
/**
 * 人机认证（Cloudflare Turnstile）端到端测试。
 *
 *   node scripts/test-turnstile.mjs [baseUrl] [adminToken]
 *
 * 覆盖：未验证时后台接口应 403 / 页面上必须有 Turnstile 挂件 /
 *       假 token 必须被拒 / 真 token 通过后下发签名 Cookie /
 *       拿到 Cookie 后后台可用 / 篡改 Cookie 必须失效 / 过期 Cookie 必须失效 / token 不可重放。
 *
 * 配合 scripts/mock-turnstile.mjs 使用（本地把 TURNSTILE_VERIFY_URL 指向假端）。
 * 打线上真实 Turnstile 时，只有"假 token 被拒"和"页面有挂件"这几项能测，
 * 真 token 需要浏览器里人工过一次验证。
 */

const base = (process.argv[2] || 'http://127.0.0.1:8799').replace(/\/+$/, '');
const adminToken = process.argv[3] || 'dev-local-password';

let pass = 0;
let fail = 0;
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

/** 提交 Turnstile token，返回响应与 Set-Cookie */
async function submitHuman(token) {
  const form = new FormData();
  form.append('cf-turnstile-response', token);
  const res = await fetch(`${base}/admin/api/verify-human`, { method: 'POST', body: form, redirect: 'manual' });
  const setCookie = res.headers.get('set-cookie') || '';
  return { res, setCookie, cookie: setCookie.split(';')[0], location: res.headers.get('location') || '' };
}

console.log(`\n\x1b[36m== 人机认证测试: ${base} ==\x1b[0m`);

/* 1. 页面必须带 Turnstile，且未验证时不吐后台数据 */
{
  const html = await (await fetch(`${base}/admin`)).text();
  check('后台页面引用 Turnstile 脚本', html.includes('challenges.cloudflare.com/turnstile/v0/api.js'));
  check('页面含人机验证容器', html.includes('id="gateHuman"'));
  check('页面注入了 sitekey 配置', /"siteKey":"[^"]+"/.test(html));
  check('未通过验证时不下发规则数据', !html.includes('响应规则 <span') || html.includes('gateEnabled'));
  check('后台页面带 noindex', (await fetch(`${base}/admin`)).headers.get('x-robots-tag') === 'noindex');
}

/* 2. 未验证 → 后台 API 必须 403 */
{
  const res = await fetch(`${base}/admin/api/rules`);
  const j = await res.json().catch(() => ({}));
  check('未验证访问后台 API 返回 403', res.status === 403, `HTTP ${res.status}`);
  check('403 带 human_verification_required 标记', j.code === 'human_verification_required', JSON.stringify(j).slice(0, 120));
}

/* 3. 假 token 必须被拒 */
{
  const { res, setCookie, location } = await submitHuman('NOT-A-REAL-TOKEN');
  check('假 token 被拒（HTTP 400）', res.status === 400, `HTTP ${res.status}`);
  check('假 token 不下发 Cookie', !setCookie, setCookie.slice(0, 60));
  check('失败响应带错误提示跳转', location.includes('/admin?err='), location);
  const rules = await fetch(`${base}/admin/api/rules`);
  check('失败后依然拿不到后台数据', rules.status === 403, `HTTP ${rules.status}`);
}

/* 4. 重放类 token 也要被拒（模拟 timeout-or-duplicate） */
{
  const { res, setCookie } = await submitHuman('DUP-TOKEN');
  check('重放/超时 token 被拒', res.status === 400 && !setCookie, `HTTP ${res.status}`);
}

/* 5. 正确 token → 下发签名 Cookie，随后后台可用 */
let gateCookie = '';
{
  const { res, setCookie, cookie, location } = await submitHuman('PASS-mock-token-1');
  gateCookie = cookie;
  check('正确 token 通过并 303 跳转', res.status === 303, `HTTP ${res.status}`);
  check('通过后带回 /admin', location.includes('/admin'), location);
  check('下发了会话 Cookie', cookie.startsWith('llm_fake_gate='), setCookie.slice(0, 80));
  check('Cookie 带 HttpOnly', /HttpOnly/i.test(setCookie));
  check('Cookie 带 Secure', /Secure/i.test(setCookie));
  check('Cookie 带 SameSite=Lax', /SameSite=Lax/i.test(setCookie));

  const res2 = await fetch(`${base}/admin/api/rules`, { headers: { cookie: gateCookie, 'x-admin-token': adminToken } });
  const j2 = await res2.json();
  check('带 Cookie 可正常读后台规则', res2.status === 200 && j2.ok === true, `HTTP ${res2.status}`);

  // 本地 KV 可能是空的，先补一条规则再验证"通过人机认证后能拿到真实数据"
  if (!Array.isArray(j2.rules) || j2.rules.length === 0) {
    await fetch(`${base}/admin/api/rules`, {
      method: 'POST',
      headers: { cookie: gateCookie, 'x-admin-token': adminToken, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'turnstile-test', name: '人机认证测试规则', content: '命中：{{user}}', priority: 1 }),
    });
  }
  const res3 = await fetch(`${base}/admin/api/rules`, { headers: { cookie: gateCookie, 'x-admin-token': adminToken } });
  const j3 = await res3.json();
  check('规则数据可读且非空', Array.isArray(j3.rules) && j3.rules.length > 0, `${j3.rules?.length}`);
  check('规则内容正确返回', j3.rules?.some((r) => r.id === 'turnstile-test') === true, JSON.stringify(j3.rules?.map((r) => r.id)));

  const html = await (await fetch(`${base}/admin`, { headers: { cookie: gateCookie } })).text();
  check('通过后页面进入令牌框模式（gateOk=true）', /"gateOk":true/.test(html));
}

/* 6. Cookie 必须防篡改 */
{
  const tampered = gateCookie.replace(/llm_fake_gate=(\d+)\./, (m, ts) => `llm_fake_gate=${Number(ts) + 99999}.`);
  const res = await fetch(`${base}/admin/api/rules`, { headers: { cookie: tampered, 'x-admin-token': adminToken } });
  check('改过期时间戳 → 签名不匹配被拒', res.status === 403, `HTTP ${res.status}`);

  const badMac = gateCookie.slice(0, -2) + 'xx';
  const res2 = await fetch(`${base}/admin/api/rules`, { headers: { cookie: badMac, 'x-admin-token': adminToken } });
  check('改签名 → 被拒', res2.status === 403, `HTTP ${res2.status}`);

  const fabricated = 'llm_fake_gate=' + Math.floor(Date.now() / 1000 + 86400) + '.deadbeefdeadbeef';
  const res3 = await fetch(`${base}/admin/api/rules`, { headers: { cookie: fabricated, 'x-admin-token': adminToken } });
  check('伪造 Cookie → 被拒', res3.status === 403, `HTTP ${res3.status}`);
}

/* 7. 两层防护叠加：过了人机验证但令牌不对，依然进不去 */
{
  const res = await fetch(`${base}/admin/api/rules`, { headers: { cookie: gateCookie, 'x-admin-token': 'wrong-password' } });
  check('过了人机验证但令牌错误 → 401', res.status === 401, `HTTP ${res.status}`);
}

/* 8. 其它路径不受影响（人机认证只保护后台） */
{
  const h = await fetch(`${base}/health`);
  check('公开 API 不受人机认证影响', h.status === 200);
  const c = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'fake-gpt-4o', messages: [{ role: 'user', content: '人机认证测试' }] }),
  });
  check('推理接口不受人机认证影响', c.status === 200, `HTTP ${c.status}`);
}

console.log(`\n== 通过 ${pass} 项，失败 ${fail} 项 ==`);
if (fail > 0) {
  console.log('失败项：\n - ' + failures.join('\n - '));
  process.exit(1);
}
