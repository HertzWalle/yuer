// 试运行：把某个会话（默认只有主人的私聊）转给本地 Letta agent 回答。
// Letta 服务在本机跑，通过 SSH 反向隧道暴露成服务器上的 127.0.0.1:8283。
// 出任何问题都返回 null，让桥回落到原来的大脑，不至于失联。

import { recordTurn, takeSnapshot } from './letta-audit.mjs';

const DEFAULTS = {
  enabled: false,
  baseUrl: 'http://127.0.0.1:8283/v1',
  agentId: '',
  convs: [],
  timeoutMs: 120_000,
  maxSegments: 3,
  // P1：每轮前后各拍一次快照，把「她改了哪块」记进 data/letta-audit.jsonl
  audit: true,
};

function cfgOf(raw) {
  if (!raw || raw.enabled !== true || !raw.agentId) return null;
  return { ...DEFAULTS, ...raw };
}

/** 这个会话该不该交给 Letta？返回配置或 null */
export function lettaTrial(raw, conv) {
  const cfg = cfgOf(raw);
  if (!cfg) return null;
  if (!Array.isArray(cfg.convs) || cfg.convs.length === 0) return null;
  return cfg.convs.includes(conv) ? cfg : null;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === 'object' ? p.text ?? '' : ''))
      .filter(Boolean)
      .join(' ');
  }
  return '';
}

/** 发一条给 Letta，拿她的回复（含调用的记忆工具，方便记账） */
export async function lettaReply(cfg, text, { log } = {}) {
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/agents/${cfg.agentId}/messages`;
  // 审计：她改记忆是在这一轮里发生的，所以前后各拍一次
  const audit = cfg.audit !== false;
  const before = audit ? await takeSnapshot(cfg, { reason: 'pre-turn' }).catch(() => null) : null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', connection: 'close' },
      body: JSON.stringify({ messages: [{ role: 'user', content: text }], stream: false }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      log?.warn?.(`Letta 返回 ${res.status}`);
      return null;
    }
    const data = await res.json();
    let reply = '';
    const tools = [];
    for (const m of data.messages ?? []) {
      if (m.message_type === 'assistant_message') reply = textOf(m.content).trim();
      for (const tc of m.tool_calls ?? []) {
        const fn = tc.function ?? {};
        // 只记记忆类工具，别把内部工具名刷进日志
        if (String(fn.name || '').startsWith('memory') || fn.name === 'conversation_search') {
          tools.push(fn.name);
        }
      }
    }
    if (!reply) return null;
    // 有审计就比一次前后差异（失败只记日志，不影响回复）
    if (audit) {
      try {
        const after = await takeSnapshot(cfg, { reason: 'post-turn' });
        const changes = await recordTurn(cfg, { before, after, text, reply, tools });
        if (changes?.length) {
          log?.info?.(`Letta 改了记忆：${changes.map((c) => `${c.label}${c.deltaChars >= 0 ? '+' : ''}${c.deltaChars ?? 0}字`).join('、')}`);
        }
      } catch (e) {
        log?.warn?.(`审计没记上：${e?.message ?? e}`);
      }
    }
    return { ok: true, reply, tools };
  } catch (e) {
    log?.warn?.(`Letta 调用失败：${e?.name === 'AbortError' ? '超时' : e?.message ?? e}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 她爱用换行分句，切成几条气泡；太长的单行不硬切，宁可一条发完 */
export function splitLettaReply(text, max = 3) {
  const raw = String(text ?? '')
    .replace(/\[图[:：][^\]]*\]/gu, '')
    .split(/\n+/)
    .map((s) => s.trim())
    .filter((s) => s && !/^[（(][^）)]{0,40}[）)]$/.test(s));
  if (raw.length === 0) return [];
  if (raw.length <= max) return raw;
  return [...raw.slice(0, max - 1), raw.slice(max - 1).join(' ')];
}

/* --------------------------- P2：动机接入 --------------------------- */

/** 我们把「为什么现在想说」讲给她，由她决定说什么、或者不说 */
export function wakePrompt({ reason = '攒够了想说话的冲动', hint = '', mood = '' } = {}) {
  return [
    '（系统提醒，不是主人在说话）',
    '这会儿你自己有点想主动开口。',
    `起因：${reason}。`,
    hint ? String(hint) : '',
    mood ? `你现在的心情：${mood}。` : '',
    '要不要说、说什么，你自己定；不想说就只回 SKIP，不用解释。',
    '要是想说，直接写你要发给主人的那几句，别复述这条提醒。',
  ]
    .filter(Boolean)
    .join('\n');
}

/** 她回「SKIP」= 这会儿不想说 */
export function isSkipReply(text) {
  return /^\s*[（(]?\s*skip\s*[)）]?[。.!！]?\s*$/i.test(String(text ?? '').trim());
}

/** 带着「为什么想说话」去叫醒她（走同一条消息接口，所以也会被审计） */
export async function lettaWake(cfg, { reason, hint, mood } = {}, { log } = {}) {
  const got = await lettaReply(cfg, wakePrompt({ reason, hint, mood }), { log });
  if (!got?.ok) return null;
  return { ok: true, reply: got.reply, skip: isSkipReply(got.reply), tools: got.tools };
}
