/**
 * Cloudflare Turnstile 人机认证（保护管理后台 /admin 与 /admin/api/*）
 *
 * 登录顺序（先密码、后人机验证）：
 *   1. 打开 /admin → 只显示「后台密码」输入框
 *   2. 提交密码 → POST /admin/api/login
 *        密码错 → 401（不消耗任何验证配额）
 *        密码对 → 200 + 一张 5 分钟有效的签名 pending 票据，前端此时才渲染人机验证挂件
 *   3. 用户在挂件上过验证 → POST /admin/api/verify-human（带 pending 票据 + Turnstile token）
 *        服务端调 Cloudflare siteverify 校验（必须服务端校验，前端结果不可信）
 *        通过 → 下发 HttpOnly + Secure + SameSite 的签名会话 Cookie（HMAC-SHA256，默认 12 小时）
 *   4. 之后的 /admin/api/* 要同时满足：会话 Cookie 有效 + 后台密码正确
 *
 * 这样机器人连验证挂件都看不到（它得先知道密码），
 * 而 Turnstile 的验证配额只花在密码正确的请求上。
 */

const COOKIE_NAME = 'llm_fake_gate';
const DEFAULT_TTL_SECONDS = 12 * 60 * 60;

export interface GateEnv {
  ADMIN_PASSWORD?: string;
  TURNSTILE_SITE_KEY?: string;
  /** 仅本地测试用：把 siteverify 指到自建假端（线上不要设） */
  TURNSTILE_VERIFY_URL?: string;
}

export interface GateConfig {
  siteKey: string;
  secretKey: string;
  enabled: boolean;
}

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** 从环境变量读取配置；两个 key 都有才算开启 */
export function gateConfig(env: GateEnv & { TURNSTILE_SECRET_KEY?: string }): GateConfig {
  const siteKey = (env.TURNSTILE_SITE_KEY || '').trim();
  const secretKey = (env.TURNSTILE_SECRET_KEY || '').trim();
  return { siteKey, secretKey, enabled: Boolean(siteKey && secretKey) };
}

/* ------------------------------ 签名 Cookie ------------------------------ */

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sign(payload: string, key: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(payload));
  return b64url(new Uint8Array(mac));
}

/** 恒定时间比较，避免时序侧信道 */
function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 生成通过验证的会话 Cookie（值为 过期时间戳.签名） */
export async function issueGateCookie(env: GateEnv, ttlSeconds = DEFAULT_TTL_SECONDS): Promise<string> {
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = String(expires);
  const mac = await sign(payload, `${env.ADMIN_PASSWORD || 'no-password-configured'}|gate`);
  const value = `${payload}.${mac}`;
  return `${COOKIE_NAME}=${value}; Path=/; Max-Age=${ttlSeconds}; HttpOnly; Secure; SameSite=Lax`;
}

export function readGateCookie(req: Request): string {
  const cookie = req.headers.get('cookie') || '';
  const m = new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]*)`).exec(cookie);
  return m ? decodeURIComponent(m[1]) : '';
}

/** 校验会话 Cookie：签名对得上且没过期 */
export async function gateCookieValid(req: Request, env: GateEnv): Promise<boolean> {
  const value = readGateCookie(req);
  if (!value) return false;
  const [payload, mac] = value.split('.');
  if (!payload || !mac) return false;
  const expected = await sign(payload, `${env.ADMIN_PASSWORD || 'no-password-configured'}|gate`);
  if (!timingSafeEqualStr(mac, expected)) return false;
  const expires = Number(payload);
  return Number.isFinite(expires) && expires * 1000 > Date.now();
}

/* ------------------------------ 服务端校验 ------------------------------ */

export interface VerifyResult {
  success: boolean
  codes: string[];
  raw: Record<string, unknown> | null;
  error?: string;
}

/**
 * 调 Cloudflare siteverify 校验前端 token。
 * 注意三点：必须服务端调用；必须带 remoteip；token 是一次性的，重复提交必然失败。
 */
export async function verifyTurnstile(
  env: GateEnv & { TURNSTILE_SECRET_KEY?: string },
  token: string,
  remoteIp?: string | null,
): Promise<VerifyResult> {
  const { secretKey } = gateConfig(env);
  if (!secretKey) return { success: false, codes: [], raw: null, error: '服务端未配置 TURNSTILE_SECRET_KEY' };
  if (!token) return { success: false, codes: [], raw: null, error: '缺少人机验证 token' };

  // 按 Cloudflare 官方文档用 application/x-www-form-urlencoded 提交
  const body = new URLSearchParams();
  body.append('secret', secretKey);
  body.append('response', token);
  if (remoteIp) body.append('remoteip', remoteIp);

  const url = (env.TURNSTILE_VERIFY_URL || '').trim() || VERIFY_URL;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const text = await res.text();
    let json: Record<string, unknown> | null = null;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return { success: false, codes: [], raw: null, error: `siteverify 返回非 JSON：${text.slice(0, 120)}` };
    }
    const codes = Array.isArray(json['error-codes']) ? (json['error-codes'] as string[]) : [];
    return { success: json.success === true, codes, raw: json };
  } catch (e) {
    return { success: false, codes: [], raw: null, error: `调用 siteverify 失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

/** 把 Turnstile 的错误码翻译成人话，方便排查 */
export function explainCodes(codes: string[]): string {
  const map: Record<string, string> = {
    'missing-input-secret': '服务端缺少 secret key',
    'invalid-input-secret': 'secret key 不正确',
    'missing-input-response': '前端没有传 token',
    'invalid-input-response': 'token 无效或已过期',
    'timeout-or-duplicate': 'token 已超时或被重复使用（每次提交都要新 token）',
    'bad-request': '请求格式错误',
    'internal-error': 'Cloudflare 内部错误，请重试',
    'sitekey-secret-mismatch': 'sitekey 与 secret key 不是同一个 widget',
  };
  return codes.map((c) => map[c] || c).join('；') || '验证未通过';
}

export { COOKIE_NAME as GATE_COOKIE_NAME, DEFAULT_TTL_SECONDS as GATE_TTL_SECONDS };

/* --------------------------- 密码已过、待验证的票据 --------------------------- */

/** 密码校验通过后签发的短期票据有效期（秒） */
export const PENDING_TTL_SECONDS = 5 * 60;

/**
 * 签发「密码已通过、等待人机验证」的票据。
 * 用它把"密码已验证"这个事实传递到下一步，避免前端在内存里留着密码明文。
 */
export async function issuePendingTicket(env: GateEnv, ttlSeconds = PENDING_TTL_SECONDS): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(8)));
  const payload = `${exp}.${nonce}`;
  const mac = await sign(payload, `${env.ADMIN_PASSWORD || 'no-password-configured'}|pending`);
  return `${payload}.${mac}`;
}

/** 校验 pending 票据：签名对、未过期 */
export async function verifyPendingTicket(ticket: string, env: GateEnv): Promise<boolean> {
  if (!ticket) return false;
  const parts = ticket.split('.');
  if (parts.length !== 3) return false;
  const [exp, nonce, mac] = parts;
  const expected = await sign(`${exp}.${nonce}`, `${env.ADMIN_PASSWORD || 'no-password-configured'}|pending`);
  if (!timingSafeEqualStr(mac, expected)) return false;
  const expires = Number(exp);
  return Number.isFinite(expires) && expires * 1000 > Date.now();
}
