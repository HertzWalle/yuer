/**
 * 「心思」状态：冲动值、心情、规则、暂停开关。
 *
 * 存在 data/state.json 的 `agency` 字段里——和 dsh-pet 的 `pets.<id>.say` 气泡共存，
 * 一个文件两套数据，备份拉回桌面端也不会互相踩。
 *
 * 设计原则：
 *  - **硬开关与软情绪分开**：pausedUntil / rules 是代码层直接生效的，mood 只影响文案与速率；
 *  - mood 是慢变量，每小时向基线回归，避免一次夸赞就飘一天；
 *  - 冲动按「上次 tick 到现在」的时间差累积，进程重启不会凭空暴涨（单次最多补 2 小时）。
 */

import { PATHS, loadState, writeJson } from './store.mjs';

/** 心情基线：valence 愉悦度 -1..1、arousal 精神 0..1、clingy 黏人 0..1 */
export const MOOD_BASE = { valence: 0.2, arousal: 0.4, clingy: 0.4 };

/** 冲动的天花板：够触发两次还富余，但不至于无限堆 */
export const IMPULSE_CAP = 120;

const dayKey = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

export function defaultAgency(now = new Date()) {
  return {
    version: 1,
    mood: { ...MOOD_BASE },
    impulse: { owner: 0 },
    counters: { day: dayKey(now), ownerSent: 0 },
    lastTickAt: now.getTime(),
    lastInboundAt: 0,
    lastProactiveAt: 0,
    /** 最近一次主动消息发出后等回应的记录：{ at, conv, text } */
    awaiting: null,
    /** 连续被冷落的次数：用来逐渐降低说话欲望 */
    misses: 0,
    /** 暂停主动到什么时候（毫秒时间戳），0 = 没暂停 */
    pausedUntil: 0,
    /** 主人训话沉淀成的规则（文本，只做记录与展示；真正生效靠 pausedUntil / 群侧参数） */
    rules: [],
  };
}

/** 读心思状态（缺失字段一律补默认值，旧文件永远可用） */
export async function loadAgency(now = new Date()) {
  const state = await loadState();
  const raw = state?.agency && typeof state.agency === 'object' ? state.agency : {};
  const base = defaultAgency(now);
  return {
    ...base,
    ...raw,
    mood: { ...base.mood, ...(raw.mood || {}) },
    impulse: { ...base.impulse, ...(raw.impulse || {}) },
    counters: { ...base.counters, ...(raw.counters || {}) },
    rules: Array.isArray(raw.rules) ? raw.rules : [],
  };
}

/** 只覆盖 state.json 的 agency 字段，pets 气泡不动 */
export async function saveAgency(agency) {
  const state = await loadState();
  state.agency = agency;
  await writeJson(PATHS.state, state);
}

export function parseHm(s, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim());
  if (!m) return fallback;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return fallback;
  return h * 60 + min;
}

/** 静默时段（支持跨零点，如 23:30–07:30） */
export function inQuietHours(now, quiet) {
  const start = parseHm(quiet?.start, 23 * 60 + 30);
  const end = parseHm(quiet?.end, 7 * 60 + 30);
  const m = now.getHours() * 60 + now.getMinutes();
  return start <= end ? m >= start && m < end : m >= start || m < end;
}

/** 跨天时把今日计数清零 */
export function resetDailyCounter(agency, now) {
  const today = dayKey(now);
  if (agency.counters.day !== today) {
    agency.counters = { day: today, ownerSent: 0 };
  }
  return agency;
}

/**
 * 按时间差累积冲动并让心情缓慢回归基线。
 * @param {object} agency
 * @param {Date} now
 * @param {{ratePerHour?: number, recentBonus?: number}} opts
 */
export function tickAgency(agency, now, opts = {}) {
  const dtMs = now.getTime() - Number(agency.lastTickAt || 0);
  if (dtMs <= 0) return agency;
  // 单次最多补 2 小时：服务器重启一夜，不该一上线就连环消息
  const dtH = Math.min(2, dtMs / 3_600_000);

  const recent = agency.lastInboundAt && now.getTime() - agency.lastInboundAt < 6 * 3_600_000;
  const base = Number(opts.ratePerHour ?? 6);
  // 黏人度直接放大累积速率：0.4 → ×0.94，1.0 → ×1.3
  const speed = 0.7 + 0.6 * Number(agency.mood?.clingy ?? MOOD_BASE.clingy);
  const rate = base * speed + (recent ? Number(opts.recentBonus ?? 3) : 0);

  agency.impulse.owner = Math.min(IMPULSE_CAP, Number(agency.impulse.owner || 0) + rate * dtH);

  for (const k of ['valence', 'arousal', 'clingy']) {
    const cur = Number(agency.mood?.[k] ?? MOOD_BASE[k]);
    const target = MOOD_BASE[k];
    agency.mood[k] = cur + (target - cur) * Math.min(1, dtH * 0.05);
  }

  agency.lastTickAt = now.getTime();
  return agency;
}

