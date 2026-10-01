/**
 * KV 存取层：所有规则/设置都放在一个 KV 命名空间里，用前缀区分。
 *
 *   rule:<id>      单条规则（JSON）—— 用 list(prefix) 枚举，避免大 JSON 并发覆盖
 *   settings       全局设置（JSON）
 *   seed:version   初始化标记
 *
 * KV 读有缓存，所以顺带做一层内存缓存（默认 10 秒），保证同一边缘节点上后台改完规则很快生效。
 *
 * ⚠️ 一致性说明：Cloudflare KV 是「最终一致」的——写入后全球所有节点可见最多需要 60 秒
 * （本节点内存缓存过期 ≠ 别的节点也过期了）。这是 KV 的产品语义，换来的是读取极快、近乎零成本。
 * 如果业务上要求「写完立刻全球可见」，把规则改存 D1 / Durable Object 即可，接口层不用动。
 */

import { DEFAULT_FINISH_REASON, type Rule } from './match';

export interface Settings {
  /** 服务展示名 */
  serviceName: string;
  /** 兜底模型名（请求没带 model 时用它） */
  defaultModel: string;
  /** 是否强制校验 Authorization: Bearer sk-xxx */
  requireApiKey: boolean;
  /** 假 key 前缀，用于校验 */
  fakeKeyPrefix: string;
  /** 默认模拟延迟（毫秒），规则里可单独覆盖 */
  defaultDelayMs: number;
}

export const DEFAULT_SETTINGS: Settings = {
  serviceName: 'llm.yexiangha.top · Fake LLM API',
  defaultModel: 'fake-gpt-4o',
  requireApiKey: false,
  fakeKeyPrefix: 'sk-',
  defaultDelayMs: 0,
};

export const FALLBACK_RULE: Rule = {
  id: 'builtin-default',
  name: '内置兜底回复',
  enabled: true,
  isDefault: true,
  priority: -100,
  match: {},
  content:
    '（这是 llm.yexiangha.top 的默认假回复，KV 里还没有配置任何规则）\n\n你说的是：{{user}}\n\n去 /admin 后台把这条默认回复改成你想要的任意内容吧。',
  finishReason: DEFAULT_FINISH_REASON,
  note: 'worker 内置兜底，KV 无规则时生效',
};

const CACHE_TTL_MS = 10_000;
let cachedRules: { at: number; value: Rule[] } | null = null;
let cachedSettings: { at: number; value: Settings } | null = null;

export function invalidateCache(): void {
  cachedRules = null;
  cachedSettings = null;
}

export function sortRules(rules: Rule[]): Rule[] {
  return [...rules].sort((a, b) => {
    if (!!a.isDefault !== !!b.isDefault) return a.isDefault ? 1 : -1;
    const p = (b.priority ?? 0) - (a.priority ?? 0);
    if (p !== 0) return p;
    return String(a.updatedAt || '').localeCompare(String(b.updatedAt || ''));
  });
}

