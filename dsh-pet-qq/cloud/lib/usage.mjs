/**
 * token 账本。
 *
 * 为什么要自己做：DSH 生态里的用量插件（dsh-plugin-token-stats 之类）读的是 DSH 自己的会话
 * 存储，而我们是服务器上的独立 Node 进程，装十个也看不到这里的消耗。DeepSeek 官方面板只有
 * 账号级、按天的总数，分不清「聊天 / 主动开口 / 兑现承诺 / 群插话 / 说说」各花了多少。
 *
 * 所以：每次成功的 chatCompletion 记一行 jsonl（不记正文、不记 key），按月切文件。
 * 一行 = { ts, kind, model, prompt, completion, cacheHit, cacheMiss, conv, ms }
 */
import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { PATHS } from './store.mjs';

/** 五类调用：聊天、主动开口、兑现承诺、群插话、说说 */
export const USAGE_KINDS = ['chat', 'proactive', 'promise', 'group', 'mood'];

const KEEP_DAYS = 90;

function monthOf(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}${m}`;
}

function fileOf(d = new Date()) {
  return join(PATHS.usageDir, `usage-${monthOf(d)}.jsonl`);
}

/** 记一次成功调用；失败/字段缺失都静默，账本不能影响聊天 */
export async function recordUsage({ kind = 'chat', model = '', usage = null, conv = '', ms = 0 } = {}) {
  if (!usage || typeof usage !== 'object') return { ok: false, reason: 'no-usage' };
  const prompt = Number(usage.prompt_tokens) || 0;
  const completion = Number(usage.completion_tokens) || 0;
  const cacheHit = Number(
    usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0,
  ) || 0;
  const cacheMiss = Number(usage.prompt_cache_miss_tokens ?? Math.max(0, prompt - cacheHit)) || 0;
  const line = {
    ts: new Date().toISOString(),
    kind: USAGE_KINDS.includes(kind) ? kind : 'chat',
    model: String(model || ''),
    prompt,
    completion,
    cacheHit,
    cacheMiss,
    conv: String(conv || ''),
    ms: Math.max(0, Math.round(Number(ms) || 0)),
  };
  try {
    await mkdir(PATHS.usageDir, { recursive: true });
    await appendFile(fileOf(), JSON.stringify(line) + '\n', 'utf8');
    return { ok: true };
  } catch {
    return { ok: false, reason: 'write-failed' };
  }
}

async function readMonth(monthKey) {
  const file = join(PATHS.usageDir, `usage-${monthKey}.jsonl`);
  let raw = '';
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const ln of raw.split('\n')) {
    if (!ln.trim()) continue;
    try {
      out.push(JSON.parse(ln));
    } catch {
      // 坏行跳过：账本宁缺勿崩
    }
  }
  return out;
}

/** 最近 n 天（含今天）的原始记录，按时间正序 */
export async function recentUsage(days = 7, now = new Date()) {
  const need = Math.max(1, Math.min(KEEP_DAYS, Math.floor(Number(days) || 7)));
  const months = new Set();
  for (let i = 0; i < need + 1; i++) {
    const d = new Date(now.getTime() - i * 86_400_000);
    months.add(monthOf(d));
  }
  const all = [];
  for (const m of months) all.push(...(await readMonth(m)));
  const since = now.getTime() - need * 86_400_000;
  return all
    .filter((r) => Date.parse(r.ts) >= since)
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

function emptyBucket() {
  return { calls: 0, prompt: 0, completion: 0, cacheHit: 0, cacheMiss: 0 };
}

function addTo(bucket, row) {
  bucket.calls += 1;
  bucket.prompt += Number(row.prompt) || 0;
  bucket.completion += Number(row.completion) || 0;
  bucket.cacheHit += Number(row.cacheHit) || 0;
  bucket.cacheMiss += Number(row.cacheMiss) || 0;
}

/**
 * 汇总：今天 /近 N 天 /按 kind。
 * 顺带算一个粗成本（DeepSeek 现价，USD/1M，未命中 0.27 取高峰与低峰中间值）——
 * 只用来给个量级，别当账单。
 */
export async function usageSummary({ days = 7, now = new Date() } = {}) {
  const rows = await recentUsage(days, now);
  const todayKey = new Date(now).toDateString();
  const today = emptyBucket();
  const range = emptyBucket();
  const byKind = new Map();
  for (const r of rows) {
    addTo(range, r);
    if (new Date(r.ts).toDateString() === todayKey) addTo(today, r);
    const k = r.kind || 'chat';
    if (!byKind.has(k)) byKind.set(k, emptyBucket());
    addTo(byKind.get(k), r);
  }
  const costUsd =
    (range.cacheHit / 1e6) * 0.014 + (range.cacheMiss / 1e6) * 0.27 + (range.completion / 1e6) * 1.1;
  return {
    ok: true,
    days: Math.max(1, Math.min(KEEP_DAYS, Math.floor(Number(days) || 7))),
    today,
    range,
    byKind: [...byKind.entries()].map(([kind, v]) => ({ kind, ...v })).sort((a, b) => b.calls - a.calls),
    costUsd: Math.round(costUsd * 10_000) / 10_000,
  };
}

/** /余额 用：DeepSeek 账户余额（OpenAI 兼容端点不一定有，失败返回 null） */
export async function balance() {
  const key = (process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || '').trim();
  const base = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
  if (!key) return { ok: false, reason: 'provider-missing' };
  const url = base.replace(/\/v1$/, '') + '/user/balance';
  try {
    const res = await fetch(url, {
      headers: { authorization: 'Bearer ' + key },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ok: false, reason: `http-${res.status}` };
    const data = await res.json();
    const info = Array.isArray(data?.balance_infos) ? data.balance_infos[0] : null;
    return {
      ok: true,
      available: data?.is_available !== false,
      currency: info?.currency || 'CNY',
      total: Number(info?.total_balance ?? 0),
      granted: Number(info?.granted_balance ?? 0),
      toppedUp: Number(info?.topped_up_balance ?? 0),
    };
  } catch (e) {
    return { ok: false, reason: 'fetch-failed', message: String(e?.message || e) };
  }
}

/** 清理太老的账本文件（保留 KEEP_DAYS 个月） */
export async function pruneUsage(now = new Date()) {
  try {
    const files = await readdir(PATHS.usageDir);
    const keep = new Set();
    for (let i = 0; i < 3; i++) keep.add(monthOf(new Date(now.getTime() - i * 31 * 86_400_000)));
    let removed = 0;
    for (const f of files) {
      const m = /^usage-(\d{6})\.jsonl$/.exec(f);
      if (!m) continue;
      if (keep.has(m[1])) continue;
      if (Date.parse(`${m[1].slice(0, 4)}-${m[1].slice(4)}-01`) > now.getTime() - KEEP_DAYS * 86_400_000) continue;
      removed += 1;
    }
    return { ok: true, removed };
  } catch {
    return { ok: true, removed: 0 };
  }
}

/**
 * 包一层：跑一次生成，成功就把 usage 记到对应 kind 里。
 * 用法：const res = await withUsage('proactive', () => chatCompletion(msgs, opts));
 */
export async function withUsage(kind, fn, { conv = '' } = {}) {
  const t0 = Date.now();
  const res = await fn();
  const ms = Date.now() - t0;
  if (res?.ok && res.usage) {
    try {
      await recordUsage({ kind, usage: res.usage, model: res.model, ms, conv });
    } catch {
      /* 记账失败不能影响聊天 */
    }
  }
  return res;
}