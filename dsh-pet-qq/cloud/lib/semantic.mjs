/**
 * 语义记忆：把「她看到 / 听到的事」压成一句话，聊的时候能被顺口带出来。
 *
 * 与 memory.json 的区别：
 * - memory.json 是**情节记忆**（一轮轮对话原文，按会话分桶，可被摘要压缩）；
 * - 这里是**语义记忆**：外部看到的东西（主人发的说说、B 站热门、抖音热搜）压成一句，
 *   不参与轮次裁剪；带 `importance` 与 `lastUsedAt`，用得上就加分，长期没人用就衰减归档。
 *
 * 设计约束：
 * - 只读、只记（红线：不代发、不点赞、不评论）；
 * - 注入 prompt 的部分有硬上限（PROMPT_MAX），记忆是背景不是主角；
 * - 归档不删除：低分老条目挪进 `data/archive/semantic-<日期>.json`。
 */

import { readJson, writeJson, PATHS } from './store.mjs';

const FILE = PATHS.semantic;
const KEEP = 240; // 在线保留条数（更早的靠归档，不直接删）
const PROMPT_MAX = 460;
const DECAY_PER_DAY = 0.02; // 每天掉 0.02
const ARCHIVE_AFTER_DAYS = 30;
const ARCHIVE_BELOW = 0.15;

const day = 86_400_000;

async function load() {
  const raw = await readJson(FILE, {});
  const notes = Array.isArray(raw?.notes) ? raw.notes : [];
  return { notes: notes.map((n) => ({ importance: 0.5, lastUsedAt: 0, usedCount: 0, ...n })) };
}

const md = (ms) => {
  const d = new Date(ms);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
};

const clean = (s) =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * 追加一条；同 kind 同文 7 天内不重复记（同一批热搜被反复拉到也不会刷屏）。
 * `importance` 0~1，默认 0.5；主人相关的（说说、约定）可以给高一点。
 */
