/**
 * 群聊「注意力」状态：每个群一套冲动 / 反感度 / 冷却。
 *
 * 为什么要单独一份状态：群里和私聊完全是两种场合。
 * 私聊的冲动是「想不想跟主人说话」，群里的冲动是「现在插一句合不合适」——
 * 后者必须额外看三件事：群里正在聊什么、有没有人烦、上一条是不是刚说完。
 *
 * 存 data/groups.json：
 *   { version, day, groups: { "group:123": { impulse, annoyance, lastMessageAt, lastSpokeAt,
 *     sentToday, cooldownUntil, lastTopicAt, lastPositiveAt, afterSpeak: { at, count } } } }
 *
 * 原则同 agency：**能不能说由代码判定**（阈值、日上限、间隔、冷却、反感度），
 * 模型只决定「说什么」和旁听评分。
 */

import { PATHS, readJson, writeJson } from './store.mjs';

export const GROUP_DEFAULTS = {
  /** 群里的冲动攒得比私聊慢：私聊 6/h，群聊 3/h */
  ratePerHour: 3,
  /** 群里开口的门槛更高（私聊 70） */
  threshold: 120,
  /** 开口一次扣得多（私聊 45） */
  cost: 120,
  /** 每个群每天最多冒泡 1 次 */
  dailyPerGroup: 1,
  /** 同一个群两次冒泡至少隔 6 小时 */
  minGapHours: 6,
  /** 旁听评分阈值：低于这个分就不插话 */
  scoreMin: 7,
  /** 至少积累了这么多条消息才考虑开口 */
  bufferMin: 3,
  /** 旁听缓冲保留多少条 */
  bufferMax: 30,
  /** 一条普通消息加多少冲动 */
  perMessage: 2,
  /** 被 @ 到加多少（等同于「有人在问我」） */
  mentionBonus: 20,
  /** 话题命中她记得的事，加多少 */
  topicBonus: 15,
  /** 气氛正向（哈哈哈/牛/厉害…），加多少 */
  positiveBonus: 5,
  /** 反感度每小时自然衰减 */
  annoyanceDecayPerHour: 2,
  /** 冲动没用时会慢慢消退（安静的群不该攒到爆炸） */
  impulseDecayPerHour: 1.5,
};

const dayKey = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

function blankGroup() {
  return {
    impulse: 0,
    annoyance: 0,
    lastMessageAt: 0,
    lastSpokeAt: 0,
    sentToday: 0,
    cooldownUntil: 0,
    lastTopicAt: 0,
    lastPositiveAt: 0,
    /** 说完之后群里又说了几句（用来判断「是不是没人接」） */
    afterSpeak: { at: 0, count: 0 },
    /** 今天已经说过的话题，避免反复提同一件事 */
    said: [],
  };
}

export async function loadGroups(now = new Date()) {
  const raw = await readJson(PATHS.groups, null);
  const base = { version: 1, day: dayKey(now), groups: {} };
  if (!raw || typeof raw !== 'object') return base;
  return {
    ...base,
    ...raw,
    groups: raw.groups && typeof raw.groups === 'object' ? raw.groups : {},
  };
}

export async function saveGroups(db) {
  // 注意：writeJson 自己已经走 store 的串行锁，这里再包一层 withLock 会自锁死
  return writeJson(PATHS.groups, db);
}

export function groupState(db, conv, now = new Date()) {
  if (!db.groups[conv]) db.groups[conv] = blankGroup();
  const g = db.groups[conv];
  for (const [k, v] of Object.entries(blankGroup())) if (g[k] === undefined) g[k] = v;
  if (db.day !== dayKey(now)) {
    db.day = dayKey(now);
    for (const x of Object.values(db.groups)) {
      x.sentToday = 0;
      x.said = [];
    }
  }
  return g;
}

/** 显式制止：直接压住这个群 */
const STOP_WORDS = /(别(说|吵|冒|插)|闭嘴|安静(点|一下)?|烦不烦|滚|少说两句|不要说话|别来|消停)/;
/** 抱怨/反感：比制止轻，但也降欲望 */
const COMPLAIN_WORDS = /(机器人|AI|人机|营销号|怎么老是|又来了|谁拉进来的|谁加进来的|烦死|吵死|刷屏)/;

/** 从一句话里判断「是不是有人不高兴了」 */
export function annoyanceOf(text, { atBot = false } = {}) {
  const s = String(text ?? '');
  if (STOP_WORDS.test(s)) return atBot ? 40 : 30;
  if (COMPLAIN_WORDS.test(s)) return 20;
  return 0;
}

const POSITIVE = /(哈哈|笑死|好耶|厉害|牛啊|牛批|太强|好评|谢谢|爱你|可爱)/;

/** 群里的时间流逝：冲动按速率涨（只在 30 分钟内有活动时），反感度缓慢回落 */
export function decayGroup(g, now, opts = {}, { active = false } = {}) {
  const o = { ...GROUP_DEFAULTS, ...opts };
  const last = Number(g.lastDecayAt || g.lastMessageAt || now.getTime());
  const dtH = Math.min(3, Math.max(0, (now.getTime() - last) / 3_600_000));
  if (dtH > 0) {
    if (active) g.impulse = Math.min(150, Number(g.impulse || 0) + Number(o.ratePerHour) * dtH);
    g.impulse = Math.max(0, Number(g.impulse || 0) - Number(o.impulseDecayPerHour) * dtH);
    g.annoyance = Math.max(0, Number(g.annoyance || 0) - Number(o.annoyanceDecayPerHour) * dtH);
  }
  g.lastDecayAt = now.getTime();
  return g;
}

/**
 * 群里来了新消息：加冲动、判反感、记「说完之后有没有人接」。
 * 被 @ 的消息不进这里（那是正常回复，不算「插话」的素材）。
 */
