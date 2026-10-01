/**
 * LLM API 服务提供商（假装版）
 *
 *   GET  /v1/models             模型列表
 *   POST /v1/chat/completions   OpenAI 兼容补全（支持 stream:true）
 *   ANY  /v1/echo               回显请求详情，看清客户端到底发了什么
 *   GET  /health                健康检查
 *   GET  /admin                 管理后台（自定义响应规则）
 *   ANY  /*                     兜底：一切未匹配的请求也用自定义内容响应
 *
 * 所有回复内容 100% 来自 Cloudflare KV 里用户自己写的规则，不调用任何真实大模型。
 */

import ADMIN_HTML from '../public/admin.html';
import HOME_HTML from '../public/home.html';
import { DEFAULT_FINISH_REASON, pickRule, type Rule } from './lib/match';
import { JSON_HEADERS, buildCompletion, buildModelList, buildStream, errorBody, newCompletionId } from './lib/openai';
import {
  FALLBACK_RULE,
  deleteRule,
  getRule,
  loadRules,
  loadSettings,
  saveRule,
  saveSettings,
  seedIfEmpty,
  type Settings,
} from './lib/store';
import {
  lastUserMessage,
  messagesToText,
  randomTag,
  renderTemplate,
  roughWords,
  shortHash,
  type TemplateVars,
} from './lib/template';
import { explainCodes, gateConfig, gateCookieValid, gateTtlSeconds, issueGateCookie, verifyTurnstile } from './lib/turnstile';

export interface Env {
  LLM_FAKE_KV: KVNamespace;
  /** 后台密码；未设置时自动生成并存到 KV（首次访问 /admin 可领取） */
  ADMIN_PASSWORD?: string;
  SERVICE_NAME?: string;
  SERVICE_VERSION?: string;
  /** Cloudflare Turnstile：两个都配置后才开启人机认证 */
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  /** 仅本地测试用：把 siteverify 指到自建假端 */
  TURNSTILE_VERIFY_URL?: string;
}

const VERSION = '1.0.0';
const TOKEN_KEY = 'config:admin-token';
const TOKEN_ISSUED_KEY = 'config:admin-token-issued';

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'access-control-allow-headers': '*',
  'access-control-max-age': '86400',
};

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { ...CORS, ...JSON_HEADERS, ...extra } });
}

