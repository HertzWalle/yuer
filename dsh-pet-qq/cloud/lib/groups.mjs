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
  /* ---------- 按活跃度分档（v1.10.0）：热闹的群多说话，冷清的群偶尔开口 ---------- */

  /** 判活跃度用的滑动窗口（秒）与分档阈值（条/分钟） */
  activity: { windowSec: 300, upHoldSec: 180, downHoldSec: 900, hotPerMin: 6, normalPerMin: 1.2, quietPerMin: 0.2 },
  /** 每个群每天最多说多少条（热闹群上限 100，用户指定） */
  dailyLimit: { hot: 100, normal: 40, quiet: 20, dead: 6 },
  /** 每小时上限，防止一口气刷完 */
  hourLimit: { hot: 15, normal: 10, quiet: 4, dead: 2 },
  /** 两次开口的最小间隔（秒） */
  minGapSec: { hot: 75, normal: 240, quiet: 900, dead: 3600 },
  /** 机会分要到多少才值得开口（热闹档机会多、门槛低；死寂档只在真好聊时开口） */
  urgencyMin: { hot: 8, normal: 9, quiet: 10, dead: 13 },
  /** 她的话在同一小时内不超过群消息量的这个比例（防刷屏） */
  shareCap: 0.12,
  /** 群里安静多久算「冷清到可以主动开场」 */
  idleOpenMin: 25,
  /** 冷清群每小时主动开场的概率 */
  openerPerHour: { quiet: 1.5, dead: 0.8 },
  /** 回声率（她说话后 10 分钟内有人接的比例）对配额的影响 */
  echoBoost: 1.2,
  echoPenalty: 0.7,

  /* ---------- 旧参数：保留给冲动模型与兼容旧配置 ---------- */
  /** 群里的冲动攒得比私聊慢：私聊 6/h，群聊 3/h */
  ratePerHour: 6,
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
  perMessage: 3,
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
    /** 最近 60 分钟的消息时间戳（判活跃度 + 占群比用） */
    msgs: [],
    /** 当前活跃档位：hot / normal / quiet / dead，以及换档时间（迟滞用） */
    tier: '',
    tierSince: 0,
    /** 最近开口记录：{ at, replied } —— 回声率就是看这上面 replied 的比例 */
    spokeLog: [],
    /** 最近一次机会分（/心思 里显示，便于调参） */
    lastUrgency: 0,
  };
}

/** 档位排序：数字大 = 更热闹 */
const TIER_RANK = { dead: 0, quiet: 1, normal: 2, hot: 3 };
export const TIERS = ['dead', 'quiet', 'normal', 'hot'];

/** 记一条群消息的时间（判活跃度用），顺手把超过 1 小时的清掉 */
export function noteActivity(g, now = new Date()) {
  const ts = Number(now.getTime?.() ?? now) || Date.now();
  const arr = Array.isArray(g.msgs) ? g.msgs : [];
  arr.push(ts);
  const cutoff = ts - 60 * 60_000;
  g.msgs = arr.filter((x) => Number(x) >= cutoff).slice(-600);
  return g;
}

/** 最近 windowSec 秒的条/分钟 */
export function activityRate(g, now = new Date(), opts = {}) {
  const o = { ...GROUP_DEFAULTS, ...opts };
  const a = o.activity ?? GROUP_DEFAULTS.activity;
  const ts = Number(now.getTime?.() ?? now) || Date.now();
  const win = Number(a.windowSec) * 1000;
  const n = (g.msgs || []).filter((x) => ts - Number(x) <= win).length;
  return n / (Number(a.windowSec) / 60);
}

/**
 * 当前应该算什么档位。带迟滞：
 * - 往上升要「明显超过阈值」并且停够 upHoldSec，避免一热闹就狂说；
 * - 往下降要持续 downHoldSec，避免刚安静两分钟就装死。
 */
