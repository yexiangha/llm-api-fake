/**
 * Cloudflare Turnstile 人机认证（保护管理后台 /admin 与 /admin/api/*）
 *
 * 设计：
 *   1. 未通过验证 → /admin 只渲染人机验证页，不吐任何后台数据
 *   2. 前端拿到 Turnstile token → POST /admin/api/verify-human
 *   3. 服务端调 Cloudflare siteverify 校验（必须服务端校验，前端结果不可信）
 *   4. 通过后下发 HttpOnly + Secure 的签名 Cookie（HMAC-SHA256，默认 12 小时）
 *   5. 之后每次后台请求校验 Cookie 签名与有效期；再叠加原有的后台密码校验
 *
 * 两层防护是叠加的，不是替代关系：人机认证挡"机器批量访问"，
 * 后台密码挡"知道地址的人类"。
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
  const mac = await sign(payload, env.ADMIN_PASSWORD || 'no-password-configured');
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
  const expected = await sign(payload, env.ADMIN_PASSWORD || 'no-password-configured');
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
