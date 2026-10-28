/**
 * 主动开口的提示词与生成。
 *
 * 和普通对话最大的不同：**没有「用户这句话」**。所以整段上下文的最后一条是「指令」而不是消息，
 * 并且要求模型先写一句**内心独白**（think）再决定说什么（say）——独白不发送，只落 trace：
 *  - 行为可解释：事后能回答「她为什么突然找我」；
 *  - 便于调参：独白普遍是「没事找事」时，说明冲动阈值该往上抬；
 *  - 天然抑制废话：要求它先说明动机，模型会更倾向于输出 SKIP。
 */

import { composeSystemPrompt } from './prompt.mjs';
import { extractChatImage, imageInstruction } from './memes.mjs';
import { chatCompletion } from './llm.mjs';
import { withUsage } from './usage.mjs';

/** 把心情翻译成一句人话（给提示词用，不给用户看） */
export function moodWord(mood = {}) {
  const v = Number(mood.valence ?? 0);
  const a = Number(mood.arousal ?? 0.4);
  const c = Number(mood.clingy ?? 0.4);
  const parts = [];
  parts.push(v > 0.45 ? '心情不错' : v > 0.05 ? '心情平稳' : v > -0.3 ? '有点闷' : '不太开心');
  parts.push(a > 0.7 ? '精神头很足' : a > 0.35 ? '正常' : '有点懒散');
  parts.push(c > 0.7 ? '特别想找主人说话' : c > 0.4 ? '有点想有人陪' : '还算自在');
  return parts.join('，');
}

const THINK_SAY_RULE = [
  '输出必须是**一行 JSON**，不要代码围栏、不要多余解释：',
  '{"think":"内心独白（10~30字，说明你为什么现在想说话）","say":"要发出去的话"}',
  '如果判断现在不该开口，就把 say 写成 "SKIP"。',
].join('\n');

/** 解析 {"think":..,"say":..}，容忍围栏与额外文本 */
export function parseThinkSay(text) {
  const s = String(text || '').trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try {
      const obj = JSON.parse(s.slice(a, b + 1));
      const think = String(obj?.think ?? '').trim();
      const say = String(obj?.say ?? obj?.message ?? '').trim();
      if (say || think) return { think, say };
    } catch {
      /* 落到下面的兜底 */
    }
  }
  // 模型没按 JSON 来：整段当正文，独白留空
  return { think: '', say: s };
}

function baseSystem(pet, now) {
  return composeSystemPrompt({
    prompt: String(pet?.prompt ?? '').trim(),
    name: pet?.name || '小蓝',
    id: pet?.id || 'main',
    now,
  });
}

/**
 * 生成一条主动消息。
 * @returns {Promise<{ok: true, think: string, say: string} | {ok: false, reason: string, message?: string}>}
 */
export async function generateProactive({ pet, now = new Date(), history = [], mood = {}, pool = [], hint = '' }) {
  const system = [
    baseSystem(pet, now),
    '',
    '【现在没有人在跟你说话。是你自己想起了主人，想主动开口。】',
    `你此刻的状态：${moodWord(mood)}。`,
    hint ? `最近的线索：${hint}` : '',
    '',
    '要求：',
    '- 像平常聊天那样自然，1~2 句，不超过 60 字；不要像提醒机器人，不要“温馨问候模板”；',
    '- 别提“我现在主动找你”这种元话；不要 Markdown；',
    '- 如果你觉得此刻没有真正值得说的，就 SKIP——沉默比没话找话更好。',
    THINK_SAY_RULE,
  ]
    .filter(Boolean)
    .join('\n');

  const msgs = [{ role: 'system', content: system }];
  for (const m of history.slice(-8)) {
    if (m && (m.role === 'user' || m.role === 'assistant') && m.content) {
      msgs.push({ role: m.role, content: String(m.content) });
    }
  }
  msgs.push({
    role: 'user',
    content: `（现在是你自己想说话的时候。${hint ? '参考上面的线索。' : ''}按 JSON 输出。）` + imageInstruction(pool),
  });

  const res = await withUsage('proactive', () => chatCompletion(msgs, { temperature: 1, maxTokens: 220 }));
  if (!res.ok) return { ok: false, reason: res.reason, message: res.message };

  const { think, say } = parseThinkSay(res.text);
  const { text, image } = extractChatImage(say, pool);
  const body = String(text).trim();
  if (!body || /^skip$/i.test(body) || body === 'SKIP') return { ok: true, think, say: '' };
  return { ok: true, think, say: body, image };
}

