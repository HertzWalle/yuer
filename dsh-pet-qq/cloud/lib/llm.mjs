/**
 * 云端「大脑」：任何 OpenAI 兼容的 /chat/completions 端点（DeepSeek 官方、阿里通义、Moonshot、
 * OpenRouter、自建 one-api…都行）。
 *
 * 为什么不用 dsh 的 OAuth 账号令牌：那套是账号级凭证（platform.deepseek.com 的 device 授权），
 * 换机器复用既有失效风险也不该拷到别人的服务器上。云端建议单独申请一个 API key（sk-…）。
 *
 * 默认值对齐 dsh-pet 的对话生成：temperature 1、不传 max_tokens 以外的高级参数、60s 超时。
 * 失败一律返回结构化原因（provider-missing / generate-error），绝不伪造回复文案。
 */

const TIMEOUT_MS = 60_000;

export function llmConfig() {
  const key = (process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || '').trim();
  const base = (process.env.DEEPSEEK_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.deepseek.com/v1').trim();
  const model = (process.env.DEEPSEEK_MODEL || process.env.OPENAI_MODEL || 'deepseek-chat').trim();
  return { key, base: base.replace(/\/+$/, ''), model };
}

/** 端点 URL：base 以 /chat/completions 结尾就用原样，否则拼上去 */
export function endpointOf(base) {
  return /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';
}

/**
 * 生成一句回复。
 * @param {{role: 'system'|'user'|'assistant', content: string}[]} messages
 * @param {{model?: string, temperature?: number, maxTokens?: number, timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: true, text: string} | {ok: false, reason: string, message?: string}>}
 */
export async function chatCompletion(messages, opts = {}) {
  const conf = llmConfig();
  if (!conf.key) {
    return { ok: false, reason: 'provider-missing', message: '没配 DEEPSEEK_API_KEY（云端大脑需要一把 API key）' };
  }
  const model = (opts.model || conf.model || '').trim();
  const body = {
    model,
    messages,
    temperature: opts.temperature ?? 1,
    max_tokens: opts.maxTokens ?? 256,
    stream: false,
  };
  const url = endpointOf(conf.base);
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;

  let lastMessage = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + conf.key },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const raw = await res.text();
      if (!res.ok) {
        lastMessage = `HTTP ${res.status} ${raw.slice(0, 300)}`;
        // 4xx（除 429）重试没意义：key 错/模型名错/额度用尽，直接回
        if (res.status !== 429 && res.status < 500) break;
      } else {
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          lastMessage = '返回不是 JSON：' + raw.slice(0, 200);
          break;
        }
        const text = String(parsed?.choices?.[0]?.message?.content ?? '').trim();
        if (text) return { ok: true, text };
        lastMessage = '模型没返回正文（finish_reason=' + (parsed?.choices?.[0]?.finish_reason ?? '?') + '）';
      }
    } catch (e) {
      lastMessage = e?.name === 'TimeoutError' ? `超时（${timeoutMs}ms）` : String(e?.message || e);
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, 800 * attempt));
  }
  return { ok: false, reason: 'generate-error', message: lastMessage };
}
