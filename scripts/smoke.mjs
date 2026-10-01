#!/usr/bin/env node
/**
 * 端到端冒烟测试（本地 wrangler dev 或线上均可）
 *
 *   node scripts/smoke.mjs                                  # 打本地 127.0.0.1:8799
 *   node scripts/smoke.mjs https://llm.yexiangha.top 密码    # 打线上（带后台密码时测 CRUD）
 */

const base = (process.argv[2] || 'http://127.0.0.1:8799').replace(/\/+$/, '');
const adminToken = process.argv[3] || '';

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function chat(payload, init = {}) {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
    body: JSON.stringify(payload),
  });
  return { res, json: res.headers.get('content-type')?.includes('json') ? await res.json() : null };
}

console.log(`\n\x1b[36m== 冒烟目标: ${base} ==\x1b[0m`);

/* 1. 健康检查 */
{
  const h = await (await fetch(`${base}/health`)).json();
  check('GET /health ok', h.ok === true, JSON.stringify(h));
  check('健康检查带版本号', typeof h.version === 'string' && h.version.length > 0, h.version);
}

/* 2. 模型列表 */
{
  const m = await (await fetch(`${base}/v1/models`)).json();
  check('GET /v1/models object=list', m.object === 'list');
  check('模型列表非空', Array.isArray(m.data) && m.data.length > 0, String(m.data?.length));
}

/* 3. 非流式补全 */
let firstContent = '';
{
  const { res, json } = await chat(
    { model: 'fake-gpt-4o', messages: [{ role: 'user', content: '你好呀，我是冒烟测试' }] },
    { headers: { authorization: 'Bearer sk-smoke-test' } },
  );
  check('POST /v1/chat/completions 200', res.status === 200, String(res.status));
  check('object=chat.completion', json.object === 'chat.completion', json.object);
  check('choices[0].message.role=assistant', json.choices?.[0]?.message?.role === 'assistant');
  check('message.content 非空', Boolean(json.choices?.[0]?.message?.content));
  check('usage.total_tokens > 0', json.usage?.total_tokens > 0, String(json.usage?.total_tokens));
  check('回显请求的 model', json.model === 'fake-gpt-4o', json.model);
  check('响应头 x-fake-llm=true', res.headers.get('x-fake-llm') === 'true');
  check('响应头带命中规则', Boolean(res.headers.get('x-fake-rule')));
  firstContent = json.choices?.[0]?.message?.content || '';
  check('占位符已替换为真实用户消息', firstContent.includes('你好呀，我是冒烟测试') || json._fake === true);
  console.log(`\x1b[90m        返回: ${firstContent.replace(/\n/g, ' / ').slice(0, 160)}\x1b[0m`);
}

/* 4. 流式 SSE */
{
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'fake-gpt-4o', stream: true, messages: [{ role: 'user', content: '流式测试' }] }),
  });
  check('stream 返回 text/event-stream', (res.headers.get('content-type') || '').includes('text/event-stream'), res.headers.get('content-type'));
  const text = await res.text();
  const frames = text.split('\n\n').filter(Boolean);
  check('SSE 含 chat.completion.chunk', text.includes('chat.completion.chunk'));
  check('SSE 含 role 首帧', text.includes('"role":"assistant"'));
  check('SSE 含 finish_reason', text.includes('"finish_reason":"stop"'));
  check('SSE 以 [DONE] 结尾', text.trim().endsWith('data: [DONE]'));
  check('SSE 分成了多帧（真有流式感）', frames.length >= 3, `${frames.length} 帧`);
  const streamed = frames
    .map((f) => f.replace(/^data: /, ''))
    .filter((d) => d !== '[DONE]')
    .map((d) => { try { return JSON.parse(d).choices?.[0]?.delta?.content || ''; } catch { return ''; } })
    .join('');
  check('SSE 拼回的文本与规则一致（非空）', streamed.length > 0, `${streamed.length} 字`);
}