export async function addNote(kind, text, { at = Date.now(), importance = 0.5 } = {}) {
  const body = clean(text);
  if (!body) return null;
  const db = await load();
  const dup = db.notes.find(
    (n) => n.kind === kind && n.text === body && at - Number(n.at || 0) < 7 * day,
  );
  if (dup) return dup;
  const note = {
    id: `${at.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    kind,
    text: body,
    at,
    importance: Math.max(0, Math.min(1, Number(importance) || 0.5)),
    lastUsedAt: 0,
    usedCount: 0,
  };
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

/** 最长公共子串长度（query 与 note 文本） */
function lcsLen(a, b) {
  if (!a || !b) return 0;
  let best = 0;
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j += 1) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      }
    }
    prev = cur;
  }
  return best;
}

/**
 * 关键词检索：整串包含 = 1；否则取「2-gram 覆盖率」与「最长公共子串占比」的较大值。
 * 只按 2-gram 会把「服务器」这种 3 字主题词算成 2/6=0.33 刚好掉线，加一条子串占比兜底。
 */
export function scoreNote(note, query) {
  const q = clean(query).toLowerCase();
  if (!q) return 0;
  const text = String(note.text ?? '').toLowerCase();
  if (text.includes(q)) return 1;
  const grams = new Set();
  for (let i = 0; i < q.length - 1; i += 1) {
    const g = q.slice(i, i + 2).trim();
    if (g.length === 2) grams.add(g);
  }
  let hit = 0;
  for (const g of grams) if (text.includes(g)) hit += 1;
  const gramScore = grams.size ? hit / grams.size : 0;
  // 主题词一般 3~4 字：按「最长公共子串 / min(查询长度, 8)」估一个语义贴近度
  const lcsScore = lcsLen(q, text) / Math.min(q.length, 8);
  return Math.max(gramScore, lcsScore);
}

export async function recall(query, { n = 4, minScore = 0.34, kinds = null } = {}) {
  const db = await load();
  const pool = kinds ? db.notes.filter((x) => kinds.includes(x.kind)) : db.notes;
  return pool
    .map((note) => ({ note, score: scoreNote(note, query) }))
    .filter((x) => x.score >= minScore)
    .sort((a, b) => b.score - a.score || Number(b.note.at) - Number(a.note.at))
    .slice(0, n)
    .map((x) => ({ ...x.note, score: Number(x.score.toFixed(2)) }));
}

/** 被用到就给这条加分（衰减曲线里「用得上」是最强的信号） */
export async function touch(ids = [], { at = Date.now(), boost = 0.08 } = {}) {
  const set = new Set(ids.filter(Boolean));
  if (!set.size) return 0;
  const db = await load();
  let n = 0;
  for (const note of db.notes) {
    if (!set.has(note.id)) continue;
    note.importance = Math.min(1, Number(note.importance ?? 0.5) + boost);
    note.lastUsedAt = at;
    note.usedCount = Number(note.usedCount ?? 0) + 1;
    n += 1;
  }
  if (n) await writeJson(FILE, { ...db, notes: db.notes });
  return n;
}

/**
 * 遗忘曲线 + 归档：importance 按天衰减，30 天没被用到且分数低于阈值的挪进 archive/。
 * 不删除（万一以后要翻旧账）。
 */
export async function decayAndArchive({ now = Date.now() } = {}) {
  const db = await load();
  const archived = [];
  const kept = [];
  for (const note of db.notes) {
    const ageDays = Math.max(0, (now - Number(note.at || now)) / day);
    const sinceUse = Math.max(0, (now - Number(note.lastUsedAt || 0)) / day);
    const importance = Math.max(0, Number(note.importance ?? 0.5) - ageDays * DECAY_PER_DAY);
    note.importance = Number(importance.toFixed(3));
    if (sinceUse > ARCHIVE_AFTER_DAYS && importance < ARCHIVE_BELOW) archived.push(note);
    else kept.push(note);
  }
  if (!archived.length) {
    await writeJson(FILE, { ...db, notes: kept });
    return { archived: 0, kept: kept.length };
  }
  const { mkdir, appendFile } = await import('node:fs/promises');
  const { join, dirname } = await import('node:path');
  const archiveDir = join(dirname(FILE), 'archive');
  await mkdir(archiveDir, { recursive: true });
  const d = new Date(now);
  const name = `semantic-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.jsonl`;
  const body = archived.map((n) => JSON.stringify(n)).join('\n') + '\n';
  await appendFile(join(archiveDir, name), body, 'utf8');
  await writeJson(FILE, { ...db, notes: kept });
  return { archived: archived.length, kept: kept.length, file: join(archiveDir, name) };
}

/** 定点删除：`/忘记 空调` → 删掉含该词的条目（返回删了几条） */
export async function forget(keyword) {
  const q = clean(keyword).toLowerCase();
  if (!q) return 0;
  const db = await load();
  const before = db.notes.length;
  db.notes = db.notes.filter((n) => !String(n.text ?? '').toLowerCase().includes(q));
  const removed = before - db.notes.length;
  if (removed) await writeJson(FILE, { ...db, notes: db.notes });
  return removed;
}

/**
 * 给 system prompt 的一段背景（没有就返回空串）。
 * 多来源合并（空间 / B 站 / 抖音），按时间倒序，总长不超过 PROMPT_MAX。
 */
export async function seenBrief({
  kinds = ['qzone', 'bilibili', 'douyin'],
  n = 6,
  maxChars = PROMPT_MAX,
} = {}) {
  const db = await load();
  const pool = db.notes.filter((x) => kinds.includes(x.kind) && x.importance >= 0.1);
  if (!pool.length) return '';
  const list = [...pool].sort((a, b) => Number(b.at) - Number(a.at)).slice(0, n);
  const lines = [];
  let used = 0;
  for (const note of list) {
    const line = `- ${md(note.at)}：${note.text}`;
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length;
  }
  if (!lines.length) return '';
  return (
    '\n\n【你最近看到的】下面是你自己刷到、看到过的事（主人的说说、B 站热门、抖音热搜），' +
    '聊天时最多顺口提一条、还得跟当前话题真相关才提；**别汇报、别列清单、别当新闻播报**：\n' +
    lines.join('\n')
  );
}

/** 兼容旧调用：只看某一类来源 */
export async function notesBrief(kind = 'qzone', n = 5) {
  return seenBrief({ kinds: [kind], n });
}

export { FILE as SEMANTIC_FILE, PROMPT_MAX };
