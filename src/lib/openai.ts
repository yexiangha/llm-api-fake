/**
 * OpenAI 兼容响应构造：/v1/models 与 /v1/chat/completions（含 SSE 流式）。
 * 字段严格按 OpenAI 官方返回形状拼，任何 OpenAI SDK 都能直接反序列化。
 */

export const JSON_HEADERS: Record<string, string> = { 'content-type': 'application/json; charset=utf-8' };

export function newCompletionId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `chatcmpl-${hex}`;
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.round(text.length / 4));
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export function buildUsage(promptText: string, completionText: string): Usage {
  const p = estimateTokens(promptText);
  const c = estimateTokens(completionText);
  return { prompt_tokens: p, completion_tokens: c, total_tokens: p + c };
}

export interface CompletionArgs {
  id: string;
  model: string;
  content: string;
  finishReason: string;
  promptText: string;
  created?: number;
}

export function buildCompletion(args: CompletionArgs): Record<string, unknown> {
  const created = args.created ?? Math.floor(Date.now() / 1000);
  return {
    id: args.id,
    object: 'chat.completion',
    created,
    model: args.model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: args.content, refusal: null },
        logprobs: null,
        finish_reason: args.finishReason,
      },
    ],
    usage: buildUsage(args.promptText, args.content),
    system_fingerprint: 'fp_fake_llm_yexiangha',
    // 非标准字段，方便一眼看出是假服务；OpenAI SDK 会忽略未知字段
    _fake: true,
  };
}

function sse(data: unknown): string {
  return `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
}

/** 把文本切成小块，模拟逐字/逐词吐字 */
export function chunkText(text: string, size = 12): string[] {
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + size));
    i += size;
  }
  return chunks.length ? chunks : [''];
}

export interface StreamArgs extends CompletionArgs {
  /** 每块之间的间隔，默认 18ms */
  intervalMs?: number;
  chunkSize?: number;
}

/** 构造 OpenAI 风格的 SSE 流：role 帧 → 若干 content 帧 → finish 帧 → [DONE] */
export function buildStream(args: StreamArgs): ReadableStream<Uint8Array> {
  const created = args.created ?? Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();
  const base = { id: args.id, object: 'chat.completion.chunk', created, model: args.model, system_fingerprint: 'fp_fake_llm_yexiangha' };
  const pieces = chunkText(args.content, args.chunkSize ?? 12);
  const interval = Math.max(0, args.intervalMs ?? 18);

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: unknown) => controller.enqueue(encoder.encode(sse(payload)));
      const frame = (delta: unknown, finish: string | null) => ({
        ...base,
        choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }],
      });

      send(frame({ role: 'assistant', content: '' }, null));
      for (const piece of pieces) {
        send(frame({ content: piece }, null));
        if (interval > 0) await new Promise((r) => setTimeout(r, interval));
      }
      send(frame({}, args.finishReason));
      send(
        JSON.stringify({
          ...base,
          choices: [],
          usage: buildUsage(args.promptText, args.content),
        }),
      );
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}

export interface ModelEntry {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
}

export function buildModelList(modelIds: string[], ownedBy = 'fake-llm'): Record<string, unknown> {
  const created = Math.floor(Date.now() / 1000);
  const unique = [...new Set(modelIds.filter(Boolean))];
  return {
    object: 'list',
    data: unique.map<ModelEntry>((id) => ({ id, object: 'model', created, owned_by: ownedBy })),
  };
}

/** OpenAI 风格错误体 */
export function errorBody(message: string, type: string, code: string | null = null, param: string | null = null) {
  return { error: { message, type, param, code } };
}