export async function loadRules(kv: KVNamespace, force = false): Promise<Rule[]> {
  const now = Date.now();
  if (!force && cachedRules && now - cachedRules.at < CACHE_TTL_MS) return cachedRules.value;

  const rules: Rule[] = [];
  let cursor: string | undefined;
  do {
    // 注意：KV 的 list 不支持 cacheTtl，get 才支持；这里靠上面的内存缓存（10s）压低读取量
    const page = await kv.list({ prefix: 'rule:', cursor, limit: 1000 });
    for (const k of page.keys) {
      const raw = await kv.get(k.name, 'json');
      if (raw && typeof raw === 'object') {
        const r = raw as Rule;
        r.id = r.id || k.name.slice('rule:'.length);
        if (typeof r.content !== 'string') r.content = '';
        if (typeof r.name !== 'string') r.name = r.id;
        rules.push(r);
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  const sorted = sortRules(rules);
  cachedRules = { at: now, value: sorted };
  return sorted;
}

export async function saveRule(kv: KVNamespace, rule: Rule): Promise<Rule> {
  const clean: Rule = {
    id: rule.id,
    name: (rule.name || '').trim() || '未命名规则',
    enabled: rule.enabled !== false,
    priority: Number.isFinite(rule.priority) ? Number(rule.priority) : 0,
    content: typeof rule.content === 'string' ? rule.content : '',
    finishReason: (rule.finishReason || '').trim() || undefined,
    model: (rule.model || '').trim() || undefined,
    note: (rule.note || '').trim() || undefined,
    updatedAt: new Date().toISOString(),
  };
  if (rule.isDefault) clean.isDefault = true;
  const delay = Number(rule.delayMs);
  clean.delayMs = Number.isFinite(delay) && delay > 0 ? Math.min(delay, 60_000) : 0;
  const match = {
    model: rule.match?.model?.trim() || undefined,
    keyword: rule.match?.keyword?.trim() || undefined,
    regex: rule.match?.regex?.trim() || undefined,
  };
  clean.match = match.model || match.keyword || match.regex ? match : {};

  await kv.put(`rule:${clean.id}`, JSON.stringify(clean, null, 2));
  invalidateCache();
  return clean;
}

export async function deleteRule(kv: KVNamespace, id: string): Promise<void> {
  await kv.delete(`rule:${id}`);
  invalidateCache();
}

export async function getRule(kv: KVNamespace, id: string): Promise<Rule | null> {
  const raw = await kv.get(`rule:${id}`, 'json');
  return raw ? (raw as Rule) : null;
}

export async function loadSettings(kv: KVNamespace, force = false): Promise<Settings> {
  const now = Date.now();
  if (!force && cachedSettings && now - cachedSettings.at < CACHE_TTL_MS) return cachedSettings.value;

  const raw = await kv.get('settings', 'json');
  const value: Settings = { ...DEFAULT_SETTINGS, ...(raw && typeof raw === 'object' ? (raw as Partial<Settings>) : {}) };
  value.defaultDelayMs = Number.isFinite(Number(value.defaultDelayMs))
    ? Math.max(0, Math.min(60_000, Number(value.defaultDelayMs)))
    : 0;
  cachedSettings = { at: now, value };
  return value;
}

export async function saveSettings(kv: KVNamespace, patch: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings(kv, true);
  const next: Settings = { ...current, ...patch };
  next.serviceName = String(next.serviceName || DEFAULT_SETTINGS.serviceName).slice(0, 120);
  next.defaultModel = String(next.defaultModel || DEFAULT_SETTINGS.defaultModel).slice(0, 120);
  next.fakeKeyPrefix = String(next.fakeKeyPrefix ?? 'sk-').slice(0, 20);
  next.requireApiKey = !!next.requireApiKey;
  next.defaultDelayMs = Math.max(0, Math.min(60_000, Number(next.defaultDelayMs) || 0));
  await kv.put('settings', JSON.stringify(next, null, 2));
  invalidateCache();
  return next;
}

/** 首次部署时写入一条兜底规则，让服务开箱即用 */
export async function seedIfEmpty(kv: KVNamespace): Promise<{ seeded: boolean }> {
  const existing = await loadRules(kv, true);
  if (existing.length > 0) return { seeded: false };

  await saveRule(kv, {
    id: 'default',
    name: '默认回复（兜底）',
    enabled: true,
    isDefault: true,
    priority: -10,
    match: {},
    content:
      '你好，我是运行在 Cloudflare Workers 上的「假 LLM」。\n\n' +
      '你刚才说的是：{{user}}\n' +
      '你调用的是模型：{{model}}，请求指纹 {{hash}}，时间 {{time}}。\n\n' +
      '这条回复完全来自 KV 里存储的自定义文本，没有调用任何真实大模型。\n' +
      '在 /admin 后台里，你可以把它改成任意内容。',
    finishReason: 'stop',
    note: '开箱即用的兜底规则，由 /admin 后台管理',
  });

  await saveRule(kv, {
    id: 'example-keyword',
    name: '示例：命中「你是谁」时坦白',
    enabled: true,
    priority: 10,
    match: { keyword: '你是谁' },
    content: '我是一个假的 LLM。所有回复都是 llm.yexiangha.top 后台里预先写好的文本，没有任何模型被调用 🙂',
    finishReason: 'stop',
    note: '示例规则：关键词匹配，可以删掉',
  });

  return { seeded: true };
}