export function tierOf(g, now = new Date(), opts = {}) {
  const o = { ...GROUP_DEFAULTS, ...opts };
  const a = o.activity ?? GROUP_DEFAULTS.activity;
  const ts = Number(now.getTime?.() ?? now) || Date.now();
  const rate = activityRate(g, now, o);
  const desired =
    rate >= Number(a.hotPerMin) ? 'hot' : rate >= Number(a.normalPerMin) ? 'normal' : rate >= Number(a.quietPerMin) ? 'quiet' : 'dead';
  const cur = g.tier && TIER_RANK[g.tier] !== undefined ? g.tier : '';
  if (!cur) {
    g.tier = desired;
    g.tierSince = ts;
    return desired;
  }
  const since = ts - Number(g.tierSince || 0);
  if (TIER_RANK[desired] > TIER_RANK[cur]) {
    const margin = desired === 'hot' ? Number(a.hotPerMin) * 1.25 : 1;
    if (rate >= margin && since >= Number(a.upHoldSec) * 1000) {
      g.tier = desired;
      g.tierSince = ts;
    }
  } else if (TIER_RANK[desired] < TIER_RANK[cur] && since >= Number(a.downHoldSec) * 1000) {
    g.tier = desired;
    g.tierSince = ts;
  }
  return g.tier || desired;
}

/** 回声率：最近 10 次开口里，有多少次 10 分钟内被人接住（没记录时按 0.5 处理） */
export function echoRateOf(g, now = new Date()) {
  const ts = Number(now.getTime?.() ?? now) || Date.now();
  const log = (g.spokeLog || []).filter((x) => ts - Number(x.at || 0) <= 24 * 3_600_000).slice(-10);
  if (!log.length) return 0.5;
  return log.filter((x) => x.replied).length / log.length;
}

/**
 * 今天的配额。日上限是硬的（用户指定：热闹群最多 100 条/天），
 * 回声率只调节**节奏**（每小时能说几句），不越过年上限。
 */
export function quotaOf(g, now = new Date(), opts = {}) {
  const o = { ...GROUP_DEFAULTS, ...opts };
  const tier = tierOf(g, now, o);
  const daily = Math.max(1, Number((o.dailyLimit ?? GROUP_DEFAULTS.dailyLimit)[tier] ?? 3));
  const hourBase = Math.max(1, Number((o.hourLimit ?? GROUP_DEFAULTS.hourLimit)[tier] ?? 1));
  const echo = echoRateOf(g, now);
  const factor = echo >= 0.5 ? Number(o.echoBoost) : echo <= 0.2 ? Number(o.echoPenalty) : 1;
  return { tier, daily, hourly: Math.min(hourBase, Math.max(1, Math.round(hourBase * factor))), echo };
}

/** 最近一小时的开口次数与群消息条数（算占群比） */
function lastHour(g, now, opts = {}) {
  const o = { ...GROUP_DEFAULTS, ...opts };
  const ts = Number(now.getTime?.() ?? now) || Date.now();
  const spoke = (g.spokeLog || []).filter((x) => ts - Number(x.at || 0) <= 3_600_000).length;
  const msgs = (g.msgs || []).filter((x) => ts - Number(x) <= 3_600_000).length;
  return { spoke, msgs, cap: Number(o.shareCap) };
}

/**
 * 机会分：这条消息值不值得开口。
 * 只是「值不值」的排序依据，真正的闸门仍然在 canSpeakGroup 里。
 */
export function urgencyOf(g, { atBot = false, scored = {}, now = new Date(), opts = {} } = {}) {
  const o = { ...GROUP_DEFAULTS, ...opts };
  const tier = tierOf(g, now, o);
  const reasons = scored.reasons || [];
  let u = 5;
  if (atBot || reasons.includes('mention')) u += 20;
  if (reasons.some((r) => r.startsWith('topic'))) u += 6;
  if (reasons.includes('positive')) u += 2;
  if (g.lastSpokeAt && now.getTime() - Number(g.lastSpokeAt) < 10 * 60_000) u += 6; // 她刚说完、话头还在
  u -= Number(g.annoyance || 0) * 0.15;
  g.lastUrgency = Math.max(0, Math.round(u));
  return { urgency: g.lastUrgency, tier, need: Number((o.urgencyMin ?? GROUP_DEFAULTS.urgencyMin)[tier] ?? 11) };
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
  noteActivity(g, now);

  // 她刚才说完、10 分钟内有人接话 → 记一次「回声」，用来判断她在群里说得好不好使
  const lastSpoke = (g.spokeLog || [])[(g.spokeLog || []).length - 1];
  if (lastSpoke && !lastSpoke.replied && !atBot && now.getTime() - Number(lastSpoke.at || 0) <= 10 * 60_000) {
    lastSpoke.replied = true;
  }

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
  return { gain, reasons, annoyance: g.annoyance, tier: tierOf(g, now, o), urgency: Number(g.lastUrgency || 0) };
}

