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
import { personaFor, recentForContext } from './pet-api.mjs';
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
import { generateCommitmentMessage, generateMood, generateProactive, moodWord } from './proactive.mjs';
import { cleanMood, publishMood, readFeed } from './qzone.mjs';
import { addNote, decayAndArchive, recentNotes, seenBrief } from './semantic.mjs';
import { biliNote, douyinNote, fetchSeen } from './feeds.mjs';
import { loadSelf, updateSelf } from './memory-manager.mjs';
import { chatCompletion } from './llm.mjs';
import {
  GROUP_DEFAULTS,
  applyAnnoyanceCooldown,
  canOpenGroup,
  canSpeakGroup,
  decayGroup,
  echoRateOf,
  groupState,
  loadGroups,
  markGroupSpoke,
  noteGroupMessage,
  quotaOf,
  saveGroups,
  settleAfterSpeak,
  tierOf,
  urgencyOf,
} from './groups.mjs';
import { draftGroupMessage, draftOpener, scoreChatter } from './group-chat.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const TRACE_FILE = join(ROOT, 'logs', 'trace.jsonl');

const DEFAULTS = {
  enabled: true,
  ownerIds: [],
  tickSec: 300,
  quietHours: ['23:30', '07:30'],
  impulseThreshold: 58,
  impulseCost: 38,
  ratePerHour: 9,
  recentBonus: 3,
  dailyLimit: 8,
  minGapMin: 35,
  recentGuardMin: 20,
  commitmentLeadMin: 20,
  dryRun: false,
};

const QZONE_DEFAULTS = {
  enabled: false,
  /** 每天几点之后去读一次动态（读了写进语义记忆，聊天时能自然提起） */
  readHour: 21,
  readNum: 10,
  /** 只记最近几天的动态，别把十年前的老帖翻出来当"最近看到的" */
  freshDays: 30,
  /** 允不允许自己发说说（B 档）；关掉就只读不写 */
  publishEnabled: false,
  dailyLimit: 1,
  /** 冲动攒到多少才愿意发一条 */
  impulseThreshold: 85,
  impulseCost: 30,
  maxChars: 90,
  /** true = 只生成、写 trace、不真的发（先观察几天文案像不像样） */
  dryRun: true,
  /** 连续失败几次就自动停用（空间接口一旦被风控，继续打只会更糟） */
  maxFails: 3,
  timeoutMs: 20_000,
};

const ENTRY = 'main';
const pad = (n) => String(n).padStart(2, '0');

