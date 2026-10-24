/**
 * 承诺系统：她答应过的事（「晚上问你考得怎么样」这种）。
 *
 * 为什么单独一个文件：这是「陪伴感」里最值钱的部分——**说到做到**比任何早安都更像有人惦记。
 * 所以它有两个硬约束：
 *  1) 到期扫描不走冲动阈值（冲动是「想不想说话」，承诺是「该不该兑现」，后者优先级更高）；
 *  2) 未兑现要记账（missed），下次更谨慎，而不是无限答应。
 *
 * 抽取走一次便宜的 LLM 调用，但先用正则粗筛——没时间词的消息根本不值得调模型。
 */

import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { PATHS, readJson, withLock } from './store.mjs';
import { chatCompletion } from './llm.mjs';

const FILE = join(PATHS.dataDir, 'commitments.json');
const MAX_ITEMS = 300;
/** 只看 14 天内的承诺，再远的东西现在存下来只会变成噪音 */
const MAX_HORIZON_MS = 14 * 24 * 3_600_000;

/** 粗筛：出现这些词才值得调用模型（省一半以上的 token） */
const CUE = /(提醒|记得|别忘|叫我|喊我|到点|明天|后天|今晚|早上|中午|下午|晚上|周末|点整|\d+\s*点|一会儿|待会儿|等会|下周|考试|面试|体检|吃药|吃饭|睡觉|下班|开会|出成绩|结果|截止)/;

const p2 = (n) => String(n).padStart(2, '0');
const stamp = (d) =>
  `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;

export async function loadCommitments() {
  const raw = await readJson(FILE, null);
  const items = Array.isArray(raw?.items) ? raw.items : [];
  return { version: 1, items: items.filter((x) => x && x.id) };
}

/** 读-改-写：全程在一条串行队列里，避免和别的写者交叉 */
export async function mutate(fn) {
  return withLock(async () => {
    const db = await loadCommitments();
    const out = await fn(db);
    db.items = db.items.slice(-MAX_ITEMS);
    await mkdir(PATHS.dataDir, { recursive: true });
    const tmp = FILE + '.tmp-' + process.pid + '-' + Date.now();
    await writeFile(tmp, JSON.stringify(db, null, 2), 'utf8');
    await rename(tmp, FILE);
    return out;
  });
}

export async function addCommitment({ what, dueAt, conv, evidence = '' }) {
  const item = {
    id: `c-${stamp(new Date())}-${Math.random().toString(36).slice(2, 6)}`,
    what: String(what || '').trim(),
    dueAt: new Date(dueAt).toISOString(),
    conv: conv || '',
    evidence: String(evidence || '').slice(0, 200),
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  await mutate((db) => {
    db.items.push(item);
    return item;
  });
  return item;
}

export function openItems(db) {
  return (db?.items ?? []).filter((x) => x.status === 'pending');
}

/** 到点（含提前 leadMs）的承诺；错过太久（>6h）的直接标 missed，不再补发 */
export async function dueSoon(now = new Date(), leadMs = 20 * 60_000) {
  const db = await loadCommitments();
  const t = now.getTime();
  const due = [];
  const stale = [];
  for (const item of openItems(db)) {
    const at = Date.parse(item.dueAt);
    if (!Number.isFinite(at)) {
      stale.push(item.id);
      continue;
    }
    if (at < t - 6 * 3_600_000) stale.push(item.id);
    else if (at <= t + leadMs) due.push(item);
  }
  if (stale.length) {
    await mutate((d) => {
      for (const it of d.items) {
        if (stale.includes(it.id) && it.status === 'pending') {
          it.status = 'missed';
          it.note = '过期未兑现';
        }
      }
    });
  }
  return due.sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
}

export async function markStatus(id, status, extra = {}) {
  return mutate((db) => {
    const it = db.items.find((x) => x.id === id);
    if (!it) return null;
    it.status = status;
    Object.assign(it, extra, { [status + 'At']: new Date().toISOString() });
    return it;
  });
}

/** 抽取 JSON：容忍 ```json 围栏与模型多说的废话 */
function pickJsonArray(text) {
  const s = String(text || '');
  const a = s.indexOf('[');
  const b = s.lastIndexOf(']');
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(s.slice(a, b + 1));
  } catch {
    return null;
  }
}

/**
 * 从一轮对答里抽取「她答应了什么」。
 * @returns {Promise<Array<{what: string, dueAt: string}>>} 抽不到返回 []
 */
export async function extractCommitments({ userText, replyText, now = new Date(), conv = '' }) {
  const said = `${userText}\n${replyText}`;
  if (!CUE.test(said)) return [];
  if (String(userText).trim().length < 2) return [];

  const iso = now.toISOString();
  const messages = [
    {
      role: 'system',
      content: [
        '你是一个严谨的信息抽取器。任务：从一段 QQ 对话里找出「她明确答应主人、且带时间的事」。',
        '只输出 JSON 数组，不要解释、不要代码围栏。没有符合条件的就输出 []。',
        '每个元素：{"what":"要兑现的动作（一句话，第一人称，比如’问主人考试结果’）","when":"ISO 8601 时间（带时区偏移）"}',
        '规则：',
        '1) 必须是她真的答应了（“好呀/我到时候问你/一定提醒你”），只是客套或不确定的不算；',
        '2) 必须有可推断的时间；没有时间的不抽；',
        '3) 时间必须晚于现在、且在 14 天内；已经过去的不要；',
        '4) 最多 2 条；宁缺毋滥。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `当前时间：${iso}\n\n主人说：${userText}\n\n她回答：${replyText}`,
    },
  ];

  const res = await chatCompletion(messages, { temperature: 0.2, maxTokens: 300, timeoutMs: 30_000 });
  if (!res.ok) return [];
  const arr = pickJsonArray(res.text);
  if (!Array.isArray(arr)) return [];

  const out = [];
  for (const raw of arr.slice(0, 2)) {
    const what = String(raw?.what ?? '').trim();
    const when = String(raw?.when ?? raw?.dueAt ?? '').trim();
    if (!what || !when) continue;
    const at = Date.parse(when);
    if (!Number.isFinite(at)) continue;
    const dt = at - now.getTime();
    if (dt < 2 * 60_000 || dt > MAX_HORIZON_MS) continue;
    out.push({ what, dueAt: new Date(at).toISOString() });
  }
  if (out.length) {
    for (const o of out) {
      await addCommitment({ ...o, conv, evidence: userText.slice(0, 160) });
    }
  }
  return out;
}

/** 给 /承诺 面板用的可读时间：今天 21:00 / 明天 09:00 / 10-26 14:30 */
export function humanTime(iso, now = new Date()) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = (n) => String(n).padStart(2, '0');
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOfDay(d) - startOfDay(now)) / 86_400_000);
  if (diffDays === 0) return `今天 ${hm}`;
  if (diffDays === 1) return `明天 ${hm}`;
  if (diffDays === 2) return `后天 ${hm}`;
  if (diffDays < 0) return `已过期 ${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`;
}