/**
 * 兑现已到点的承诺。
 * @param {{what: string, dueAt: string}} item
 */
export async function generateCommitmentMessage({ pet, now = new Date(), history = [], item, pool = [] }) {
  const system = [
    baseSystem(pet, now),
    '',
    '【你之前答应过主人一件事，现在到点了，去兑现。】',
    `答应的事：${item.what}`,
    '',
    '要求：',
    '- 自然地说起这件事，像真的记着，而不是闹钟播报；',
    '- 1~2 句，不超过 60 字，不要 Markdown；',
    '- 别道歉式开场（“抱歉打扰”之类），也别提“提醒服务”。',
    THINK_SAY_RULE,
  ].join('\n');

  const msgs = [{ role: 'system', content: system }];
  for (const m of history.slice(-6)) {
    if (m && (m.role === 'user' || m.role === 'assistant') && m.content) {
      msgs.push({ role: m.role, content: String(m.content) });
    }
  }
  msgs.push({ role: 'user', content: '（现在去兑现。按 JSON 输出。）' + imageInstruction(pool) });

  const res = await withUsage('promise', () => chatCompletion(msgs, { temperature: 1, maxTokens: 220 }));
  if (!res.ok) return { ok: false, reason: res.reason, message: res.message };

  const { think, say } = parseThinkSay(res.text);
  const { text, image } = extractChatImage(say, pool);
  const body = String(text).trim();
  if (!body || /^skip$/i.test(body)) {
    return { ok: true, think, say: `（我还记得：${item.what}）` };
  }
  return { ok: true, think, say: body, image };
}

/**
 * 发一条 QQ 空间说说（纯文字）。
 *
 * 和上面两个的区别：说说不是发给某个人的，**是发到朋友圈子里的独白**。
 * 所以这里额外按两点把关：
 *  1. 写得像人随手一记，不像营销号（禁话题标签、禁链接、禁「分享」腔）；
 *  2. 模型自己判断「今天没什么可发的」就 SKIP —— 宁可一天不发，也别发凑数的。
 *
 * @returns {Promise<{ok: true, think: string, say: string} | {ok: false, reason: string, message?: string}>}
 */
export async function generateMood({ pet, now = new Date(), history = [], mood = {}, maxChars = 80 }) {
  const system = [
    baseSystem(pet, now),
    '',
    '【你想发一条 QQ 空间说说，纯文字，没有图片。】',
    `你此刻的状态：${moodWord(mood)}。`,
    '',
    '要求：',
    `- 一句话，不超过 ${maxChars} 字，像随手一记，不是在写文案；`,
    '- 不要话题标签（#xxx#）、不要链接、不要 @ 任何人；',
    '- 不要“分享”“记录一下”“今天也要加油”这类套装句；',
    '- 如果今天真没什么想说的，就 SKIP —— 空间不是打卡。',
    THINK_SAY_RULE,
  ].join('\n');

  const msgs = [{ role: 'system', content: system }];
  for (const m of history.slice(-6)) {
    if (m && (m.role === 'user' || m.role === 'assistant') && m.content) {
      msgs.push({ role: m.role, content: String(m.content) });
    }
  }
  msgs.push({ role: 'user', content: '（现在决定发不发。按 JSON 输出。）' });

  const res = await withUsage('mood', () => chatCompletion(msgs, { temperature: 1, maxTokens: 160 }));
  if (!res.ok) return { ok: false, reason: res.reason, message: res.message };

  const { think, say } = parseThinkSay(res.text);
  const body = String(say ?? '').trim();
  if (!body || /^skip$/i.test(body)) return { ok: true, think, say: '' };
  return { ok: true, think, say: body };
}