/**
 * 现在能不能在这个群说一句？返回 { ok, reason }。
 * 全部是硬门槛，任何一个不满足就闭嘴——这是「不招人烦」的底线。
 */
export function canSpeakGroup(db, conv, { now = new Date(), quiet = {}, sinceLastInboundMs = null, opts = {} } = {}) {
  const o = { ...GROUP_DEFAULTS, ...opts };
  const g = groupState(db, conv, now);
  const q = quotaOf(g, now, o);
  const gap = Number((o.minGapSec ?? GROUP_DEFAULTS.minGapSec)[q.tier] ?? 300) * 1000;
  const hour = lastHour(g, now, o);

  const deny = (reason) => ({ ok: false, reason, g, tier: q.tier, quota: q, hour, gapSec: Math.round(gap / 1000) });

  if (Number(g.cooldownUntil || 0) > now.getTime()) return deny('cooldown');
  if (inQuiet(now, quiet)) return deny('quiet-hours');
  if (Number(g.annoyance || 0) >= 60) return deny('annoyed');
  if (Number(g.sentToday || 0) >= q.daily) return deny('daily-limit');
  if (hour.spoke >= q.hourly) return deny('hour-limit');
  if (g.lastSpokeAt && now.getTime() - Number(g.lastSpokeAt) < gap) return deny('min-gap');
  // 占群比：她一小时内说的话不能超过群消息量的 shareCap（群里冷清时再放宽到至少 1 条）
  if (hour.msgs >= 8 && hour.spoke >= Math.max(1, Math.floor(hour.msgs * Number(o.shareCap)))) return deny('share-cap');
  // 机会分不够：热闹的群 9 分，死寂的群 18 分
  if (Number(g.lastUrgency || 0) < Number((o.urgencyMin ?? GROUP_DEFAULTS.urgencyMin)[q.tier] ?? 11)) return deny('low-urgency');
  // 群里刚被 @ 过、她已经在说话，就别再自己插话（避免同一分钟两条）
  if (sinceLastInboundMs !== null && sinceLastInboundMs < 60_000) return deny('just-replied');
  return { ok: true, reason: 'ok', g, tier: q.tier, quota: q, hour, gapSec: Math.round(gap / 1000) };
}

/** 主动开场（冷清群用）：只看「够不够安静 / 配额 / 间隔 / 概率」，不看机会分 */
export function canOpenGroup(db, conv, { now = new Date(), quiet = {}, opts = {}, roll = Math.random } = {}) {
  const o = { ...GROUP_DEFAULTS, ...opts };
  const g = groupState(db, conv, now);
  const q = quotaOf(g, now, o);
  if (q.tier !== 'quiet' && q.tier !== 'dead') return { ok: false, reason: 'too-lively', tier: q.tier };
  if (Number(g.cooldownUntil || 0) > now.getTime()) return { ok: false, reason: 'cooldown', tier: q.tier };
  if (inQuiet(now, quiet)) return { ok: false, reason: 'quiet-hours', tier: q.tier };
  if (Number(g.annoyance || 0) >= 40) return { ok: false, reason: 'annoyed', tier: q.tier };
  if (Number(g.sentToday || 0) >= q.daily) return { ok: false, reason: 'daily-limit', tier: q.tier };
  const idleMs = Number(o.idleOpenMin) * 60_000;
  if (!g.lastMessageAt || now.getTime() - Number(g.lastMessageAt) < idleMs) return { ok: false, reason: 'too-recent', tier: q.tier };
  const gap = Number((o.minGapSec ?? GROUP_DEFAULTS.minGapSec)[q.tier] ?? 1800) * 1000;
  if (g.lastSpokeAt && now.getTime() - Number(g.lastSpokeAt) < gap) return { ok: false, reason: 'min-gap', tier: q.tier };
  const p = Number((o.openerPerHour ?? GROUP_DEFAULTS.openerPerHour)[q.tier] ?? 0);
  if (roll() >= p) return { ok: false, reason: 'coin', tier: q.tier };
  return { ok: true, reason: 'ok', g, tier: q.tier, quota: q };
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
  g.spokeLog = [...(g.spokeLog || []).slice(-19), { at: now.getTime(), replied: false }];
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
