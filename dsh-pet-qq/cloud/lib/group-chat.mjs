/**
 * 群聊「插话」的两步 LLM：先旁听打分，再决定说什么。
 *
 * 为什么分两步：群里的错误代价比私聊高得多——私聊最多是回得不好，
 * 群里是「这机器人怎么老插嘴」。所以先让模型当旁观者评一句「现在插话自不自然」（0~10），
 * 分数不过线就直接放弃，连起草都不做（省 token，也省一次翻车机会）。
 *
 * 起草那一步带着「旁听时看到的上下文 + 自己刚才的打分理由」，写出来才接得住话。
 */

import { chatCompletion } from './llm.mjs';
import { withUsage } from './usage.mjs';
import { extractChatImage, imageInstruction } from './memes.mjs';
import { composeSystemPrompt } from './prompt.mjs';
import { parseThinkSay } from './proactive.mjs';

function baseSystem(ctx, now) {
  return composeSystemPrompt({
    prompt: String(ctx?.prompt ?? '').trim(),
    name: ctx?.name || '小蓝',
    id: ctx?.id || 'main',
    now,
  });
}

/** 把旁听缓冲排成「昵称：内容」的几行（最多 12 行，太长只留最近） */
export function transcriptOf(buffer = [], max = 12) {
  return buffer
    .slice(-max)
    .map((m) => `${m.name || '群友'}：${String(m.text || '').slice(0, 80)}`)
    .join('\n');
}

const SCORE_RULES = [
  '你在一个 QQ 群里潜水，看到下面这些消息。判断：**现在**开口说一句，自然吗？',
  '',
  '打分参考（0~10）：',
  '- 8~10：有人在讨论你熟悉的话题，或有人问了个问题正好你能接；语境清楚、气氛友好。',
  '- 5~7：大家在闲聊，可以接一句但你不接也不缺什么。',
  '- 2~4：话题跟你无关、别人在互相说话、或者已经有人说完了。',
  '- 0~1：在吵架、在聊私事/感情/隐私、在刷屏玩梗、有人明显不想被打断。',
  '',
  '只回一个 JSON，不要别的：{"score": <数字>, "why": "<15 字以内理由>"}',
].join('\n');

/**
 * 旁听评分。
 * @returns {Promise<{ok: true, score: number, why: string} | {ok: false, reason: string, message?: string}>}
 */
export async function scoreChatter({ ctx, now = new Date(), buffer = [], group = {}, weights = {} }) {
  const system = [
    baseSystem(ctx, now),
    '',
    '【你现在是群里的潜水者，不是发言人。先判断该不该开口。】',
    `这个群今天你已经说过 ${Number(group.sentToday || 0)} 次；你上一次开口在 ${
      group.lastSpokeAt ? new Date(group.lastSpokeAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '还没说过'
    }。`,
    Number(weights.annoyance || 0) >= 30 ? `注意：群里最近对你有些不耐烦（反感度 ${Math.round(weights.annoyance)}）。` : '',
    '',
    SCORE_RULES,
  ]
    .filter(Boolean)
    .join('\n');

  const msgs = [
    { role: 'system', content: system },
    { role: 'user', content: `最近的群聊：\n${transcriptOf(buffer)}\n\n现在该不该开口？` },
  ];

  const res = await withUsage('group', () => chatCompletion(msgs, { temperature: 0.6, maxTokens: 80 }));
  if (!res.ok) return { ok: false, reason: res.reason, message: res.message };

  const text = String(res.text || '');
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  let score = null;
  let why = '';
  if (a >= 0 && b > a) {
    try {
      const obj = JSON.parse(text.slice(a, b + 1));
      const n = Number(obj?.score);
      if (Number.isFinite(n)) score = Math.max(0, Math.min(10, n));
      why = String(obj?.why ?? '').slice(0, 40);
    } catch {
      /* 落到下面的兜底 */
    }
  }
  if (score === null) {
    const m = text.match(/(\d{1,2})\s*\/\s*10|score\D{0,6}(\d{1,2})/);
    if (m) score = Math.max(0, Math.min(10, Number(m[1] ?? m[2])));
  }
  if (score === null) return { ok: false, reason: 'unparsable', message: text.slice(0, 80) };
  return { ok: true, score, why };
}

