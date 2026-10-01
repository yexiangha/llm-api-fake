/**
 * 规则匹配：决定一次请求该用哪条自定义响应。
 *
 * 匹配维度（rule.match 里随便填哪个，填多个要同时满足）：
 *   match.model   模型名，支持 "gpt-*" 通配和 /正则/
 *   match.keyword 关键词（包含即命中）
 *   match.regex   正则（匹配用户消息全文）
 *   rule.isDefault=true 表示兜底规则
 *
 * 打分排序：正则 50 分、关键词 30 分、模型名 20 分，再按 priority、更新时间排。
 */

export interface RuleMatch {
  model?: string;
  keyword?: string;
  regex?: string;
}

export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  isDefault?: boolean;
  /** 越大越优先 */
  priority?: number;
  match?: RuleMatch;
  content: string;
  finishReason?: string;
  /** 覆盖默认模型名（响应里回显的 model 字段） */
  model?: string;
  /** 模拟思考耗时（毫秒），0/缺省 = 立即返回 */
  delayMs?: number;
  /** 备注 */
  note?: string;
  updatedAt?: string;
}

export interface MatchContext {
  model: string;
  /** 关键词/默认正则的匹配对象（通常是整段对话文本） */
  text: string;
  /** 正则的匹配对象；缺省时用 text。worker 里传"最后一条用户消息"，让 ^...$ 锚点符合直觉 */
  regexText?: string;
}

export const DEFAULT_FINISH_REASON = 'stop';

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

/** 支持 "gpt-4*"(通配) 和 "/^gpt-4/"（正则）两种写法 */
export function modelMatches(pattern: string, model: string): boolean {
  const p = pattern.trim();
  if (!p) return true;
  if (p.startsWith('/') && p.lastIndexOf('/') > 0) {
    const end = p.lastIndexOf('/');
    try {
      return new RegExp(p.slice(1, end), p.slice(end + 1) || 'i').test(model);
    } catch {
      return false;
    }
  }
  if (p.includes('*') || p.includes('?')) return globToRegExp(p).test(model);
  return p.toLowerCase() === model.toLowerCase();
}

export function safeRegExp(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return null;
  }
}

function score(rule: Rule): number {
  if (rule.isDefault) return 0;
  let s = 1;
  if (rule.match?.model) s += 20;
  if (rule.match?.keyword) s += 30;
  if (rule.match?.regex) s += 50;
  return s;
}

/** 返回命中的最高优先规则；没有命中则返回兜底规则（isDefault / 内置默认） */
export function pickRule(rules: Rule[], ctx: MatchContext): Rule | null {
  const hits: Rule[] = [];

  for (const rule of rules) {
    if (rule.enabled === false || rule.isDefault) continue;
    const m = rule.match || {};

    if (m.model && !modelMatches(m.model, ctx.model)) continue;

    if (m.keyword) {
      const needle = m.keyword.trim();
      if (needle && !ctx.text.toLowerCase().includes(needle.toLowerCase())) continue;
    }

    if (m.regex) {
      const re = safeRegExp(m.regex);
      const subject = ctx.regexText ?? ctx.text;
      if (!re || !re.test(subject)) continue;
    }

    hits.push(rule);
  }

  hits.sort((a, b) => {
    const d = score(b) - score(a);
    if (d !== 0) return d;
    const p = (b.priority ?? 0) - (a.priority ?? 0);
    if (p !== 0) return p;
    return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
  });

  if (hits.length > 0) return hits[0];

  const fallback = rules
    .filter((r) => r.enabled !== false && r.isDefault)
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));

  return fallback[0] ?? null;
}