/* 5. echo 回显 + key 脱敏 */
{
  const e = await (await fetch(`${base}/v1/echo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer sk-should-not-leak-123456' },
    body: JSON.stringify({ hello: 'world' }),
  })).json();
  check('echo 回显请求体', e.request?.body?.hello === 'world');
  check('echo 里的 authorization 已脱敏', !JSON.stringify(e).includes('should-not-leak'));
  check('echo 带上服务信息', typeof e.service?.rules === 'number');
}

/* 6. 兜底：任意路径也响应 */
{
  const res = await fetch(`${base}/anything/at/all?model=fake-x`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: '兜底测试' }] }),
  });
  const c = await res.json();
  check('未实现路径也返回自定义内容', Boolean(c.content), JSON.stringify(c).slice(0, 120));
  check('兜底响应带 path', c.path === '/anything/at/all', c.path);
  const html = await fetch(`${base}/some/page`, { headers: { accept: 'text/html' } });
  check('浏览器访问未知路径返回 HTML', (html.headers.get('content-type') || '').includes('text/html'));
}

/* 7. 首页 / 后台页面 */
{
  const home = await (await fetch(`${base}/`)).text();
  check('首页 200 且有标题', home.includes('<title>'));
  check('首页占位符全部替换', !/\{\{(SERVICE_NAME|RULE_COUNT|HOST|VERSION|DEFAULT_MODEL)\}\}/.test(home));
  const admin = await (await fetch(`${base}/admin`)).text();
  check('后台页面渲染', admin.includes('管理后台'));
  check('后台占位符全部替换', !/\{\{(SERVICE_NAME|MODE|DYNAMIC_TOKEN)\}\}/.test(admin));
}

/* 8. 后台鉴权与 CRUD */
if (adminToken) {
  const H = { 'content-type': 'application/json', 'x-admin-token': adminToken };
  const list = await (await fetch(`${base}/admin/api/rules`, { headers: H })).json();
  check('后台可读取规则', list.ok === true, list.error);

  const wrong = await fetch(`${base}/admin/api/rules`, { headers: { 'x-admin-token': 'definitely-wrong' } });
  check('错误令牌被拒 401', wrong.status === 401, String(wrong.status));

  const created = await (await fetch(`${base}/admin/api/rules`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ name: '冒烟规则', id: 'smoke-test', match: { regex: '^冒烟专用' }, content: '冒烟命中：{{user}} · {{rand}}', priority: 99 }),
  })).json();
  check('创建规则成功', created.ok === true, created.error);

  // KV 是最终一致的：写入后最多 60 秒才全球可见。这里做成"反复探测直到生效"，
  // 只要在容忍窗口内生效就算通过（本地 wrangler dev 通常 11 秒内即可）。
  const waitMs = Number(process.env.PROPAGATION_WAIT_MS || 80_000);
  const deadline = Date.now() + waitMs;
  let hitText = '';
  let hitRule = '';
  let waited = 0;
  for (;;) {
    await sleep(11_000);
    waited += 11_000;
    const { res, json: hit } = await chat({ model: 'fake-gpt-4o', messages: [{ role: 'user', content: '冒烟专用测试内容' }] });
    hitText = hit.choices?.[0]?.message?.content || '';
    hitRule = decodeURIComponent(res.headers.get('x-fake-rule') || '');
    if (hitText.includes('冒烟命中')) break;
    if (Date.now() >= deadline) break;
  }
  check(`新规则在 ${Math.round(waited / 1000)} 秒内生效（KV 最终一致）`, hitText.includes('冒烟命中'), `命中规则=${hitRule} 内容=${hitText.slice(0, 60)}`);
  check('新规则里的占位符已替换', hitText.includes('冒烟专用测试内容'));

  const badRegex = await fetch(`${base}/admin/api/rules`, { method: 'POST', headers: H, body: JSON.stringify({ id: 'bad-re', match: { regex: '([' }, content: 'x' }) });
  check('非法正则被拒 400', badRegex.status === 400, String(badRegex.status));

  const del = await (await fetch(`${base}/admin/api/rules/smoke-test`, { method: 'DELETE', headers: H })).json();
  check('删除规则成功', del.ok === true);
  await fetch(`${base}/admin/api/rules/bad-re`, { method: 'DELETE', headers: H });

  const t = await (await fetch(`${base}/admin/api/test`, { method: 'POST', headers: H, body: JSON.stringify({ message: '后台试跑' }) })).json();
  check('后台试跑接口可用', t.ok === true && typeof t.content === 'string');
} else {
  console.log('  \x1b[33mSKIP\x1b[0m  后台 CRUD（未提供后台密码参数）');
}

console.log(`\n== 通过 ${pass} 项，失败 ${fail} 项 ==`);
if (fail > 0) {
  console.log('失败项：\n - ' + failures.join('\n - '));
  process.exit(1);
}