function html(body: string, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { ...CORS, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

/** 校验假 API Key。默认关闭；开启后要求 Authorization: Bearer sk-xxx 或 x-api-key */
function checkApiKey(req: Request, settings: Settings): { ok: boolean; key: string } {
  const auth = req.headers.get('authorization') || '';
  const key = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : (req.headers.get('x-api-key') || '').trim();
  if (!settings.requireApiKey) return { ok: true, key };
  const prefix = settings.fakeKeyPrefix || 'sk-';
  return { ok: key.length > prefix.length && key.startsWith(prefix), key };
}

/** 组装模板变量，供规则内容里的 {{占位符}} 使用 */
async function buildVars(
  req: Request,
  opts: { messages: Array<{ role?: unknown; content?: unknown }>; model: string; key: string; id: string; url: URL },
): Promise<TemplateVars> {
  const user = lastUserMessage(opts.messages);
  const all = messagesToText(opts.messages);
  return {
    user,
    messages: all,
    model: opts.model,
    id: opts.id,
    time: new Date().toISOString(),
    rand: randomTag(),
    hash: await shortHash(user || all),
    path: opts.url.pathname,
    method: req.method,
    key: opts.key,
    len: String(user.length),
    words: roughWords(user),
  };
}

interface Resolved {
  rule: Rule;
  model: string;
  finishReason: string;
  content: string;
  delayMs: number;
}

function resolveRule(rules: Rule[], settings: Settings, ctx: { model: string; text: string; vars: TemplateVars }): Resolved {
  // 正则只对"用户最后一句"生效，^...$ 锚点才符合直觉；关键词仍匹配整段对话
  const rule = pickRule(rules, { model: ctx.model, text: ctx.text, regexText: ctx.vars.user || ctx.text }) ?? FALLBACK_RULE;
  return {
    rule,
    model: rule.model?.trim() || ctx.model || settings.defaultModel,
    finishReason: rule.finishReason?.trim() || DEFAULT_FINISH_REASON,
    content: renderTemplate(rule.content || '', ctx.vars),
    delayMs: rule.delayMs && rule.delayMs > 0 ? rule.delayMs : settings.defaultDelayMs,
  };
}

/* ----------------------------- OpenAI 兼容层 ----------------------------- */

async function handleModels(env: Env): Promise<Response> {
  const [rules, settings] = await Promise.all([loadRules(env.LLM_FAKE_KV), loadSettings(env.LLM_FAKE_KV)]);
  const ids = new Set<string>([settings.defaultModel]);
  for (const rule of rules) {
    if (rule.model?.trim()) ids.add(rule.model.trim());
    const m = rule.match?.model?.trim();
    if (m && !m.includes('*') && !m.includes('?') && !m.startsWith('/')) ids.add(m);
  }
  for (const m of ['fake-gpt-4o', 'fake-gpt-4o-mini', 'fake-claude-3-5-sonnet', 'fake-deepseek-chat']) ids.add(m);
  return json(buildModelList([...ids], settings.serviceName));
}

async function handleChatCompletions(req: Request, env: Env, url: URL): Promise<Response> {
  const settings = await loadSettings(env.LLM_FAKE_KV);
  const { ok, key } = checkApiKey(req, settings);
  if (!ok) {
    return json(
      errorBody(
        `Incorrect API key provided. 本服务是假 LLM：任意以 "${settings.fakeKeyPrefix}" 开头的字符串都能通过（当前后台开启了 key 校验）。`,
        'invalid_request_error',
        'invalid_api_key',
      ),
      401,
    );
  }

  const rawText = await req.text();
  let body: Record<string, unknown> = {};
  if (rawText.trim()) {
    try {
      const parsed: unknown = JSON.parse(rawText);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return json(errorBody('请求体必须是 JSON 对象。', 'invalid_request_error', 'invalid_body'), 400);
      }
      body = parsed as Record<string, unknown>;
    } catch {
      return json(
        errorBody(`请求体不是合法 JSON。原始前 200 字符：${rawText.slice(0, 200)}`, 'invalid_request_error', 'invalid_json'),
        400,
      );
    }
  }

  const messages = Array.isArray(body.messages) ? (body.messages as Array<{ role?: unknown; content?: unknown }>) : [];
  const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : settings.defaultModel;
  const wantStream = body.stream === true;
  const id = newCompletionId();
  const vars = await buildVars(req, { messages, model, key, id, url });
  const rules = await loadRules(env.LLM_FAKE_KV);
  const resolved = resolveRule(rules, settings, { model, text: vars.messages, vars });

  if (resolved.delayMs > 0) await sleep(resolved.delayMs);

  const extra = {
    'x-fake-llm': 'true',
    'x-fake-rule': encodeURIComponent(resolved.rule.id),
    'x-fake-model': resolved.model,
  };

  if (wantStream) {
    const perChunk = Math.max(0, Math.round((resolved.delayMs || 18 * Math.ceil(resolved.content.length / 12)) / Math.max(1, Math.ceil(resolved.content.length / 12))));
    const stream = buildStream({
      id,
      model: resolved.model,
      content: resolved.content,
      finishReason: resolved.finishReason,
      promptText: vars.messages,
      intervalMs: perChunk,
    });
    return new Response(stream, {
      headers: {
        ...CORS,
        ...extra,
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        'x-accel-buffering': 'no',
      },
    });
  }

  return json(
    buildCompletion({
      id,
      model: resolved.model,
      content: resolved.content,
      finishReason: resolved.finishReason,
      promptText: vars.messages,
    }),
    200,
    extra,
  );
}

/** 回显请求，方便调试"到底谁发了什么" */
async function handleEcho(req: Request, env: Env, url: URL): Promise<Response> {
  const raw = await req.text();
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    headers[k] = k.toLowerCase() === 'authorization' ? `${v.slice(0, 8)}…(已截断)` : v;
  });
  let parsed: unknown = raw;
  try {
    parsed = raw.trim() ? JSON.parse(raw) : null;
  } catch {
    /* 保持原始文本 */
  }
  const [rules, settings] = await Promise.all([loadRules(env.LLM_FAKE_KV), loadSettings(env.LLM_FAKE_KV)]);
  return json({
    ok: true,
    message: '这是 /v1/echo 回显。本服务对任何路径都会用自定义内容响应。',
    request: {
      method: req.method,
      url: req.url,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers,
      body: parsed,
    },
    service: { name: settings.serviceName, version: env.SERVICE_VERSION || VERSION, rules: rules.length },
  });
}