const DRAFT_RULES = [
  '要求：',
  '- 像群里随手打的一句：1~2 条短消息（想分两条就用换行分开），每条不超过 20 字；',
  '- 除非有人直接问你，否则**不要 @ 任何人**；不要客套、不要总结、不要“有什么可以帮你”；',
  '- 可以只接半句、可以吐槽、可以问一句，但别抢话；不要 Markdown；',
  '- 如果开口反而尴尬，就把 say 写成 "SKIP"。',
  '',
  '只回一个 JSON：{"think": "<20~40 字内心独白>", "say": "<要发的话>"}',
].join('\n');

/**
 * 起草一条群聊插话。
 * @returns {Promise<{ok: true, think: string, say: string, image?: string} | {ok: false, reason: string, message?: string}>}
 */
export async function draftGroupMessage({ ctx, now = new Date(), buffer = [], pool = [], why = '', mood = '' }) {
  const system = [
    baseSystem(ctx, now),
    '',
    '【你在群里潜水看着大家聊，现在决定插一句。】',
    mood ? `你此刻的状态：${mood}。` : '',
    why ? `你为什么觉得可以说：${why}` : '',
    pool.length ? imageInstruction(pool) : '',
    '',
    DRAFT_RULES,
  ]
    .filter(Boolean)
    .join('\n');

  const msgs = [
    { role: 'system', content: system },
    { role: 'user', content: `最近的群聊：\n${transcriptOf(buffer)}\n\n你要说什么？` },
  ];

  const res = await withUsage('group', () => chatCompletion(msgs, { temperature: 1, maxTokens: 200 }));
  if (!res.ok) return { ok: false, reason: res.reason, message: res.message };

  const { think, say } = parseThinkSay(res.text);
  if (!say || /^skip$/i.test(say.replace(/["'。！!]/g, '').trim())) {
    return { ok: false, reason: 'self-skip', message: think || 'SKIP' };
  }
  const { text, image } = extractChatImage(say, pool);
  return image ? { ok: true, think, say: text, image } : { ok: true, think, say: text };
}
const OPENER_RULES = [
  '要求：',
  '- 群里已经安静好一阵了，你主动起个话头，或者吐槽一句自己的事（顺手、随便，不要像开场白）；',
  '- **不要 @ 任何人**，不要问「在吗」「有人吗」，不要总结上一条对话；',
  '- 1 条，最多 2 条短句，每条 20 字以内；不要 Markdown、不要客套；',
  '- 可以聊你现在在做什么、刚看到的东西、这个点该干嘛；',
  '- 如果实在没什么可说的，把 say 写成 "SKIP"。',
  '',
  '只回一个 JSON：{"think": "<20~40 字内心独白>", "say": "<要发的话>"}',
].join('\n');

/**
 * 冷清群的主动开场：没人理她，她自己起个话头。
 * 和插话的区别是没有「别人刚说的话」可接，所以给的背景是「最近群里聊过什么 + 你最近看到什么」。
 * @returns {Promise<{ok: true, think: string, say: string, image?: string} | {ok: false, reason: string, message?: string}>}
 */
export async function draftOpener({ ctx, now = new Date(), buffer = [], pool = [], mood = '', seen = '' }) {
  const system = [
    baseSystem(ctx, now),
    '',
    '【群里现在很安静，你想自己起个话头。】',
    mood ? `你此刻的状态：${mood}。` : '',
    seen ? `你最近看到的：${seen}` : '',
    pool.length ? imageInstruction(pool) : '',
    '',
    OPENER_RULES,
  ]
    .filter(Boolean)
    .join('\n');

  const recent = buffer.length ? `最近群里聊过：\n${transcriptOf(buffer, 6)}\n\n` : '这个群最近一直很安静。\n\n';
  const msgs = [
    { role: 'system', content: system },
    { role: 'user', content: `${recent}你要说什么？` },
  ];

  const res = await withUsage('group', () => chatCompletion(msgs, { temperature: 1, maxTokens: 160 }));
  if (!res.ok) return { ok: false, reason: res.reason, message: res.message };

  const { think, say } = parseThinkSay(res.text);
  if (!say || /^skip$/i.test(say.replace(/["'。！!]/g, '').trim())) {
    return { ok: false, reason: 'self-skip', message: think || 'SKIP' };
  }
  const { text, image } = extractChatImage(say, pool);
  return image ? { ok: true, think, say: text, image } : { ok: true, think, say: text };
}
