/**
 * 语义记忆（很小的一份）：把「她看到/听到的事」沉淀成几句话，聊的时候自然带出来。
 *
 * 与 memory.json 的区别：
 * - memory.json 是**情节记忆**（一轮轮对话，原文，按会话分桶）；
 * - 这里是**语义记忆**（从外部看到的信息压成一句，比如「昨天发的说说：空调坏了」），
 *   不参与轮次裁剪，只留最近若干条，聊天时作为背景注入（不进对话历史）。
 *
 * 目前只有 QQ 空间这一个来源（S3 会加 B 站），所以先写得简单：
 * 一个 notes 数组，满了淘汰最旧的。
 */

import { readJson, writeJson, PATHS } from './store.mjs';

const FILE = PATHS.semantic;
const KEEP = 60;
const PROMPT_MAX = 420;

async function load() {
  const raw = await readJson(FILE, {});
  const notes = Array.isArray(raw?.notes) ? raw.notes : [];
  return { notes };
}

/** 追加一条；同一段文字 7 天内不重复记（同一批动态被反复拉到不会刷屏） */
export async function addNote(kind, text, { at = Date.now() } = {}) {
  const body = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!body) return null;
  const db = await load();
  const dup = db.notes.find(
    (n) => n.kind === kind && n.text === body && at - Number(n.at || 0) < 7 * 24 * 3_600_000,
  );
  if (dup) return dup;
  const note = { kind, text: body, at };
  db.notes.push(note);
  db.notes = db.notes.slice(-KEEP);
  await writeJson(FILE, { ...db, notes: db.notes });
  return note;
}

export async function recentNotes(n = 10, kind = null) {
  const db = await load();
  const list = kind ? db.notes.filter((x) => x.kind === kind) : db.notes;
  return list.slice(-Math.max(1, n));
}

const md = (ms) => {
  const d = new Date(ms);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
};

/**
 * 给 system prompt 用的一小段背景（没有就返回空串）。
 * 只取最近几条、总长不超过 PROMPT_MAX —— 记忆是背景，不是主角。
 */
export async function notesBrief(kind = 'qzone', n = 5) {
  const list = await recentNotes(n, kind);
  if (!list.length) return '';
  const lines = [];
  let used = 0;
  for (const note of [...list].reverse()) {
    const line = `- ${md(note.at)}：${note.text}`;
    if (used + line.length > PROMPT_MAX) break;
    lines.push(line);
    used += line.length;
  }
  if (!lines.length) return '';
  return (
    '\n\n【你最近看到的】下面是你自己看到过的事（主人发的动态之类），' +
    '聊天时可以作为背景自然提起，但**别刻意汇报**、别一次全倒出来：\n' +
    lines.join('\n')
  );
}

export { FILE as SEMANTIC_FILE };
