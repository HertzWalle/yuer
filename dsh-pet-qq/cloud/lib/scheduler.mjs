/**
 * 主动性调度器（P1a：承诺兑现 + 私聊主动）。
 *
 * 每 `tickSec` 秒跑一次决策，两件事按优先级：
 *   1) **承诺**：到点就兑现，不看冲动、不占日配额（该不该做 > 想不想说）；
 *   2) **私聊冲动**：攒够阈值、不在静默时段、没刚聊完、没超日上限、没被冷落，才允许开口。
 *
 * 三条刻意的设计：
 *  - 所有「能不能说」都由代码判定，模型只决定「说什么」——把失控风险挡在提示词之外；
 *  - 每次决策写一条 trace（冲动值、闸门原因、内心独白、是否发出），出问题能复盘；
 *  - 首次 tick 只观察不发送（boot-warmup），避免重启后立刻发一堆。
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PATHS, appendMessages, loadPet } from './store.mjs';
import { readMemePool, limitPool } from './memes.mjs';
import { personaFor, recentMessages } from './pet-api.mjs';
import {
  IMPULSE_CAP,
  inQuietHours,
  isPaused,
  loadAgency,
  noteInbound as moodOnInbound,
  noteMiss,
  resetDailyCounter,
  saveAgency,
  tickAgency,
} from './agency.mjs';
import { dueSoon, extractCommitments, humanTime, loadCommitments, markStatus, openItems } from './commitments.mjs';
import { generateCommitmentMessage, generateProactive, moodWord } from './proactive.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const TRACE_FILE = join(ROOT, 'logs', 'trace.jsonl');

const DEFAULTS = {
  enabled: true,
  ownerIds: [],
  tickSec: 300,
  quietHours: ['23:30', '07:30'],
  impulseThreshold: 70,
  impulseCost: 45,
  ratePerHour: 6,
  recentBonus: 3,
  dailyLimit: 5,
  minGapMin: 50,
  recentGuardMin: 20,
  commitmentLeadMin: 20,
  dryRun: false,
};

const ENTRY = 'main';
const pad = (n) => String(n).padStart(2, '0');

/** pet-api 的 recentMessages 在云端返回 {ok,messages}，桌面端返回数组——统一成数组 */
const historyOf = (r) => (Array.isArray(r) ? r : Array.isArray(r?.messages) ? r.messages : []);
const clock = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

