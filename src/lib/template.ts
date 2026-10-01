/**
 * 占位符模板引擎。
 *
 * 规则里写的响应内容支持 {{var}} 占位符，运行时替换成真实请求里的信息，
 * 这样"假回复"也能带上用户刚才说的话、模型名、时间等，看起来更像真的。
 * 未知占位符原样保留（不报错），方便用户自己写文档性的 {{xxx}}。
 */

export interface TemplateVars {
  /** 最后一条 user 消息的内容 */
  user: string;
  /** 全部消息拼接后的纯文本（role: content 换行连接） */
  messages: string;
  /** 请求里的模型名 */
  model: string;
  /** 本次请求 id（chatcmpl-xxx） */
  id: string;
  /** 请求时间 ISO 串 */
  time: string;
  /** 随机串，4 位 */
  rand: string;
  /** 用户消息 sha256 的前 8 位（稳定指纹，方便对照） */
  hash: string;
  /** 原始路径，如 /v1/chat/completions */
  path: string;
  /** 请求方法，如 POST */
  method: string;
  /** 从 Authorization 头里取到的 key（可能是空串） */
  key: string;
  /** 用户消息字符数 */
  len: string;
  /** 用户消息词数（英文按空格，中文按字数粗算） */
  words: string;
}

/** 生成 4 位随机串（去掉容易混淆的 0/O/1/I） */
export function randomTag(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

/** 用户消息的稳定指纹 */
export async function shortHash(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)]
    .slice(0, 4)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function renderTemplate(tpl: string, vars: TemplateVars): string {
  return tpl.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (whole, name: string) => {
    const value = (vars as unknown as Record<string, string>)[name];
    return typeof value === 'string' ? value : whole;
  });
}

/** 全部消息 → 纯文本，用于 {{messages}} 和关键词匹配 */
export function messagesToText(messages: Array<{ role?: unknown; content?: unknown }>): string {
  return messages
    .map((m) => {
      const role = typeof m.role === 'string' ? m.role : 'unknown';
      const content =
        typeof m.content === 'string'
          ? m.content
          : m.content === undefined || m.content === null
            ? ''
            : JSON.stringify(m.content);
      return `${role}: ${content}`;
    })
    .join('\n');
}

/** 取最后一条 user 消息的文本内容 */
export function lastUserMessage(messages: Array<{ role?: unknown; content?: unknown }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'user') {
      if (typeof m.content === 'string') return m.content;
      if (m.content !== undefined && m.content !== null) return JSON.stringify(m.content);
      return '';
    }
  }
  return '';
}

/** 粗算词数：CJK 按字，其他按空格切分 */
export function roughWords(text: string): string {
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
  const latin = text
    .replace(/[\u3400-\u9fff\uf900-\ufaff]/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length;
  return String(cjk + latin);
}