/** 兜底：任何其它路径/方法都按同一套规则库响应，保证"一切请求都响应" */
async function handleCatchAll(req: Request, env: Env, url: URL): Promise<Response> {
  const settings = await loadSettings(env.LLM_FAKE_KV);
  const { key } = checkApiKey(req, settings);
  const raw = await req.text();

  let parsed: unknown = null;
  let messages: Array<{ role?: unknown; content?: unknown }> = [];
  try {
    if (raw.trim()) {
      parsed = JSON.parse(raw);
      const candidate = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).messages : null;
      if (Array.isArray(candidate)) messages = candidate as Array<{ role?: unknown; content?: unknown }>;
    }
  } catch {
    /* 非 JSON 也无所谓，原始文本会进 {{user}} */
  }
  if (messages.length === 0 && raw.trim()) messages = [{ role: 'user', content: raw }];

  const bodyModel =
    parsed && typeof parsed === 'object' && typeof (parsed as Record<string, unknown>).model === 'string'
      ? String((parsed as Record<string, unknown>).model)
      : '';
  const model = bodyModel || url.searchParams.get('model') || settings.defaultModel;

  const id = newCompletionId();
  const vars = await buildVars(req, { messages, model, key, id, url });
  const rules = await loadRules(env.LLM_FAKE_KV);
  const resolved = resolveRule(rules, settings, { model, text: vars.messages || raw, vars });
  if (resolved.delayMs > 0) await sleep(resolved.delayMs);

  const wantsHtml = (req.headers.get('accept') || '').includes('text/html');
  if (wantsHtml) {
    return html(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<title>${escapeHtml(url.pathname)} · 假 LLM</title>` +
        `<body style="font:16px/1.7 system-ui;-webkit-font-smoothing:antialiased;max-width:44rem;margin:12vh auto;padding:0 1.25rem;color:#111">` +
        `<p style="font:600 12px/1 ui-monospace,monospace;letter-spacing:.14em;color:#888">FAKE LLM API · 一切请求都响应</p>` +
        `<h1 style="font-size:1.35rem;margin:.6rem 0 1rem">路径 <code>${escapeHtml(url.pathname)}</code> 没有专门实现</h1>` +
        `<p style="color:#555">按"一切请求都响应"的设计，这里返回你在后台自定义的内容：</p>` +
        `<pre style="white-space:pre-wrap;background:#f6f6f6;border:1px solid #e5e5e5;padding:1rem;border-radius:10px;font:14px/1.6 ui-monospace,monospace">${escapeHtml(resolved.content)}</pre>` +
        `<p style="color:#888;font-size:13px">命中规则：${escapeHtml(resolved.rule.name)} · <a href="/admin">管理后台</a> · <a href="/">首页</a></p>`,
    );
  }

  return json(
    {
      object: 'fake_llm.response',
      id,
      created: Math.floor(Date.now() / 1000),
      model: resolved.model,
      path: url.pathname,
      method: req.method,
      matched_rule: { id: resolved.rule.id, name: resolved.rule.name },
      content: resolved.content,
      note: '未实现的标准接口路径，返回规则库中的自定义内容（设计如此：一切请求都响应）',
    },
    200,
    { 'x-fake-llm': 'true', 'x-fake-rule': encodeURIComponent(resolved.rule.id) },
  );
}

/* ------------------------------- 鉴权 ------------------------------- */

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function tokenFromRequest(req: Request): string[] {
  const cookie = req.headers.get('cookie') || '';
  const cookieToken = /(?:^|;\s*)llm_fake_admin=([^;]*)/.exec(cookie)?.[1] ?? '';
  const header = req.headers.get('x-admin-token') || req.headers.get('x-admin-password') || '';
  const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  return [header, cookieToken ? decodeURIComponent(cookieToken) : '', bearer].filter(Boolean);
}

/** 返回本次请求是否通过鉴权，以及（未配置密码时）动态令牌是否刚生成 */
async function adminAuth(req: Request, env: Env): Promise<{ ok: boolean; dynamic: boolean; justCreated: boolean }> {
  const provided = tokenFromRequest(req);

  if (env.ADMIN_PASSWORD) {
    return { ok: provided.some((t) => timingSafeEqual(t, env.ADMIN_PASSWORD as string)), dynamic: false, justCreated: false };
  }

  // 没设置 secret：自动生成一次性令牌存进 KV，并在页面上提示（首次启动友好，但安全性弱于 secret）
  let token = await env.LLM_FAKE_KV.get(TOKEN_KEY);
  let justCreated = false;
  if (!token) {
    token = randomTag() + randomTag() + '-' + randomTag() + randomTag() + randomTag();
    await env.LLM_FAKE_KV.put(TOKEN_KEY, token);
    await env.LLM_FAKE_KV.put(TOKEN_ISSUED_KEY, new Date().toISOString());
    justCreated = true;
  }
  return { ok: provided.some((t) => timingSafeEqual(t, token as string)), dynamic: true, justCreated };
}

/* ------------------------------- 路由 ------------------------------- */

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method.toUpperCase();

    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    try {
      if (path === '/' && method === 'GET') {
        const [rules, settings] = await Promise.all([loadRules(env.LLM_FAKE_KV), loadSettings(env.LLM_FAKE_KV)]);
        const page = HOME_HTML.replace(/\{\{SERVICE_NAME\}\}/g, escapeHtml(settings.serviceName))
          .replace(/\{\{DEFAULT_MODEL\}\}/g, escapeHtml(settings.defaultModel))
          .replace(/\{\{RULE_COUNT\}\}/g, String(rules.length))
          .replace(/\{\{HOST\}\}/g, escapeHtml(url.host))
          .replace(/\{\{VERSION\}\}/g, escapeHtml(env.SERVICE_VERSION || VERSION));
        return html(page);
      }

      if (path === '/health' || path === '/v1/health') {
        const rules = await loadRules(env.LLM_FAKE_KV);
        return json({
          ok: true,
          service: env.SERVICE_NAME || 'llm-api-fake',
          version: env.SERVICE_VERSION || VERSION,
          rules: rules.length,
          time: new Date().toISOString(),
        });
      }

      if (path === '/v1/models' && (method === 'GET' || method === 'POST')) return handleModels(env);

      if ((path === '/v1/chat/completions' || path === '/chat/completions' || path === '/v1/completions') && method === 'POST') {
        return handleChatCompletions(req, env, url);
      }

      if (path === '/v1/echo' || path === '/echo') return handleEcho(req, env, url);

      if (path === '/admin' || path.startsWith('/admin/')) return handleAdmin(req, env, url, path, method);

      return handleCatchAll(req, env, url);
    } catch (err) {
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      return json(errorBody(`假 LLM 服务内部错误：${message}`, 'internal_error', 'internal_error'), 500);
    }
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(seedIfEmpty(env.LLM_FAKE_KV).then(() => undefined));
  },
} satisfies ExportedHandler<Env>;

/* ---------------------------- 管理后台 ---------------------------- */

async function adminPage(env: Env, req: Request, url: URL): Promise<Response> {
  const gate = gateConfig(env);
  const humanVerified = !gate.enabled || (await gateCookieValid(req, env));
  const auth = await adminAuth(req, env);
  const dynamicToken = auth.dynamic && auth.ok ? await env.LLM_FAKE_KV.get(TOKEN_KEY) : null;
  const config = {
    gateEnabled: gate.enabled,
    humanVerified,
    siteKey: gate.siteKey,
    gateTtlMinutes: Math.round((gateTtlSeconds(env) / 60) * 10) / 10,
    mode: env.ADMIN_PASSWORD ? 'secret' : 'dynamic',
    dynamicToken: dynamicToken || '',
    message: (url.searchParams.get('msg') || '').slice(0, 200),
    error: (url.searchParams.get('err') || '').slice(0, 200),
  };
  const page = ADMIN_HTML.replace(/\{\{SERVICE_NAME\}\}/g, escapeHtml(env.SERVICE_NAME || 'llm-api-fake')).replace(
    /\{\{CONFIG_JSON\}\}/g,
    JSON.stringify(config).replace(/</g, '\\u003c'),
  );
  return html(page, 200, { 'x-robots-tag': 'noindex' });
}

/**
 * 密码校验：不用合成 Request，直接比较。
 * - 配置了 ADMIN_PASSWORD：与 secret 比对
 * - 没配置：退回 KV 里自动生成的一次性令牌
 */
async function passwordMatches(provided: string, env: Env): Promise<boolean> {
  if (!provided) return false;
  if (env.ADMIN_PASSWORD) return timingSafeEqual(provided, env.ADMIN_PASSWORD);
  const token = await env.LLM_FAKE_KV.get(TOKEN_KEY);
  if (!token) return false;
  return timingSafeEqual(provided, token);
}

/**
 * 第二步：校验后台密码。
 * 注意：这一步在「人机验证会话」之后，由 handleAdmin 的路由顺序保证——
 * 没过人机验证的请求根本走不到这里。
 */
async function handleLogin(req: Request, env: Env): Promise<Response> {
  let payload: { password?: string } = {};
  try {
    payload = (await req.json()) as { password?: string };
  } catch {
    const form = await req.formData().catch(() => null);
    payload = { password: String(form?.get('password') || '') };
  }
  const provided = (payload.password || '').trim();

  if (!(await passwordMatches(provided, env))) {
    return json({ ok: false, error: '密码不正确', code: 'bad_password' }, 401);
  }
  return json({ ok: true, message: '密码正确', gateTtlSeconds: gateTtlSeconds(env) });
}

/** 第一步：校验 Turnstile token，通过后下发短期会话 Cookie */
async function handleVerifyHuman(req: Request, env: Env): Promise<Response> {
  const gate = gateConfig(env);
  if (!gate.enabled) return json({ ok: true, humanRequired: false, message: '本实例未开启人机认证' });

  let token = '';
  const contentType = req.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const body = (await req.json().catch(() => ({}))) as { token?: string };
    token = String(body.token || '');
  } else {
    const form = await req.formData().catch(() => null);
    token = String(form?.get('cf-turnstile-response') || req.headers.get('cf-turnstile-response') || '');
  }

  const result = await verifyTurnstile(env, token, req.headers.get('cf-connecting-ip'));
  if (!result.success) {
    const reason = result.error || explainCodes(result.codes);
    console.log(`[turnstile] 验证失败: ${reason} codes=${JSON.stringify(result.codes)}`);
    return json({ ok: false, error: `人机验证未通过：${reason}`, code: 'human_failed', codes: result.codes }, 400);
  }

  return json(
    { ok: true, message: '人机验证通过，请输入后台密码', gateTtlSeconds: gateTtlSeconds(env) },
    200,
    { 'set-cookie': await issueGateCookie(env) },
  );
}

async function handleAdmin(req: Request, env: Env, url: URL, path: string, method: string): Promise<Response> {
  if (!path.startsWith('/admin/api')) return adminPage(env, req, url);

  const route = path.slice('/admin/api'.length).replace(/^\/+/, '');
  const gate = gateConfig(env);

  // 第一步（人机认证）本身不能要求"已经通过验证"
  if (route === 'verify-human') {
    if (method !== 'POST') return json({ ok: false, error: '请用 POST 提交' }, 405);
    return handleVerifyHuman(req, env);
  }

  // 第一道门：人机验证会话（Turnstile 配置了才开）
  // 放在最前面，保证没过验证时连"密码对不对"都探测不到
  if (gate.enabled && !(await gateCookieValid(req, env))) {
    return json(
      {
        ok: false,
        error: '需要先通过人机验证',
        code: 'human_verification_required',
        hint: '打开 /admin 完成 Cloudflare 人机验证（每次进入都要验，验证会话仅 ' + Math.round(gateTtlSeconds(env) / 60) + ' 分钟）',
      },
      403,
    );
  }

  // 第二道门：后台密码
  if (route === 'login') {
    if (method !== 'POST') return json({ ok: false, error: '请用 POST 提交' }, 405);
    return handleLogin(req, env);
  }

  const auth = await adminAuth(req, env);
  if (!auth.ok) {
    return json(
      {
        ok: false,
        error: '密码/令牌不正确',
        hint: auth.dynamic ? '本服务用自动生成的令牌：打开 /admin 页面可看到' : '检查 wrangler secret put ADMIN_PASSWORD 设置的值',
      },
      401,
    );
  }

  if (route === 'session' && method === 'GET') {
    return json({ ok: true, mode: auth.dynamic ? 'dynamic' : 'secret', justCreated: auth.justCreated, gate: gate.enabled });
  }

  if (route === 'rules' || route.startsWith('rules/')) {
    const id = route.startsWith('rules/') ? decodeURIComponent(route.slice('rules/'.length)) : '';

    if (method === 'GET') {
      const [rules, settings] = await Promise.all([
        loadRules(env.LLM_FAKE_KV, url.searchParams.get('fresh') === '1'),
        loadSettings(env.LLM_FAKE_KV),
      ]);
      return json({ ok: true, rules, settings, version: env.SERVICE_VERSION || VERSION });
    }

    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      let payload: Partial<Rule>;
      try {
        payload = (await req.json()) as Partial<Rule>;
      } catch {
        return json({ ok: false, error: 'JSON 解析失败' }, 400);
      }
      if (!id && payload.id) {
        const existing = await getRule(env.LLM_FAKE_KV, payload.id);
        if (existing) return json({ ok: false, error: `规则 id "${payload.id}" 已存在` }, 409);
      }
      const targetId = id || payload.id || `r-${Date.now().toString(36)}-${randomTag().toLowerCase()}`;
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(targetId)) {
        return json({ ok: false, error: '规则 id 只允许字母、数字和 . _ -（1-64 位）' }, 400);
      }
      if (payload.match?.regex) {
        try {
          new RegExp(payload.match.regex);
        } catch (e) {
          return json({ ok: false, error: `正则不合法：${e instanceof Error ? e.message : String(e)}` }, 400);
        }
      }
      const saved = await saveRule(env.LLM_FAKE_KV, {
        id: targetId,
        name: payload.name ?? '未命名规则',
        enabled: payload.enabled !== false,
        isDefault: payload.isDefault === true,
        priority: Number.isFinite(Number(payload.priority)) ? Number(payload.priority) : 0,
        match: {
          model: payload.match?.model?.trim() || undefined,
          keyword: payload.match?.keyword?.trim() || undefined,
          regex: payload.match?.regex?.trim() || undefined,
        },
        content: typeof payload.content === 'string' ? payload.content : '',
        finishReason: payload.finishReason,
        model: payload.model,
        delayMs: Number(payload.delayMs) || 0,
        note: payload.note,
      });
      return json({ ok: true, rule: saved, action: id ? 'updated' : 'created' });
    }

    if (method === 'DELETE') {
      if (!id) return json({ ok: false, error: '缺少规则 id' }, 400);
      await deleteRule(env.LLM_FAKE_KV, id);
      return json({ ok: true, deleted: id });
    }

    return json({ ok: false, error: `不支持的方法 ${method}` }, 405);
  }

  if (route === 'settings') {
    if (method === 'GET') return json({ ok: true, settings: await loadSettings(env.LLM_FAKE_KV, true) });
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      let patch: Partial<Settings>;
      try {
        patch = (await req.json()) as Partial<Settings>;
      } catch {
        return json({ ok: false, error: 'JSON 解析失败' }, 400);
      }
      return json({ ok: true, settings: await saveSettings(env.LLM_FAKE_KV, patch) });
    }
    return json({ ok: false, error: `不支持的方法 ${method}` }, 405);
  }

  if (route === 'seed' && method === 'POST') {
    const result = await seedIfEmpty(env.LLM_FAKE_KV);
    return json({ ok: true, ...result });
  }

  /** 用当前规则试跑一条消息，后台里直接看会返回什么 */
  if (route === 'test' && method === 'POST') {
    let payload: { message?: string; model?: string };
    try {
      payload = (await req.json()) as { message?: string; model?: string };
    } catch {
      return json({ ok: false, error: 'JSON 解析失败' }, 400);
    }
    const settings = await loadSettings(env.LLM_FAKE_KV);
    const message = payload.message ?? '你好';
    const model = payload.model?.trim() || settings.defaultModel;
    const vars = await buildVars(req, {
      messages: [{ role: 'user', content: message }],
      model,
      key: 'sk-admin-test',
      id: newCompletionId(),
      url,
    });
    const rules = await loadRules(env.LLM_FAKE_KV);
    const resolved = resolveRule(rules, settings, { model, text: vars.messages, vars });
    return json({
      ok: true,
      matched: { id: resolved.rule.id, name: resolved.rule.name, isDefault: !!resolved.rule.isDefault },
      model: resolved.model,
      finish_reason: resolved.finishReason,
      delay_ms: resolved.delayMs,
      content: resolved.content,
    });
  }

  return json({ ok: false, error: `未知的后台接口 ${path}` }, 404);
}