export function createScheduler({ conf, log, now = () => new Date() }) {
  const p = { ...DEFAULTS, ...(conf.proactive || {}) };
  const quiet = { start: p.quietHours?.[0], end: p.quietHours?.[1] };
  const petId = conf.pet?.id ?? 'main';
  const ownerIds = (p.ownerIds || []).map(String).filter(Boolean);
  const ownerConv = ownerIds.length ? `private:${ownerIds[0]}` : '';

  let sender = null;
  let timer = null;
  let warmup = true;

  function attachSender(fn) {
    sender = fn;
  }

  async function trace(obj) {
    try {
      await mkdir(dirname(TRACE_FILE), { recursive: true });
      await appendFile(TRACE_FILE, JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n', 'utf8');
    } catch {
      /* trace 写不进去不影响主流程 */
    }
  }

  async function memePool() {
    const petConf = await loadPet();
    return limitPool(readMemePool(petConf.memes, [PATHS.memesDir]), petConf.chatImageLimit ?? 0);
  }

  async function deliver(conv, payload, { dry = false } = {}) {
    const text = String(payload?.text ?? '').trim();
    if (!text) return false;
    if (dry || p.dryRun) {
      log.info(`[dry] 主动消息 → ${conv}：${text}${payload.image ? ` [图:${payload.image}]` : ''}`);
      return true;
    }
    if (!sender) {
      log.warn('没有可用的发送通道，主动消息丢弃');
      return false;
    }
    const ok = await sender(conv, payload);
    if (ok) await appendMessages(ENTRY, petId, [{ role: 'assistant', content: text }]).catch(() => {});
    return Boolean(ok);
  }

  /** 主动消息超过 2 小时没人回 → 记一次冷落 */
  async function settleMisses(agency, t) {
    const a = agency.awaiting;
    if (!a) return;
    if (t.getTime() - Number(a.at || 0) < 2 * 3_600_000) return;
    noteMiss(agency, t);
    log.info(`主动消息 2 小时没回应，记一次冷落（累计 ${agency.misses}）`);
    await trace({ kind: 'miss', conv: a.conv, text: a.text, misses: agency.misses });
  }

  async function runCommitments(agency, t, dry) {
    const due = await dueSoon(t, Number(p.commitmentLeadMin) * 60_000);
    if (!due.length) return;
    // 主动消息发给主人（私聊档），所以取私聊的人设
    const ctx = await personaFor('private');
    const history = historyOf(await recentMessages(petId, 8));
    const pool = await memePool();

    for (const item of due) {
      const tries = Number(item.tries || 0);
      if (tries >= 3) {
        await markStatus(item.id, 'missed', { note: '连续三次没能兑现' });
        continue;
      }
      const res = await generateCommitmentMessage({ pet: ctx, now: t, history, item, pool });
      if (!res.ok) {
        await markStatus(item.id, 'pending', { tries: tries + 1, lastError: res.message ?? res.reason });
        await trace({ kind: 'commitment-error', id: item.id, reason: res.reason, message: res.message });
        continue;
      }
      const ok = await deliver(ownerConv, { text: res.say, image: res.image }, { dry });
      await trace({
        kind: 'commitment',
        id: item.id,
        what: item.what,
        dueAt: item.dueAt,
        think: res.think,
        say: res.say,
        sent: ok,
      });
      if (ok) await markStatus(item.id, 'done', { note: '已兑现' });
      else await markStatus(item.id, 'pending', { tries: tries + 1 });
    }
  }

  async function runImpulse(agency, t, dry) {
    const impulse = Number(agency.impulse.owner || 0);
    const threshold = Number(p.impulseThreshold) + (Number(agency.misses) >= 2 ? 20 : 0);
    if (impulse < threshold) return;

    const skip = (why) => trace({ kind: 'gate', reason: why, impulse: Math.round(impulse), threshold });

    if (!ownerConv) return skip('no-owner');
    if (inQuietHours(t, quiet)) return skip('quiet-hours');
    if (Number(agency.counters.ownerSent || 0) >= Number(p.dailyLimit)) return skip('daily-limit');
    if (agency.lastProactiveAt && t.getTime() - agency.lastProactiveAt < Number(p.minGapMin) * 60_000) {
      return skip('min-gap');
    }
    if (agency.lastInboundAt && t.getTime() - agency.lastInboundAt < Number(p.recentGuardMin) * 60_000) {
      return skip('just-talked');
    }

    // 主动消息发给主人（私聊档），所以取私聊的人设
    const ctx = await personaFor('private');
    const history = historyOf(await recentMessages(petId, 10));
    const pool = await memePool();
    const lastUser = [...history].reverse().find((m) => m?.role === 'user');
    const hint = lastUser ? `最近主人说过：「${String(lastUser.content).slice(0, 60)}」` : '';

    const res = await generateProactive({ pet: ctx, now: t, history, mood: agency.mood, pool, hint });
    if (!res.ok) {
      await trace({ kind: 'proactive-error', reason: res.reason, message: res.message, impulse: Math.round(impulse) });
      return;
    }
    if (!res.say) {
      // 自己想清楚「没什么好说的」：扣一点冲动，不至于每个 tick 都问一遍
      agency.impulse.owner = Math.max(0, impulse - 25);
      await trace({ kind: 'self-skip', think: res.think, impulse: Math.round(impulse) });
      return;
    }

    const ok = await deliver(ownerConv, { text: res.say, image: res.image }, { dry });
    await trace({
      kind: 'proactive',
      conv: ownerConv,
      impulse: Math.round(impulse),
      threshold,
      mood: agency.mood,
      think: res.think,
      say: res.say,
      sent: ok,
    });

    if (ok) {
      agency.impulse.owner = Math.max(0, impulse - Number(p.impulseCost));
      agency.counters.ownerSent = Number(agency.counters.ownerSent || 0) + 1;
      agency.lastProactiveAt = t.getTime();
      agency.awaiting = { at: t.getTime(), conv: ownerConv, text: res.say };
      log.info(`主动开口（冲动 ${Math.round(impulse)} → ${Math.round(agency.impulse.owner)}）：${res.say.slice(0, 80)}`);
    }
  }

  /** 一次完整决策（导出给测试与 CLI 用） */
  async function tick({ dry = false } = {}) {
    const t = now();
    const agency = await loadAgency(t);
    tickAgency(agency, t, p);
    resetDailyCounter(agency, t);

    await settleMisses(agency, t);

    if (isPaused(agency, t)) {
      await trace({ kind: 'gate', reason: 'paused', until: new Date(agency.pausedUntil).toISOString() });
    } else if (warmup) {
      // 刚启动的第一个 tick 只观察：避免重启后立刻把攒下的冲动一次性发出去
      await trace({ kind: 'boot-warmup', impulse: Math.round(agency.impulse.owner) });
    } else {
      await runCommitments(agency, t, dry);
      await runImpulse(agency, t, dry);
    }

    warmup = false;
    await saveAgency(agency);
    return agency;
  }

  function start() {
    if (p.enabled === false) {
      log.info('主动行为已关闭（proactive.enabled=false）');
      return;
    }
    if (!ownerConv) {
      log.warn('没配 proactive.ownerIds，主动消息不会发出（只累计冲动）');
    }
    const ms = Math.max(30, Number(p.tickSec) || 300) * 1000;
    log.info(`主动性调度已启动：每 ${ms / 1000}s 一次，静默 ${quiet.start}–${quiet.end}，阈值 ${p.impulseThreshold}，日上限 ${p.dailyLimit}`);
    timer = setInterval(() => {
      tick().catch((e) => log.error(`tick 失败：${e?.message ?? e}`));
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  /** 桥每收到一条真人消息调一次：刷新活跃时间、给心情一点反馈 */
  async function onInbound({ conv, text } = {}) {
    const t = now();
    const agency = await loadAgency(t);
    moodOnInbound(agency, t, text);
    agency.lastInboundAt = t.getTime();
    await saveAgency(agency);
    return conv;
  }

  /** 一轮对答结束：抽取「她答应了什么」（正则粗筛后才调模型） */
  async function onExchange({ userText, replyText } = {}) {
    try {
      const items = await extractCommitments({ userText, replyText, now: now(), conv: ownerConv });
      if (items.length) {
        log.info(`记下承诺 ${items.length} 条：${items.map((x) => `${x.what}@${x.dueAt}`).join('；')}`);
        await trace({ kind: 'commitment-new', items });
      }
    } catch (e) {
      log.warn(`抽取承诺失败：${e?.message ?? e}`);
    }
  }

  /** 指令：/心思 /安静 /说话 /承诺 —— 返回要发出去的文本，null 表示不处理 */
  async function command(msg) {
    const raw = String(msg?.text ?? '').trim();
    const m = raw.match(/^[/／]([^\s/／]*)\s*([\s\S]*)$/);
    if (!m) return null;
    const cmd = m[1].toLowerCase();
    const arg = m[2].trim();
    const t = now();

    if (['心思', '心情', 'agency'].includes(cmd)) {
      const agency = await loadAgency(t);
      const db = await loadCommitments();
      const open = openItems(db);
      const next = open
        .map((x) => ({ ...x, at: Date.parse(x.dueAt) }))
        .sort((a, b) => a.at - b.at)[0];
      const lines = [
        '【她现在的心思】',
        `冲动：${Math.round(agency.impulse.owner)}/${IMPULSE_CAP}（到 ${p.impulseThreshold} 就想开口）`,
        `心情：${moodWord(agency.mood)}`,
        `今天主动开口：${agency.counters.ownerSent}/${p.dailyLimit} 次`,
        agency.lastProactiveAt
          ? `上次主动：${clock(new Date(agency.lastProactiveAt))}`
          : '上次主动：还没有',
        next ? `最近一条承诺：${humanTime(next.dueAt, t)} ${next.what}` : '承诺：没有待兑现的',
        isPaused(agency, t) ? `暂停中：到 ${clock(new Date(agency.pausedUntil))} 前不会主动` : '暂停：无',
        agency.misses ? `被冷落：${agency.misses} 次（会让她更谨慎）` : '',
      ].filter(Boolean);
      return lines.join('\n');
    }

    if (['安静', '闭嘴', 'pause'].includes(cmd)) {
      const hours = Number(arg) > 0 ? Math.min(Number(arg), 168) : 12;
      const agency = await loadAgency(t);
      agency.pausedUntil = t.getTime() + hours * 3_600_000;
      agency.rules = [...(agency.rules || []).slice(-19), `主人让安静 ${hours} 小时（${clock(t)}）`];
      await saveAgency(agency);
      return `好，安静 ${hours} 小时，到 ${clock(new Date(agency.pausedUntil))} 之前我不会主动找你。`;
    }

    if (['说话', '主动', 'resume'].includes(cmd)) {
      const agency = await loadAgency(t);
      const was = isPaused(agency, t);
      agency.pausedUntil = 0;
      await saveAgency(agency);
      return was ? '好，我又可以主动说话了。' : '我本来就可以说话呀。';
    }

    if (['承诺', 'promises'].includes(cmd)) {
      const db = await loadCommitments();
      const open = openItems(db).sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
      if (!open.length) return '我没答应过什么还没做的事。';
      return ['我记着这些：', ...open.map((x, i) => `${i + 1}. ${humanTime(x.dueAt, t)} —— ${x.what}`)].join('\n');
    }

    return null;
  }

  return { attachSender, start, stop, tick, onInbound, onExchange, command, config: p };
}
