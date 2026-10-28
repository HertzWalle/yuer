/**
 * 说话人画像。
 *
 * 群里最伤沉浸感的两件事：把群友叫成「主人」、把 QQ 号当名字念。群名片解决了「叫什么」，
 * 但「这人平时怎么说话、爱聊什么」没人记。这里用零成本统计（不调模型）给每个人攒一份小档案，
 * 聊天时按人注入两三行，模型就知道「搬砖king 说话短、爱用草」而不是把他当陌生人。
 *
 * 只存统计特征，不存正文：avgLen（平均字数）、top 词、是否爱 @ 人、最后出现时间。
 */
import { readJson, writeJson, PATHS } from './store.mjs';

const KEEP_PER_CONV = 60;
const WORDS_PER_PROFILE = 8;
const STOP = new Set([
  '的', '了', '吗', '呢', '啊', '吧', '呀', '哦', '嗯', '是', '不', '我', '你', '他', '她', '它',
  '这', '那', '什么', '怎么', '就是', '不是', '没有', '可以', '一个', '我们', '你们', '他们',
  '现在', '然后', '还是', '但是', '因为', '所以', '这个', '那个', '真的', '确实', '有点',
]);

const keyOf = (conv, userId) => `${conv}:${userId}`;

function cleanWords(text) {
  const out = [];
  // 只取中文/英文串，够长才当词
  const parts = String(text || '').match(/[\u4e00-\u9fa5]{2,4}|[a-zA-Z]{3,12}/g) ?? [];
  for (const p of parts) {
    if (STOP.has(p)) continue;
    out.push(p);
  }
  // 中文没有空格，4 字截断经常把「显卡又涨价」这种整段当词，
  // 再补一层二元组，让「显卡」这种真正的关键词能被数到次数。
  for (const run of String(text || '').match(/[\u4e00-\u9fa5]{3,}/g) ?? []) {
    for (let i = 0; i + 2 <= run.length; i += 1) {
      const bi = run.slice(i, i + 2);
      if (!STOP.has(bi)) out.push(bi);
    }
  }
  return out;
}

export async function loadProfiles() {
  const db = await readJson(PATHS.profiles, { version: 1, byKey: {} });
  if (!db || typeof db !== 'object') return { version: 1, byKey: {} };
  if (!db.byKey || typeof db.byKey !== 'object') db.byKey = {};
  return db;
}

/** 每条消息都能调：只做本地加法，不联网 */
export async function noteSpeaker({ conv = '', userId = '', name = '', text = '', at = Date.now() } = {}) {
  if (!conv || !userId) return { ok: false, reason: 'bad-request' };
  const db = await loadProfiles();
  const k = keyOf(conv, userId);
  const p = db.byKey[k] || {
    name: '',
    aliases: [],
    msgs: 0,
    avgLen: 0,
    atCount: 0,
    words: {},
    lastSeen: 0,
  };
  const label = String(name || '').trim();
  if (label && label !== p.name) {
    if (p.name) {
      p.aliases = [p.name, ...p.aliases.filter((a) => a !== p.name)].slice(0, 2);
    } else {
      p.aliases = p.aliases || [];
    }
    p.name = label;
  }
  const len = [...String(text || '')].length;
  p.msgs = Number(p.msgs || 0) + 1;
  p.avgLen = Math.round((Number(p.avgLen || 0) * (p.msgs - 1) + len) / p.msgs);
  if (/@\S/.test(String(text || ''))) p.atCount = Number(p.atCount || 0) + 1;
  for (const w of cleanWords(text)) {
    p.words[w] = (Number(p.words[w]) || 0) + 1;
  }
  // 词表只留前 N，别让 json 越长越大；出现一次的先留着（二元组要靠累计次数）
  const ordered = Object.entries(p.words).sort((a, b) => b[1] - a[1]).slice(0, WORDS_PER_PROFILE * 3);
  p.words = Object.fromEntries(ordered);
  p.lastSeen = at;
  db.byKey[k] = p;

  // 每个会话只留最近活跃的 KEEP_PER_CONV 个
  const sameConv = Object.keys(db.byKey).filter((x) => x.startsWith(conv + ':'));
  if (sameConv.length > KEEP_PER_CONV) {
    sameConv
      .sort((a, b) => (db.byKey[a].lastSeen || 0) - (db.byKey[b].lastSeen || 0))
      .slice(0, sameConv.length - KEEP_PER_CONV)
      .forEach((x) => delete db.byKey[x]);
  }
  await writeJson(PATHS.profiles, db);
  return { ok: true, profile: p };
}

/** 把画像压成两三行提示；没攒够就返回空串 */
export async function profileBrief({ conv = '', userId = '', name = '' } = {}) {
  const db = await loadProfiles();
  const p = db.byKey[keyOf(conv, userId)];
  if (!p || Number(p.msgs) < 3) return '';
  const tags = [];
  if (p.avgLen && p.avgLen <= 12) tags.push('说话短');
  else if (p.avgLen >= 45) tags.push('话比较多');
  const hot = Object.entries(p.words || {}).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const words = hot.length ? `常提：${hot.map(([w]) => w).join('、')}` : '';
  if (p.atCount >= Math.max(3, p.msgs * 0.3)) tags.push('爱 @ 人');
  const alias = Array.isArray(p.aliases) && p.aliases.length ? `（也被叫「${p.aliases[0]}」）` : '';
  const lines = [`【说话的人】${name || p.name}${alias}`];
  const desc = [tags.join('、'), words].filter(Boolean).join('；');
  if (desc) lines.push(`- ${desc}`);
  if (p.lastSeen) {
    const d = new Date(p.lastSeen);
    lines.push(`- 上次说话：${d.getMonth() + 1}月${d.getDate()}日`);
  }
  return '\n\n' + lines.join('\n');
}

/** /画像 用：某个会话里最活跃的几个人 */
export async function topProfiles(conv = '', n = 10) {
  const db = await loadProfiles();
  const list = Object.entries(db.byKey)
    .filter(([k]) => k.startsWith(conv + ':'))
    .map(([k, p]) => ({ userId: k.slice(conv.length + 1), ...p }))
    .sort((a, b) => (b.msgs || 0) - (a.msgs || 0))
    .slice(0, Math.max(1, Math.min(30, Number(n) || 10)));
  return list.map((p) => ({
    userId: p.userId,
    name: p.name || p.userId,
    msgs: p.msgs || 0,
    avgLen: p.avgLen || 0,
    words: Object.keys(p.words || {}).slice(0, 3),
    lastSeen: p.lastSeen || 0,
  }));
}
