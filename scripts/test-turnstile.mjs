#!/usr/bin/env node
/**
 * 人机认证（Cloudflare Turnstile）端到端测试 —— 顺序是「先密码，后人机验证」。
 *
 *   node scripts/test-turnstile.mjs [baseUrl] [adminPassword]
 *
 * 配合 scripts/mock-turnstile.mjs 使用（本地把 TURNSTILE_VERIFY_URL 指向假端）。
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

const post = (path, body) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function login(password) {
  const res = await post('/admin/api/login', { password });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function verifyHuman(token, pending) {
  const res = await post('/admin/api/verify-human', { token, pending });
  return { status: res.status, body: await res.json().catch(() => ({})), setCookie: res.headers.get('set-cookie') || '' };
}

console.log(`\n\x1b[36m== 人机认证测试（先密码 → 后人机验证）: ${base} ==\x1b[0m`);

/* 1. 页面静态部分 */
let gateEnabled = false;
{
  const html = await (await fetch(`${base}/admin`)).text();
  const cfg = JSON.parse((html.match(/var CFG = (\{.*?\});/s) || [])[1] || '{}');
  gateEnabled = cfg.gateEnabled === true;
  check('页面引用 Turnstile 脚本', html.includes('challenges.cloudflare.com/turnstile/v0/api.js'));
  check('页面含密码框与人机验证两个容器', html.includes('id="gateToken"') && html.includes('id="gateHuman"'));
  check('未登录时 humanVerified=false', cfg.humanVerified === false, JSON.stringify(cfg));
  check('后台页面带 noindex', (await fetch(`${base}/admin`)).headers.get('x-robots-tag') === 'noindex');
  if (!gateEnabled) {
    console.log('\n\x1b[33m该实例没开启人机认证（未配置 TURNSTILE_*），后续验证项跳过。\x1b[0m');
  }
}

/* 2. 未登录 → 后台 API 必须拦死 */
{
  const res = await fetch(`${base}/admin/api/rules`);
  const j = await res.json().catch(() => ({}));
  if (gateEnabled) {
    check('未登录访问后台 API 返回 403', res.status === 403, `HTTP ${res.status}`);
    check('403 标记 human_verification_required', j.code === 'human_verification_required', JSON.stringify(j).slice(0, 120));
  } else {
    check('未带密码访问后台 API 返回 401', res.status === 401, `HTTP ${res.status}`);
  }
}

/* 3. 第一步：密码错的必须 401，且不能拿到 pending 票据（不消耗验证配额） */
{
  const bad = await login('definitely-wrong-password');
  check('错误密码 → 401', bad.status === 401, `HTTP ${bad.status}`);
  check('错误密码标记 bad_password', bad.body.code === 'bad_password', JSON.stringify(bad.body));
  check('错误密码不返回 pending 票据', !bad.body.pending, JSON.stringify(bad.body).slice(0, 80));
  check('错误密码不返回 siteKey', !bad.body.siteKey, String(bad.body.siteKey));
}

/* 4. 第一步：密码正确 → 200 + pending 票据 + humanRequired */
let pending = '';
let siteKeyFromLogin = '';
{
  const good = await login(adminToken);
  check('正确密码 → 200', good.status === 200, `HTTP ${good.status} ${JSON.stringify(good.body)}`);
  if (gateEnabled) {
    check('提示需要人机验证 humanRequired=true', good.body.humanRequired === true, JSON.stringify(good.body));
    check('返回 pending 票据', typeof good.body.pending === 'string' && good.body.pending.split('.').length === 3, String(good.body.pending));
    check('返回 siteKey 供前端渲染挂件', typeof good.body.siteKey === 'string' && good.body.siteKey.length > 10, String(good.body.siteKey));
    pending = good.body.pending || '';
    siteKeyFromLogin = good.body.siteKey || '';
  } else {
    check('未开人机认证时 humanRequired=false', good.body.humanRequired === false, JSON.stringify(good.body));
  }
}

