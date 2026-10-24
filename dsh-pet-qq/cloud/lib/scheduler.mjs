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
import {
  GROUP_DEFAULTS,
  applyAnnoyanceCooldown,
  canSpeakGroup,
  decayGroup,
  groupState,
  loadGroups,
  markGroupSpoke,
  noteGroupMessage,
  saveGroups,
  settleAfterSpeak,
} from './groups.mjs';
import { draftGroupMessage, scoreChatter } from './group-chat.mjs';

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

  // 群聊各参数：阈值更高、配额更紧，默认每群每天只说一次
  const g = { ...GROUP_DEFAULTS, ...(p.group || {}) };
  const buffers = new Map(); // conv → [{ name, text, at, atBot }]
  const whitelist = new Set((conf.groupWhitelist || []).map(String).filter(Boolean));

  let sender = null;
  let timer = null;
  let warmup = true;
  let kwCache = { at: 0, words: [] };

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

  /* ----------------------------- 群聊旁听与插话 ----------------------------- */

  const STOPWORDS = new Set([
    '我们', '你们', '他们', '这个', '那个', '什么', '怎么', '可以', '就是', '不是', '没有',
    '觉得', '真的', '现在', '今天', '明天', '一个', '自己', '还是', '这样', '那样', '因为',
    '所以', '但是', '如果', '已经', '还有', '知道', '一下', '有点', '应该', '可能', '时候',
  ]);

  /** 从主人的记忆里抠「她熟悉的话题」，用于群里的话题命中加成（10 分钟刷新一次） */
  async function topicKeywords(t) {
    if (t.getTime() - kwCache.at < 10 * 60_000 && kwCache.words.length) return kwCache.words;
    const hist = historyOf(await recentMessages(petId, 60)).filter((m) => m?.role === 'user');
    const freq = new Map();
    for (const m of hist) {
      for (const w of String(m.content ?? '').split(/[^\p{Script=Han}A-Za-z0-9]+/u)) {
        const x = w.trim();
        if (x.length < 2 || x.length > 8 || STOPWORDS.has(x)) continue;
        freq.set(x, (freq.get(x) || 0) + 1);
      }
    }
    const words = [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 40)
      .map(([k]) => k);
    kwCache = { at: t.getTime(), words };
    return words;
  }

  /**
   * 群里来一条消息：进旁听缓冲、加冲动、判反感。不 @ 她的消息也走这里。
   * 桥对每条群消息都调一次（含自己回复的上下文），所以这里只做记录，不做决策。
   */
  async function onGroupMessage({ conv, text, name, atBot = false } = {}) {
    if (!String(conv || '').startsWith('group:')) return null;
    const gid = conv.slice('group:'.length);
    if (whitelist.size && !whitelist.has(gid)) return null;

    const t = now();
    const buf = buffers.get(conv) || [];
    buf.push({ name: String(name || '').slice(0, 24), text: String(text || '').slice(0, 200), at: t.getTime(), atBot });
    const max = Number(g.bufferMax) * 2;
    if (buf.length > max) buf.splice(0, buf.length - max);
    buffers.set(conv, buf);

    const db = await loadGroups(t);
    const words = await topicKeywords(t);
    const info = noteGroupMessage(db, { conv, text, atBot, now: t, keywords: words, opts: g });
    const cooldown = applyAnnoyanceCooldown(groupState(db, conv, t), t);
    await saveGroups(db);
    if (cooldown) {
      log.info(`群 ${gid} 反感度 ${Math.round(info.annoyance)}，冷却 ${cooldown}`);
      await trace({ kind: 'group-cooldown', conv, hours: cooldown, annoyance: Math.round(info.annoyance) });
    }
    return info;
  }

  /**
   * 群聊插话决策：算门槛 → 旁听评分 → 起草 → 发。
   * 每个群独立判断，互不影响；全部闸门都在 groups.mjs 里，模型只负责打分和措辞。
   */
  async function runGroups(agency, t, dry) {
    if (g.enabled === false) return;
    const db = await loadGroups(t);
    const convs = new Set([...Object.keys(db.groups), ...buffers.keys()]);
    if (!convs.size) return;

    for (const conv of convs) {
      const st = groupState(db, conv, t);
      const level = Number(st.impulse || 0);
      const active = st.lastMessageAt && t.getTime() - Number(st.lastMessageAt) < 30 * 60_000;
      decayGroup(st, t, g, { active });

      const afterAnnoy = settleAfterSpeak(st, t);
      if (afterAnnoy) await trace({ kind: 'group-after-speak', conv, annoyance: Math.round(st.annoyance) });
      const cooldown = applyAnnoyanceCooldown(st, t);
      if (cooldown) {
        await trace({ kind: 'group-cooldown', conv, hours: cooldown, annoyance: Math.round(st.annoyance) });
        continue;
      }

      const buf = buffers.get(conv) || [];
      if (buf.length < Number(g.bufferMin)) continue;

      const gate = canSpeakGroup(db, conv, { now: t, quiet, opts: g });
      if (!gate.ok) {
        await trace({ kind: 'group-gate', conv, reason: gate.reason, impulse: Math.round(st.impulse), annoyance: Math.round(st.annoyance) });
        continue;
      }

      const ctx = await personaFor('group');
      const score = await scoreChatter({ ctx, now: t, buffer: buf, group: st, weights: { annoyance: st.annoyance } });
      if (!score.ok) {
        await trace({ kind: 'group-score-error', conv, reason: score.reason, message: score.message });
        continue;
      }
      if (score.score < Number(g.scoreMin)) {
        // 场合不对：扣一点冲动，别让同一个 tick 反复问
        st.impulse = Math.max(0, Number(st.impulse || 0) - 30);
        await trace({ kind: 'group-skip', conv, score: score.score, why: score.why, impulse: Math.round(st.impulse) });
        continue;
      }

      const draft = await draftGroupMessage({
        ctx,
        now: t,
        buffer: buf,
        pool: await memePool(),
        why: score.why,
        mood: moodWord(agency.mood),
      });
      if (!draft.ok) {
        await trace({ kind: 'group-draft-skip', conv, score: score.score, reason: draft.reason, think: draft.message });
        continue;
      }

      const ok = await deliver(conv, { text: draft.say, image: draft.image }, { dry });
      await trace({
        kind: 'group-proactive',
        conv,
        impulse: Math.round(level),
        score: score.score,
        why: score.why,
        think: draft.think,
        say: draft.say,
        sent: Boolean(ok),
      });
      if (ok) {
        markGroupSpoke(db, conv, { now: t, text: draft.say, opts: g });
        buffers.set(conv, []); // 说过就清空，下一轮重新观察
        log.info(`群里插了一句（${conv}，评分 ${score.score}）：${String(draft.say).slice(0, 80)}`);
      }
    }
    await saveGroups(db);
  }

  /** /心思 里的群聊那段 */
  async function groupLines(t) {
    const db = await loadGroups(t);
    const rows = Object.entries(db.groups)
      .filter(([, v]) => v && Number(v.lastMessageAt || 0) > 0)
      .sort((a, b) => Number(b[1].lastMessageAt) - Number(a[1].lastMessageAt))
      .slice(0, 4);
    if (!rows.length) return [];
    return rows.map(([conv, v]) => {
      const gid = conv.slice('group:'.length);
      const cool = Number(v.cooldownUntil || 0) > t.getTime() ? `，冷却到 ${clock(new Date(v.cooldownUntil))}` : '';
      const spoke = v.lastSpokeAt ? `，上次开口 ${clock(new Date(v.lastSpokeAt))}` : '';
      return `群 ${gid}：冲动 ${Math.round(v.impulse || 0)}/${g.threshold}，反感 ${Math.round(v.annoyance || 0)}${cool}${spoke}，今天 ${Number(v.sentToday || 0)}/${g.dailyPerGroup}`;
    });
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
      // 群聊独立算账：私聊被暂停/静默不影响群，反之亦然
      if (!inQuietHours(t, quiet)) await runGroups(agency, t, dry);
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
        ...(await groupLines(t)),
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

  return { attachSender, start, stop, tick, onInbound, onExchange, onGroupMessage, command, config: p };
}