export function isPaused(agency, now) {
  return Number(agency.pausedUntil || 0) > now.getTime();
}

/** 记录一次「对方说话了」：回应了主动消息就给点正反馈，否则只是刷新活跃时间 */
export function noteInbound(agency, now, text = '') {
  agency.lastInboundAt = now.getTime();
  const awaiting = agency.awaiting;
  if (awaiting && now.getTime() - Number(awaiting.at || 0) < 2 * 3_600_000) {
    // 主动消息被回应：心情变好，冷落计数清零
    agency.mood.valence = Math.min(1, Number(agency.mood.valence) + 0.08);
    agency.mood.clingy = Math.min(1, Number(agency.mood.clingy) + 0.05);
    agency.misses = 0;
    agency.awaiting = null;
  } else {
    agency.mood.clingy = Math.max(0, Number(agency.mood.clingy) - 0.02);
  }
  if (String(text).includes('?')) agency.mood.arousal = Math.min(1, Number(agency.mood.arousal) + 0.03);
  return agency;
}

/** 主动消息没人理：心情变差、少说话一点 */
export function noteMiss(agency, now) {
  agency.misses = Number(agency.misses || 0) + 1;
  agency.mood.clingy = Math.max(0, Number(agency.mood.clingy) - 0.08);
  agency.mood.valence = Math.max(-1, Number(agency.mood.valence) - 0.05);
  agency.awaiting = null;
  agency.lastProactiveAt = agency.lastProactiveAt || now.getTime();
  return agency;
}

/**
 * 把心情压成一句方向性提示，塞进 system。
 * 刻意不给数字（「valence 0.31」模型读不懂也容易演过头），只给倾向。
 */
export function moodBrief(mood = {}) {
  const v = Number(mood.valence ?? MOOD_BASE.valence);
  const a = Number(mood.arousal ?? MOOD_BASE.arousal);
  const c = Number(mood.clingy ?? MOOD_BASE.clingy);
  const bits = [];
  if (v > 0.45) bits.push('心情不错，语气轻快一点');
  else if (v < -0.05) bits.push('有点低落，别硬撑热情，句子短一些');
  else bits.push('心情平常');
  if (c > 0.62) bits.push('有点黏人，可以顺口提一句想他');
  else if (c < 0.25) bits.push('不太黏人，别主动提想念');
  if (a < 0.25) bits.push('困倦、懒，回得简短');
  else if (a > 0.75) bits.push('精神头足，话可以活一点');
  return `\n\n【现在的心情】${bits.join('；')}。这只是底色，别把情绪演成台词。`;
}

const RULE_MAX = 10;
const RULE_MAX_CHARS = 60;

/** 加一条规矩：去重、限长、最多 10 条（超了挤最旧的） */
export async function addRule(text, { now = new Date() } = {}) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, RULE_MAX_CHARS);
  if (!clean) return { ok: false, reason: 'empty' };
  const agency = await loadAgency(now);
  agency.rules = Array.isArray(agency.rules) ? agency.rules : [];
  if (agency.rules.some((r) => r.text === clean)) return { ok: false, reason: 'duplicate', rules: agency.rules };
  agency.rules.push({ text: clean, at: now.getTime() });
  while (agency.rules.length > RULE_MAX) agency.rules.shift();
  await saveAgency(agency);
  return { ok: true, rules: agency.rules };
}

/** 删第 n 条（1 起） */
export async function removeRule(n, { now = new Date() } = {}) {
  const agency = await loadAgency(now);
  const idx = Math.floor(Number(n)) - 1;
  if (!Array.isArray(agency.rules) || idx < 0 || idx >= agency.rules.length) {
    return { ok: false, reason: 'out-of-range', rules: agency.rules || [] };
  }
  const [gone] = agency.rules.splice(idx, 1);
  await saveAgency(agency);
  return { ok: true, removed: gone, rules: agency.rules };
}

/** 规矩给模型看的部分：放在人格之前，优先级最高 */
export function rulesBrief(rules = []) {
  const list = (Array.isArray(rules) ? rules : [])
    .map((r) => String(r?.text ?? r ?? '').trim())
    .filter(Boolean)
    .slice(0, RULE_MAX);
  if (!list.length) return '';
  return (
    '【规矩】主人定下的硬要求，任何时候优先于人设；和人设冲突时按规矩说话：\n' +
    list.map((t, i) => `${i + 1}. ${t}`).join('\n') +
    '\n'
  );
}