if (gateEnabled) {
  /* 5. 第二步：没票据 / 假票据都不许通过 */
  {
    const noTicket = await verifyHuman('PASS-whatever', '');
    check('缺 pending 票据 → 401', noTicket.status === 401, `HTTP ${noTicket.status}`);
    check('标记 pending_invalid', noTicket.body.code === 'pending_invalid', JSON.stringify(noTicket.body));

    const forged = await verifyHuman('PASS-whatever', `${Math.floor(Date.now() / 1000) + 300}.deadbeef.forgedmac`);
    check('伪造 pending 票据 → 401', forged.status === 401, `HTTP ${forged.status}`);
    check('伪造票据不下发 Cookie', !forged.setCookie, forged.setCookie.slice(0, 60));

    const expired = pending.replace(/^(\d+)\./, (_m, exp) => `${Math.floor(Number(exp)) - 600}.`);
    const expiredRes = await verifyHuman('PASS-whatever', expired);
    check('用过期的 pending 票据 → 401', expiredRes.status === 401, `HTTP ${expiredRes.status}`);
  }

  /* 6. 第二步：带正确票据但假 token → 400（真 siteverify 拒） */
  {
    const bad = await verifyHuman('NOT-A-REAL-TOKEN', pending);
    check('正确票据 + 假 token → 400', bad.status === 400, `HTTP ${bad.status} ${JSON.stringify(bad.body).slice(0, 100)}`);
    check('标记 human_failed', bad.body.code === 'human_failed', JSON.stringify(bad.body).slice(0, 120));
    check('假 token 不下发 Cookie', !bad.setCookie, bad.setCookie.slice(0, 60));
    const still = await fetch(`${base}/admin/api/rules`);
    check('假 token 后依然进不去后台', still.status === 403, `HTTP ${still.status}`);
  }

  /* 7. 第二步：正确票据 + 正确 token → 下发会话 Cookie */
  let cookie = '';
  {
    const ok = await verifyHuman('PASS-mock-token-1', pending);
    if (ok.status === 200) {
      cookie = (ok.setCookie || '').split(';')[0];
      check('正确 token → 200', true);
      check('下发会话 Cookie', cookie.startsWith('llm_fake_gate='), ok.setCookie.slice(0, 80));
      check('Cookie 带 HttpOnly', /HttpOnly/i.test(ok.setCookie));
      check('Cookie 带 Secure', /Secure/i.test(ok.setCookie));
      check('Cookie 带 SameSite=Lax', /SameSite=Lax/i.test(ok.setCookie));

      const ok2 = await verifyHuman('PASS-mock-token-2', pending);
      check('同一票据可重复使用（12h 会话内无副作用）', ok2.status === 200, `HTTP ${ok2.status}`);
    } else {
      skipped(`正确 token 通过（本实例用真实 Turnstile，需浏览器人工验证）: HTTP ${ok.status} ${JSON.stringify(ok.body).slice(0, 80)}`);
    }
  }

  /* 8. 拿到会话 Cookie 后：后台可读，但密码不对依然不行 */
  if (cookie) {
    const res = await fetch(`${base}/admin/api/rules`, { headers: { cookie, 'x-admin-token': adminToken } });
    const j = await res.json();
    check('带会话 Cookie + 密码 → 可读后台规则', res.status === 200 && j.ok === true, `HTTP ${res.status}`);

    if (!Array.isArray(j.rules) || j.rules.length === 0) {
      await fetch(`${base}/admin/api/rules`, {
        method: 'POST',
        headers: { cookie, 'x-admin-token': adminToken, 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'turnstile-test', name: '人机认证测试规则', content: '命中：{{user}}', priority: 1 }),
      });
    }
    const res3 = await fetch(`${base}/admin/api/rules`, { headers: { cookie, 'x-admin-token': adminToken } });
    const j3 = await res3.json();
    check('规则数据可读且非空', Array.isArray(j3.rules) && j3.rules.length > 0, `${j3.rules?.length}`);

    const html = await (await fetch(`${base}/admin`, { headers: { cookie } })).text();
    check('页面进入 humanVerified=true 状态', /"humanVerified":true/.test(html));

    const wrongPw = await fetch(`${base}/admin/api/rules`, { headers: { cookie, 'x-admin-token': 'wrong-password' } });
    check('过了人机验证但密码错 → 401', wrongPw.status === 401, `HTTP ${wrongPw.status}`);

    /* 9. Cookie 防篡改 */
    const tampered = cookie.replace(/llm_fake_gate=(\d+)\./, (_m, ts) => `llm_fake_gate=${Number(ts) + 99999}.`);
    check('改过期时间戳 → 被拒', (await fetch(`${base}/admin/api/rules`, { headers: { cookie: tampered, 'x-admin-token': adminToken } })).status === 403);
    check('改签名 → 被拒', (await fetch(`${base}/admin/api/rules`, { headers: { cookie: cookie.slice(0, -2) + 'xx', 'x-admin-token': adminToken } })).status === 403);
    const fake = `llm_fake_gate=${Math.floor(Date.now() / 1000 + 86400)}.deadbeefdeadbeef`;
    check('伪造 Cookie → 被拒', (await fetch(`${base}/admin/api/rules`, { headers: { cookie: fake, 'x-admin-token': adminToken } })).status === 403);
  }
}

/* 10. 公开接口不受影响 */
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