const clock = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function createScheduler({ conf, log, now = () => new Date() }) {
  const p = { ...DEFAULTS, ...(conf.proactive || {}) };
  const quiet = { start: p.quietHours?.[0], end: p.quietHours?.[1] };
  const petId = conf.pet?.id ?? 'main';
  const ownerIds = (p.ownerIds || []).map(String).filter(Boolean);
  const ownerConv = ownerIds.length ? `private:${ownerIds[0]}` : '';

  // 群聊各参数：阈值更高、配额更紧，默认每群每天只说一次
  const g = { ...GROUP_DEFAULTS, ...(p.group || {}) };
  // QQ 空间：配置写在 pet.json 的 qzone 段（bridge.config.json 里没有），第一次用到时懒加载
  let qzCache = null;
  async function qzConfig() {
    if (qzCache) return qzCache;
    let fromPet = {};
    try {
      fromPet = (await loadPet())?.qzone ?? {};
    } catch {
      /* 读不到就用默认值：默认关闭，安全 */
    }
    qzCache = { ...QZONE_DEFAULTS, ...fromPet, ...(conf.qzone || {}) };
    return qzCache;
  }
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
    const history = await recentForContext(petId, 8);
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
    const history = await recentForContext(petId, 10);
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
    const hist = (await recentForContext(petId, 60)).filter((m) => m?.role === 'user');
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
    const st = groupState(db, conv, t);
    const u = urgencyOf(st, { atBot, scored: info, now: t, opts: g });
    const cooldown = applyAnnoyanceCooldown(st, t);
    await saveGroups(db);
    if (u.urgency >= u.need) {
      await trace({ kind: 'group-urgency', conv, tier: u.tier, urgency: u.urgency, need: u.need, reasons: info.reasons });
    }
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
        await trace({
          kind: 'group-gate',
          conv,
          reason: gate.reason,
          tier: gate.tier,
          urgency: Math.round(st.lastUrgency || 0),
          today: Number(st.sentToday || 0),
          quota: gate.quota?.daily,
          impulse: Math.round(st.impulse),
          annoyance: Math.round(st.annoyance),
        });
        continue;
      }

      const ctx = await personaFor('group', conv);
      const score = await scoreChatter({ ctx, now: t, buffer: buf, group: st, weights: { annoyance: st.annoyance } });
      if (!score.ok) {
        await trace({ kind: 'group-score-error', conv, reason: score.reason, message: score.message });
        continue;
      }
      // 热闹的群机会多，评分门槛放低一点；冷清群宁可不说
      const scoreMin = gate.tier === 'hot' ? 5 : Number(g.scoreMin);
      if (score.score < scoreMin) {
        st.impulse = Math.max(0, Number(st.impulse || 0) - 30);
        await trace({ kind: 'group-skip', conv, tier: gate.tier, score: score.score, need: scoreMin, why: score.why, impulse: Math.round(st.impulse) });
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
        tier: gate.tier,
        urgency: Math.round(st.lastUrgency || 0),
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

  /**
   * 冷清群的主动开场：群里安静久了，她自己起个话头（热闹群不走这条路）。
   * 只按概率触发，且必须配额、间隔、反感度都放行。
   */
  async function runOpeners(agency, t, dry) {
    if (g.enabled === false) return;
    const db = await loadGroups(t);
    const convs = Object.keys(db.groups);
    if (!convs.length) return;
    const seen = await seenBrief({ n: 3 });

    for (const conv of convs) {
      const gate = canOpenGroup(db, conv, { now: t, quiet, opts: g });
      if (!gate.ok) {
        if (gate.reason === 'daily-limit' || gate.reason === 'cooldown' || gate.reason === 'annoyed') {
          await trace({ kind: 'group-opener-gate', conv, reason: gate.reason, tier: gate.tier });
        }
        continue;
      }

      const ctx = await personaFor('group', conv);
      const draft = await draftOpener({
        ctx,
        now: t,
        buffer: buffers.get(conv) || [],
        pool: await memePool(),
        mood: moodWord(agency.mood),
        seen: seen || '',
      });
      if (!draft.ok) {
        await trace({ kind: 'group-opener-skip', conv, tier: gate.tier, reason: draft.reason, think: draft.message });
        continue;
      }

      const ok = await deliver(conv, { text: draft.say, image: draft.image }, { dry });
      await trace({ kind: 'group-opener', conv, tier: gate.tier, think: draft.think, say: draft.say, sent: Boolean(ok) });
      if (ok) {
        markGroupSpoke(db, conv, { now: t, text: draft.say, opts: g });
        log.info(`群里主动开个话头（${conv}，${gate.tier}）：${String(draft.say).slice(0, 80)}`);
      }
    }
    await saveGroups(db);
  }
  /** /心思 里的群聊那段 */
  const TIER_LABEL = { hot: '热闹', normal: '正常', quiet: '冷清', dead: '死寂' };
  async function groupLines(t) {
    const db = await loadGroups(t);
    const rows = Object.entries(db.groups)
      .filter(([, v]) => v && Number(v.lastMessageAt || 0) > 0)
      .sort((a, b) => Number(b[1].lastMessageAt) - Number(a[1].lastMessageAt))
      .slice(0, 4);
    if (!rows.length) return [];
    return rows.map(([conv, v]) => {
      const gid = conv.slice('group:'.length);
      const tier = tierOf(v, t, g);
      const q = quotaOf(v, t, g);
      const cool = Number(v.cooldownUntil || 0) > t.getTime() ? `，冷却到 ${clock(new Date(v.cooldownUntil))}` : '';
      const spoke = v.lastSpokeAt ? `，上次开口 ${clock(new Date(v.lastSpokeAt))}` : '';
      return `群 ${gid}：${TIER_LABEL[tier] || tier}（今天 ${Number(v.sentToday || 0)}/${q.daily}，机会分 ${Math.round(v.lastUrgency || 0)}，回声 ${Math.round(echoRateOf(v, t) * 100)}%，反感 ${Math.round(v.annoyance || 0)}${cool}${spoke}）`;
    });
  }

  /* ------------------------------- QQ 空间 ------------------------------- */

  const rpc = (timeoutMs) => ({
    ws: process.env.ONEBOT_WS || 'ws://127.0.0.1:3001',
    token: process.env.ONEBOT_TOKEN || '',
    timeoutMs: Number(timeoutMs) || Number(QZONE_DEFAULTS.timeoutMs),
  });

  function qzoneState(agency) {
    if (!agency.qzone || typeof agency.qzone !== 'object') agency.qzone = {};
    return agency.qzone;
  }

  /** 读一次动态（主人那页 + 自己那页），只记最近的，不把十年前的老帖翻出来 */
  async function readQzone(agency, t) {
    const qz = await qzConfig();
    const qa = qzoneState(agency);
    const who = ownerIds[0] || '';
    const freshMs = Math.max(1, Number(qz.freshDays) || 30) * 24 * 3_600_000;
    const targets = who ? [who, ''] : [''];
    const picked = [];
    let lastErr = null;

    for (const uin of targets) {
      const res = await readFeed({ ...rpc(qz.timeoutMs), uin, num: Number(qz.readNum) || 10 });
      if (!res.ok) {
        lastErr = res;
        continue;
      }
      for (const it of res.items || []) {
        if (!it.text) continue;
        if (t.getTime() - Number(it.at || 0) > freshMs) continue;
        const whose = who && it.uin === who ? '主人' : '我';
        picked.push({ text: `${whose}动态：${it.text.slice(0, 60)}`, at: it.at || t.getTime() });
      }
    }

    if (!picked.length && lastErr) {
      qa.fails = Number(qa.fails || 0) + 1;
      await trace({ kind: 'qzone-read-error', reason: lastErr.reason, message: lastErr.message, fails: qa.fails });
      return lastErr;
    }

    for (const p of picked.slice(0, 5)) await addNote('qzone', p.text, { at: p.at });
    qa.readDay = dayKey(t);
    qa.fails = 0;
    await trace({ kind: 'qzone-read', uin: who, count: picked.length, sample: picked.slice(0, 3).map((x) => x.text) });
    return { ok: true, items: picked };
  }

  /** A 档读动态 + B 档偶尔发一条纯文字说说（默认 dry-run，只写 trace 不发） */
  async function runQzone(agency, t, dry) {
    const qz = await qzConfig();
    if (!qz.enabled) return;
    const qa = qzoneState(agency);
    if (qa.disabled) return;
    if (Number(qa.fails || 0) >= Number(qz.maxFails)) {
      qa.disabled = true;
      await trace({ kind: 'qzone-disabled', fails: qa.fails });
      log.warn('QQ 空间连续失败，已自动停用（/空间 开 可恢复）');
      return;
    }

    const day = dayKey(t);

    if (t.getHours() >= Number(qz.readHour) && qa.readDay !== day) {
      await readQzone(agency, t);
    }

    if (!qz.publishEnabled) return;
    if (qa.sentDay === day) return;
    if (inQuietHours(t, quiet)) return;
    if (Number(agency.impulse.owner || 0) < Number(qz.impulseThreshold)) return;

    const ctx = await personaFor('private');
    const history = await recentForContext(petId, 8);
    const maxChars = Number(qz.maxChars) || 90;
    const res = await generateMood({ pet: ctx, now: t, history, mood: agency.mood, maxChars });
    if (!res.ok) {
      qa.fails = Number(qa.fails || 0) + 1;
      await trace({ kind: 'qzone-draft-error', reason: res.reason, message: res.message, fails: qa.fails });
      return;
    }
    if (!res.say) {
      qa.sentDay = day; // 今天决定不发，别每个 tick 再问一遍
      await trace({ kind: 'qzone-skip', think: res.think });
      return;
    }

    const body = cleanMood(res.say, maxChars);
    if (!body) {
      qa.sentDay = day;
      await trace({ kind: 'qzone-skip', think: res.think, why: 'empty-after-clean' });
      return;
    }

    if (qz.dryRun || dry) {
      qa.dryDay = day;
      await trace({ kind: 'qzone-dry', think: res.think, say: body, impulse: Math.round(agency.impulse.owner) });
      log.info(`[dry] 今天想发的说说：${body}`);
      return;
    }

    const posted = await publishMood({ ...rpc(qz.timeoutMs), text: body, maxChars });
    if (posted.ok) {
      qa.sentDay = day;
      qa.fails = 0;
      agency.impulse.owner = Math.max(0, Number(agency.impulse.owner || 0) - Number(qz.impulseCost));
      await trace({ kind: 'qzone-publish', think: res.think, say: posted.text });
      log.info(`发了条说说：${posted.text}`);
    } else {
      qa.fails = Number(qa.fails || 0) + 1;
      await trace({ kind: 'qzone-publish-error', reason: posted.reason, message: posted.message, fails: qa.fails });
      log.warn(`发说说失败（${posted.reason}）：${posted.message ?? ''}`);
    }
  }

  /* ------------------- S3：自己刷一下 B 站 / 抖音（只读） ------------------- */

  const FEED_DEFAULTS = {
    enabled: false,
    hours: [10, 20], // 一天两次，别刷个没完
    biliLimit: 5,
    douyinLimit: 5,
    importance: 0.35, // 比「主人发的说说」低：热搜是背景噪音，不是关系
    timeoutMs: 15_000,
  };
  let feedCache = null;

  async function feedConfig() {
    if (feedCache) return feedCache;
    const fromPet = (await loadPet())?.feeds;
    feedCache = { ...FEED_DEFAULTS, ...fromPet, ...(conf.feeds || {}) };
    return feedCache;
  }

  function feedState(agency) {
    if (!agency.feeds || typeof agency.feeds !== 'object') agency.feeds = {};
    if (!agency.feeds.days || typeof agency.feeds.days !== 'object') agency.feeds.days = {};
    return agency.feeds;
  }

  /** 到点各刷一次；同一小时只刷一次，天数只留最近 7 天（state.json 别无限长） */
  async function runFeeds(agency, t, dry = false) {
    const fc = await feedConfig();
    if (!fc.enabled) return;
    const fa = feedState(agency);
    const day = dayKey(t);
    const hour = t.getHours();
    const hours = (Array.isArray(fc.hours) ? fc.hours : FEED_DEFAULTS.hours)
      .map(Number)
      .filter((h) => Number.isFinite(h) && h >= 0 && h < 24);
    if (!hours.includes(hour)) return;
    const doneToday = Array.isArray(fa.days[day]) ? fa.days[day] : [];
    if (doneToday.includes(hour)) return;

    const res = await fetchSeen({
      biliLimit: Number(fc.biliLimit) || 5,
      douyinLimit: Number(fc.douyinLimit) || 5,
      timeoutMs: Number(fc.timeoutMs) || FEED_DEFAULTS.timeoutMs,
    });

    let wrote = 0;
    if (res.bili.ok) {
      for (const item of res.bili.items) {
        const n = await addNote('bilibili', biliNote(item), { at: t.getTime(), importance: fc.importance });
        if (n) wrote += 1;
      }
    } else {
      fa.biliFails = Number(fa.biliFails || 0) + 1;
      await trace({ kind: 'feeds-bili-error', reason: res.bili.reason, message: res.bili.message });
    }
    if (res.douyin.ok) {
      for (const item of res.douyin.items) {
        const n = await addNote('douyin', douyinNote(item), { at: t.getTime(), importance: fc.importance });
        if (n) wrote += 1;
      }
    } else {
      fa.douyinFails = Number(fa.douyinFails || 0) + 1;
      await trace({ kind: 'feeds-douyin-error', reason: res.douyin.reason, message: res.douyin.message });
    }

    fa.days[day] = [...doneToday, hour];
    fa.lastAt = t.getTime();
    const keep = Object.keys(fa.days).sort().slice(-7);
    for (const k of Object.keys(fa.days)) if (!keep.includes(k)) delete fa.days[k];

    await trace({
      kind: 'feeds-read',
      hour,
      bili: res.bili.ok ? res.bili.items.length : 0,
      douyin: res.douyin.ok ? res.douyin.items.length : 0,
      wrote,
      dry: Boolean(dry),
    });
    if (wrote) {
      log.info(`刷了一圈：B 站 ${res.bili.ok ? res.bili.items.length : '失败'}，抖音 ${res.douyin.ok ? res.douyin.items.length : '失败'}`);
    }
  }

  /** 自我模型：一天最多更新一次，字数硬上限、变化过大直接拒绝（防人格漂移） */
  async function refreshSelf(agency, t) {
    const cur = await loadSelf();
    if (cur && t.getTime() - Number(cur.updatedAt || 0) < 24 * 3_600_000) return;
    const pet = await loadPet();
    const ctx = await personaFor('private');
    const notes = await recentNotes(12);
    const chatted = notes.length
      ? notes.map((n) => `- ${n.text}`).join('\n')
      : '（最近没什么特别的事）';
    const res = await chatCompletion(
      [
        {
          role: 'system',
          content:
            '你在帮一个聊天机器人写「她对自己的认识」，会每轮作为背景注入，所以必须短、稳、不夸张。' +
            '用第一人称写 3~5 个短句、不超过 180 字：我是谁（名字、身份）、我在意什么、我跟主人是什么关系、最近心里挂着的一件事。' +
            '不要写日期、不要列点、不要承诺任何新的能力，也不要写成日记。',
        },
        {
          role: 'user',
          content: `她是「${ctx.name}」。最近她自己记得的事：\n${chatted}`,
        },
      ],
      { temperature: 0.4, maxTokens: 260 },
    );
    if (!res.ok || !res.text) return;
    const out = await updateSelf({ text: res.text, now: t.getTime() });
    await trace({ kind: 'self-update', ok: Boolean(out.ok), reason: out.reason ?? null, pet: pet?.pet?.name ?? null });
  }

  /** 每天一次的记忆保养：衰减 + 归档（S5 遗忘曲线） */
  async function runMemoryMaintenance(agency, t) {
    const day = dayKey(t);
    const ma = agency.memory && typeof agency.memory === 'object' ? agency.memory : (agency.memory = {});
    if (ma.decayedDay === day) return;
    if (t.getHours() < 4) return; // 凌晨 4 点后才算这天的账，避免刚过零点就动
    const res = await decayAndArchive({ now: t.getTime() });
    ma.decayedDay = day;
    ma.archived = Number(res.archived || 0);
    await trace({ kind: 'memory-decay', archived: res.archived, kept: res.kept });
    await refreshSelf(agency, t);
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
      if (!inQuietHours(t, quiet)) {
        await runGroups(agency, t, dry);
        await runOpeners(agency, t, dry);
      }
      // 空间也独立：读动态按 readHour，发说说自己看阈值/静默/dryRun
      await runQzone(agency, t, dry);
      // 自己刷 B 站/抖音（只读，进语义记忆），到配置的小时才动
      await runFeeds(agency, t, dry);
      // 每天一次的记忆保养（衰减 + 归档）
      await runMemoryMaintenance(agency, t);
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
        agency.qzone?.disabled
          ? '空间：已停用'
          : agency.qzone?.sentDay === dayKey(t)
            ? '空间：今天已经发过一条'
            : '空间：今天还没发',
        ...(await groupLines(t)),
      ].filter(Boolean);
      return lines.join('\n');
    }

    if (['空间', '说说', 'qzone'].includes(cmd)) {
      const agency = await loadAgency(t);
      const qz = await qzConfig();
      const qa = qzoneState(agency);
      const [sub = '', ...tail] = arg.split(/\s+/).filter(Boolean);
      const rest = tail.join(' ');
      const isOwner = !ownerIds.length || ownerIds.includes(String(msg?.senderId ?? ''));
      const maxChars = Number(qz.maxChars) || 90;

      if (sub === '发') {
        if (!isOwner) return '这个只有主人能让我发。';
        if (!rest) return '要发什么？发「/空间 发 今天天气不错」这样。';
        const body = cleanMood(rest, maxChars);
        const posted = await publishMood({ ...rpc(qz.timeoutMs), text: body, maxChars });
        await trace({ kind: 'qzone-manual', ok: posted.ok, reason: posted.reason, say: body });
        return posted.ok ? `发出去了：「${posted.text}」` : `没发成（${posted.reason}）：${posted.message ?? ''}`;
      }
      if (sub === '读') {
        const res = await readQzone(agency, t);
        await saveAgency(agency);
        return res.ok ? `看了 ${res.items?.length ?? 0} 条动态，记下来了。` : `看不了（${res.reason}）：${res.message ?? ''}`;
      }
      if (sub === '关') {
        qa.disabled = true;
        await saveAgency(agency);
        return '好，空间那边我先不碰了（不发也不看）。想恢复就发「/空间 开」。';
      }
      if (sub === '开') {
        qa.disabled = false;
        qa.fails = 0;
        await saveAgency(agency);
        return `开了。看动态每天 ${pad(qz.readHour)}:00 之后一次；发说说${qz.publishEnabled ? `每天最多 ${qz.dailyLimit} 条` : '还是关着的（配置里 publishEnabled=false）'}。`;
      }

      return [
        '【QQ 空间】',
        `状态：${qa.disabled ? '已停用' : qz.enabled ? '在用' : '没开（配置 qzone.enabled=false）'}`,
        `看动态：每天 ${pad(qz.readHour)}:00 之后读一次${qa.readDay ? `，今天已读` : '，今天还没读'}`,
        `发说说：${qz.publishEnabled ? `允许，每天最多 ${qz.dailyLimit} 条` : '只读不发'}${qz.dryRun ? '（dry-run，只预览不真发）' : ''}`,
        qa.sentDay === dayKey(t) ? '今天已经发过一条' : '今天还没发',
        qa.fails ? `连续失败：${qa.fails}/${qz.maxFails}` : '',
      ]
        .filter(Boolean)
        .join('\n');
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
