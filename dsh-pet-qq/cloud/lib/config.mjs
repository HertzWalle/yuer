/**
 * 配置热重载：面板改完参数，不用重启进程、下一句就生效。
 *
 * 两个要点：
 *  1) 桥和调度器各自持有一个 `conf` 对象，闭包里到处是 `conf.xxx`。所以**不换对象、只深合并**，
 *     所有闭包天然读到新值——这比把每处 `conf.xxx` 改成 `getConf().xxx` 侵入小得多；
 *  2) 落盘先写临时文件再 rename，避免进程被杀时留下半个 JSON（那边一崩，机器人就起不来）。
 */

import { readFile, rename, writeFile } from 'node:fs/promises';

export async function readJsonFile(file, fallback = null) {
  try {
    const raw = await readFile(file, 'utf8');
    return raw.trim() ? JSON.parse(raw) : fallback;
  } catch (e) {
    if (e?.code === 'ENOENT') return fallback;
    throw e;
  }
}

export async function writeJsonAtomic(file, obj) {
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  await rename(tmp, file);
}

/** 深合并：对象递归、数组整体替换、其余覆盖。返回 target 本身（原地改） */
export function deepMerge(target, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return target;
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (!target[k] || typeof target[k] !== 'object' || Array.isArray(target[k])) target[k] = {};
      deepMerge(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

/* ------------------------------ 校验规则 ------------------------------ */
// 每项：[类型, 最小值, 最大值]。面板只放白名单里的键，别的键一律拒绝——
// 免得一次手滑把 `behavior.letta.agentId` 之类写坏，机器人就哑了。

const num = (min, max) => ['num', min, max];
const int = (min, max) => ['int', min, max];
const bool = () => ['bool'];
const hm = () => ['hm'];

/** pet.json：表达层的数字 */
export const PET_RULES = {
  maxBubbles: int(1, 6),
  splitChance: num(0, 1),
  maxBubblesGroup: int(1, 3),
  splitChanceGroup: num(0, 1),
  memeChancePrivate: num(0, 1),
  memeChanceGroup: num(0, 1),
  memeCooldown: int(0, 240),
  drawEnabled: bool(),
  drawInGroup: bool(),
};

/** bridge.config.json：主动行为 / 群聊配额 / 发送节奏 */
export const BRIDGE_RULES = {
  'proactive.enabled': bool(),
  'proactive.ratePerHour': num(0, 60),
  'proactive.impulseThreshold': int(10, 200),
  'proactive.impulseCost': int(5, 120),
  'proactive.dailyLimit': int(0, 30),
  'proactive.minGapMin': int(1, 240),
  'proactive.recentGuardMin': int(0, 240),
  'proactive.quietHours.0': hm(),
  'proactive.quietHours.1': hm(),
  'proactive.viaLetta': bool(),

  'behavior.coalesceMs': int(0, 10000),
  'behavior.maxBubbles': int(1, 6),
  'behavior.maxBubblesGroup': int(1, 3),
  'behavior.bubbleDelayMs': int(0, 5000),
  'behavior.tailPauseMs': int(0, 5000),
  'behavior.imageDelayMs': int(0, 5000),
  'behavior.voice.enabled': bool(),
  'behavior.voice.chance': num(0, 1),
  'behavior.draw.enabled': bool(),
  'behavior.draw.limitPrivate': int(0, 50),
  'behavior.draw.limitGroup': int(0, 50),
  'behavior.observeGroups': bool(),

  'proactive.group.enabled': bool(),
  'proactive.group.shareCap': num(0, 1),
  'proactive.group.idleOpenMin': int(0, 240),
  'proactive.group.dailyLimit.hot': int(0, 100),
  'proactive.group.dailyLimit.normal': int(0, 100),
  'proactive.group.dailyLimit.quiet': int(0, 100),
  'proactive.group.dailyLimit.dead': int(0, 100),
  'proactive.group.hourLimit.hot': int(0, 40),
  'proactive.group.hourLimit.normal': int(0, 40),
  'proactive.group.hourLimit.quiet': int(0, 40),
  'proactive.group.hourLimit.dead': int(0, 40),
  'proactive.group.minGapSec.hot': int(30, 86400),
  'proactive.group.minGapSec.normal': int(30, 86400),
  'proactive.group.minGapSec.quiet': int(30, 86400),
  'proactive.group.minGapSec.dead': int(30, 86400),
  'proactive.group.urgencyMin.hot': int(1, 40),
  'proactive.group.urgencyMin.normal': int(1, 40),
  'proactive.group.urgencyMin.quiet': int(1, 40),
  'proactive.group.urgencyMin.dead': int(1, 40),
};

const getPath = (obj, path) =>
  String(path)
    .split('.')
    .reduce((acc, k) => (acc == null ? acc : acc[k]), obj);

function setPath(obj, path, value) {
  const keys = String(path).split('.');
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    if (!cur[k] || typeof cur[k] !== 'object') cur[k] = /^\d+$/.test(k) ? [] : {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
}

/** 校验扁平 patch（键是 'a.b.c' 路径）→ { ok, patch, errors } */
export function validatePatch(flat, rules) {
  const patch = {};
  const errors = [];
  for (const [key, raw] of Object.entries(flat || {})) {
    const rule = rules[key];
    if (!rule) {
      errors.push(`${key}：不是可改的参数`);
      continue;
    }
    const [type, min, max] = rule;
    if (type === 'bool') {
      if (typeof raw !== 'boolean') errors.push(`${key}：要 true/false`);
      else setPath(patch, key, raw);
      continue;
    }
    if (type === 'hm') {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(raw))) errors.push(`${key}：要 HH:MM`);
      else setPath(patch, key, String(raw));
      continue;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      errors.push(`${key}：要数字`);
      continue;
    }
    const v = type === 'int' ? Math.round(n) : n;
    if (v < min || v > max) errors.push(`${key}：要在 ${min}~${max} 之间`);
    else setPath(patch, key, v);
  }
  return { ok: errors.length === 0, patch, errors };
}

/** 只取白名单里的当前值（给面板画表单，顺带脱敏） */
export function project(conf, rules) {
  const out = {};
  for (const key of Object.keys(rules)) {
    const v = getPath(conf, key);
    if (v !== undefined) out[key] = v;
  }
  return out;
}