export function noteGroupMessage(db, { conv, text, atBot = false, now = new Date(), keywords = [], opts = {} }) {
  const o = { ...GROUP_DEFAULTS, ...opts };
  const g = groupState(db, conv, now);
  const prevMsgAt = Number(g.lastMessageAt || 0);
  g.lastMessageAt = now.getTime();

  // 上次冒泡之后，别人又说了几句（超过 3 分钟、且已经有 2 句以上 → 说明没人接她的茬）
  if (g.afterSpeak?.at && now.getTime() - g.afterSpeak.at < 10 * 60_000 && !atBot) {
    g.afterSpeak.count = Number(g.afterSpeak.count || 0) + 1;
  }

  const bad = annoyanceOf(text, { atBot });
  if (bad) {
    g.annoyance = Math.min(200, Number(g.annoyance || 0) + bad);
  }

  let gain = Number(o.perMessage);
  const reasons = ['msg'];
  if (atBot) {
    gain += Number(o.mentionBonus);
    reasons.push('mention');
  }
  const hit = keywords.find((k) => k && String(text).includes(k));
  if (hit && now.getTime() - Number(g.lastTopicAt || 0) > 30 * 60_000) {
    gain += Number(o.topicBonus);
    g.lastTopicAt = now.getTime();
    reasons.push('topic:' + hit);
  }
  if (POSITIVE.test(String(text)) && now.getTime() - Number(g.lastPositiveAt || 0) > 5 * 60_000) {
    gain += Number(o.positiveBonus);
    g.lastPositiveAt = now.getTime();
    reasons.push('positive');
  }
  g.impulse = Math.min(150, Number(g.impulse || 0) + gain);
  g.lastDecayAt = now.getTime();
  void prevMsgAt;
  return { gain, reasons, annoyance: g.annoyance };
}

/**
 * 现在能不能在这个群说一句？返回 { ok, reason }。
 * 全部是硬门槛，任何一个不满足就闭嘴——这是「不招人烦」的底线。
 */
export function canSpeakGroup(db, conv, { now = new Date(), quiet = {}, sinceLastInboundMs = null, opts = {} } = {}) {
  const o = { ...GROUP_DEFAULTS, ...opts };
  const g = groupState(db, conv, now);

  if (Number(g.cooldownUntil || 0) > now.getTime()) return { ok: false, reason: 'cooldown', g };
  if (inQuiet(now, quiet)) return { ok: false, reason: 'quiet-hours', g };
  if (Number(g.impulse || 0) < Number(o.threshold)) return { ok: false, reason: 'impulse-low', g };
  if (Number(g.sentToday || 0) >= Number(o.dailyPerGroup)) return { ok: false, reason: 'daily-limit', g };
  if (g.lastSpokeAt && now.getTime() - Number(g.lastSpokeAt) < Number(o.minGapHours) * 3_600_000) {
    return { ok: false, reason: 'min-gap', g };
  }
  if (Number(g.annoyance || 0) >= 60) return { ok: false, reason: 'annoyed', g };
  // 群里刚被 @ 过、她已经在说话，就别再自己插话（避免同一分钟两条）
  if (sinceLastInboundMs !== null && sinceLastInboundMs < 60_000) return { ok: false, reason: 'just-replied', g };
  return { ok: true, reason: 'ok', g };
}

function inQuiet(now, quiet) {
  const parse = (s, d) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim());
    return m ? Number(m[1]) * 60 + Number(m[2]) : d;
  };
  const start = parse(quiet?.start, 23 * 60 + 30);
  const end = parse(quiet?.end, 7 * 60 + 30);
  const cur = now.getHours() * 60 + now.getMinutes();
  return start <= end ? cur >= start && cur < end : cur >= start || cur < end;
}

/** 说完之后调一次：记时间、扣冲动、计次、开「等人接茬」窗口 */
export function markGroupSpoke(db, conv, { now = new Date(), text = '', opts = {} } = {}) {
  const o = { ...GROUP_DEFAULTS, ...opts };
  const g = groupState(db, conv, now);
  g.impulse = Math.max(0, Number(g.impulse || 0) - Number(o.cost));
  g.sentToday = Number(g.sentToday || 0) + 1;
  g.lastSpokeAt = now.getTime();
  g.afterSpeak = { at: now.getTime(), count: 0 };
  g.said = [...(g.said || []).slice(-9), String(text).slice(0, 40)];
  return g;
}

/** 说完之后过了 3 分钟，群里冒出了 2 句以上却没人理她 → 记反感 */
export function settleAfterSpeak(g, now = new Date()) {
  const a = g.afterSpeak;
  if (!a?.at) return 0;
  const dt = now.getTime() - Number(a.at);
  if (dt < 3 * 60_000 || dt > 30 * 60_000) return 0;
  if (Number(a.count || 0) >= 2) {
    g.annoyance = Math.min(200, Number(g.annoyance || 0) + 10);
    g.afterSpeak = { at: 0, count: 0 };
    return 10;
  }
  return 0;
}

/** 反感度上来了就自动冷却（60→12 小时，100→7 天），不改参数只改行为 */
export function applyAnnoyanceCooldown(g, now = new Date()) {
  const a = Number(g.annoyance || 0);
  if (a >= 100) {
    g.cooldownUntil = Math.max(Number(g.cooldownUntil || 0), now.getTime() + 7 * 24 * 3_600_000);
    g.impulse = 0;
    return '7d';
  }
  if (a >= 60) {
    g.cooldownUntil = Math.max(Number(g.cooldownUntil || 0), now.getTime() + 12 * 3_600_000);
    g.impulse = 0;
    return '12h';
  }
  return '';
}
