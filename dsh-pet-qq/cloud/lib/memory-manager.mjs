/**
 * 记忆管理（S5）：情节记忆的分层压缩 + 自我模型。
 *
 * 三层模型：
 *  - L1 情节记忆：最近的原始对话（memory.json，按会话分桶）；
 *  - L2 压缩摘要：更早的轮次压成一段摘要，**落盘** `data/summaries/<bucket>.json`，
 *    每轮以「（以下是之前聊过的…摘要）」+「（已了解）」一对注入；摘要本身过长时再做「摘要的摘要」；
 *  - L3 语义记忆：见 semantic.mjs（带 importance / 衰减 / 归档）。
 *
 * 参考了 AstrBot `astrbot/core/agent/context/compressor.py` 的三个做法：
 *  - 按 token 比例触发（默认 0.82）；
 *  - 保留最近约 15%（最新一轮永远整轮保留）；
 *  - 把摘要拼成 user/assistant 一对注入，后面接保留的最近轮次。
 * 我们额外做的：摘要**持久化**（重启不丢）、摘要的摘要、失败时按轮截断兜底（AstrBot 的
 * TruncateByTurnsCompressor）、以及自我模型（≤220 字，一天最多更新一次，防人格漂移）。
 */

import { readFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { PATHS, readJson, writeJson } from './store.mjs';
import { chatCompletion } from './llm.mjs';

export const MEM_DEFAULTS = {
  maxHistoryTokens: 900, // 进 prompt 的历史预算（system prompt 另算）
  compressAt: 0.82, // 超过预算的 82% 才压（AstrBot 的 compression_threshold）
  keepRecentRatio: 0.15, // 保留最近 15%（上限 30%，至少一整轮）
  maxKeepRatio: 0.3,
  summaryMaxChars: 700, // 摘要上限；超过 1.6 倍做「摘要的摘要」
  summaryTokens: 420, // 生成摘要时的 max_tokens
  selfMaxChars: 220,
  selfUpdateHours: 24,
};

const SUMMARY_DIR = join(dirname(PATHS.memory), 'summaries');

/* ------------------------------- token 估算 ------------------------------- */

/** 粗估：CJK 约 1 token/字，ASCII 约 0.3 token/字符（不追求精确，只用来判阈值） */
export function estimateTokens(text) {
  const s = String(text ?? '');
  let cjk = 0;
  let other = 0;
  for (const ch of s) {
    if (/[\u3400-\u9fff\uf900-\ufaff]/.test(ch)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk + other * 0.3);
}

export function estimateMessages(messages) {
  let n = 0;
  for (const m of messages || []) n += estimateTokens(m?.content) + 4;
  return n;
}

/* -------------------------------- 摘要存取 -------------------------------- */

const summaryFile = (bucket) => join(SUMMARY_DIR, `${String(bucket).replace(/[^\w@:-]+/g, '_')}.json`);

export async function loadSummary(bucket) {
  const raw = await readJson(summaryFile(bucket), null);
  if (!raw || typeof raw.summary !== 'string') return null;
  return raw;
}

export async function saveSummary(bucket, data) {
  await mkdir(SUMMARY_DIR, { recursive: true });
  await writeJson(summaryFile(bucket), data);
  return data;
}

/** 摘要注入用的那一对消息（AstrBot 同款结构，只是换了中文话术） */
export function summaryPair(summary) {
  const body = String(summary ?? '').trim();
  if (!body) return [];
  return [
    { role: 'user', content: `（以下是之前聊过的内容的摘要，供你接上下文）\n${body}` },
    { role: 'assistant', content: '（已了解，我接着刚才的话说。）' },
  ];
}

/* ------------------------------- 摘要生成 -------------------------------- */

const SUMMARY_PROMPT =
  '你在帮一个 QQ 聊天机器人整理「她自己的记忆」。把下面较早的对话压成一段摘要，' +
  '要求：①保留人物称呼、约定与承诺、关键事实与偏好、尚未完成的事与最新进展；' +
  '②用第三人称、简洁短句，不要逐条复述；' +
  `③不超过 ${MEM_DEFAULTS.summaryMaxChars} 字；④不要寒暄，不要解释你在做什么。`;

const MERGE_PROMPT =
  '把「旧摘要」和「新对话」合并成一段新的记忆摘要，要求：' +
  '①只保留仍然有用的事实、约定、偏好、未完成的事；②过时或琐碎的细节丢掉；' +
  `③不超过 ${MEM_DEFAULTS.summaryMaxChars} 字；④第三人称、短句。`;

const transcribe = (messages) =>
  messages
    .map((m) => `${m.role === 'user' ? '对方' : '她'}：${String(m.content ?? '').slice(0, 300)}`)
    .join('\n');

/** 让模型压一次；失败返回 null（调用方走截断兜底） */
async function askSummary({ older, previous = '' }) {
  const user = previous
    ? `旧摘要：\n${previous}\n\n新对话：\n${transcribe(older)}`
    : transcribe(older);
  const res = await chatCompletion(
    [
      { role: 'system', content: previous ? MERGE_PROMPT : SUMMARY_PROMPT },
      { role: 'user', content: user },
    ],
    { temperature: 0.3, maxTokens: MEM_DEFAULTS.summaryTokens },
  );
  if (!res.ok || !res.text) return null;
  const text = String(res.text).replace(/\s+\n/g, '\n').trim();
  return text || null;
}

/**
 * 把「太长」的历史压成摘要；返回实际进 prompt 的消息数组。
 * 触发条件与切分都按 MEM_DEFAULTS，可被 pet.json 的 `memory` 段覆盖。
 */
export async function manageHistory({ bucket, messages, conf = {}, now = Date.now() } = {}) {
  const cfg = { ...MEM_DEFAULTS, ...(conf.memory || {}) };
  const list = (messages || []).filter((m) => m && m.content);
  const saved = await loadSummary(bucket);
  if (!list.length) {
    return { messages: summaryPair(saved?.summary), compressed: false, summary: saved };
  }

  const budget = Number(cfg.maxHistoryTokens) || MEM_DEFAULTS.maxHistoryTokens;
  const threshold = Math.max(0.2, Math.min(0.95, Number(cfg.compressAt) || MEM_DEFAULTS.compressAt));
  const tokens = estimateMessages(list);
  let summary = saved?.summary ?? '';
  let covered = saved?.coveredUntil ?? 0;
  let compressed = false;
  let reason = '';

  if (tokens > budget * threshold) {
    // 至少要留一整轮（2 条），且不低于 keepRecentRatio；最新一轮永远整轮保留
    const ratio = Math.max(0.05, Math.min(Number(cfg.maxKeepRatio) || MEM_DEFAULTS.maxKeepRatio, Number(cfg.keepRecentRatio) || 0.15));
    const keepCount = Math.max(2, Math.ceil(list.length * ratio));
    const older = list.slice(0, Math.max(0, list.length - keepCount));
    const recent = list.slice(list.length - keepCount);
    if (older.length >= 2) {
      const merged = await askSummary({ older, previous: summary });
      if (merged) {
        summary = merged;
        covered = list.length - keepCount;
        compressed = true;
        reason = 'compressed';
      } else {
        // 兜底：模型不可用就按轮截断（TruncateByTurns 写法），至少把预算压下来
        compressed = true;
        reason = 'truncated';
      }
    }
    if (summary.length > cfg.summaryMaxChars * 1.6) {
      const shorter = await askSummary({ older: [{ role: 'user', content: summary }] });
      if (shorter) summary = shorter;
    }
    if (summary) {
      await saveSummary(bucket, {
        summary,
        coveredUntil: covered,
        updatedAt: now,
        chars: summary.length,
        tokens: estimateTokens(summary),
        reason,
      });
    }
    // 预算仍然超 → 从「最近的轮次」里整轮往前丢，**绝不丢摘要那一对**
    const out = [...summaryPair(summary), ...recent];
    while (estimateMessages(out) > budget && out.length > 4) {
      out.splice(2, 2);
    }
    return { messages: out, compressed, summary: { summary, coveredUntil: covered }, reason };
  }

  return { messages: [...summaryPair(summary), ...list], compressed: false, summary: saved };
}

/* -------------------------------- 自我模型 -------------------------------- */

const SELF_FILE = () => join(dirname(PATHS.memory), 'self.json');

export async function loadSelf() {
  try {
    const raw = JSON.parse(await readFile(SELF_FILE(), 'utf8'));
    return typeof raw?.text === 'string' ? raw : null;
  } catch {
    return null;
  }
}

/**
 * 更新自我模型：一天最多一次、字数硬上限，且**只允许小步变化**
 * （新文本与旧文本的字面重合度 < 0.35 视为人格漂移，直接拒绝）。
 */
export async function updateSelf({ text, now = Date.now(), force = false } = {}) {
  const body = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MEM_DEFAULTS.selfMaxChars);
  if (!body) return { ok: false, reason: 'empty' };
  const cur = await loadSelf();
  if (!force && cur) {
    if (now - Number(cur.updatedAt || 0) < MEM_DEFAULTS.selfUpdateHours * 3_600_000) {
      return { ok: false, reason: 'too-soon', kept: cur };
    }
    const overlap = [...new Set(body.replace(/[，。！？、\s]/g, ''))].filter((ch) =>
      cur.text.includes(ch),
    ).length;
    const ratio = overlap / Math.max(1, new Set(body.replace(/[，。！？、\s]/g, '')).size);
    if (ratio < 0.35) return { ok: false, reason: 'drift', kept: cur };
  }
  const next = { text: body, updatedAt: now };
  await mkdir(dirname(SELF_FILE()), { recursive: true });
  await writeJson(SELF_FILE(), next);
  return { ok: true, self: next };
}

/** 给 system prompt 用（没有就空串） */
export async function selfBrief() {
  const self = await loadSelf();
  if (!self?.text) return '';
  return `\n\n【你对自己的认识】${self.text}`;
}

export const SELF_PATH = SELF_FILE;
export { SUMMARY_DIR };
