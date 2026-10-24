#!/usr/bin/env node
/**
 * dsh-pet ⇄ QQ 桥（OneBot v11 正向 WebSocket 客户端）。
 *
 * 数据流：QQ 消息 → OneBot 实现（NapCat / LLOneBot 等，跑在 QQ 里）→ 本桥的 WS
 *        → 本桥调 dsh-pet host 的 POST /dsh-pet-7340/chat → 回复 → send_msg 回 QQ。
 * 顺带：回复会同时写进桌宠气泡（host 自己写 state.pets.<id>.say），所以 QQ 里说话时
 * 桌面上的她也会张嘴——这是同一个人格、同一份记忆。
 *
 * 只依赖 Node 内置能力（全局 WebSocket / fetch），不需要 npm install。
 */
import { readFile } from 'node:fs/promises';
import { appendFile, mkdir, stat, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  applyPersona,
  chat,
  currentPrompt,
  fetchMemeImage,
  getPet,
  getState,
  identify,
  loadPersonas,
  recentMessages,
} from './lib/pet-api.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = join(here, 'bridge.config.json');
const DEFAULT_PERSONAS_PATH = join(here, 'personas.json');
const LOG_DIR = join(here, 'logs');

const HELP_TEXT = [
  '指令：',
  '/人格        看有哪几个人格，当前是谁',
  '/人格 2      切换人格（也可以写 id，比如 /人格 anmiao）',
  '/记忆        看最近几轮记忆',
  '/状态        看桌宠当前状态',
  '/心思        看她现在多想说话、心情如何、记着哪些承诺',
  '/承诺        看她答应过你、还没兑现的事',
  '/安静 [小时] 让她这段时间别主动找你（默认 12 小时）',
  '/说话        解除安静',
  '/ping        测一下我还在不在',
  '其它任何话都会被她当成聊天。',
].join('\n');

/* ---------------------------------- 日志 ---------------------------------- */

function makeLogger(tag) {
  let ready = false;
  const file = join(LOG_DIR, 'bridge.log');
  const line = (level, msg) => {
    const s = `[${new Date().toISOString()}] [${level}] [${tag}] ${msg}`;
    console.log(s);
    void (async () => {
      try {
        if (!ready) {
          await mkdir(LOG_DIR, { recursive: true });
          ready = true;
        }
        const st = await stat(file).catch(() => null);
        if (st && st.size > 2 * 1024 * 1024) await rename(file, file + '.1').catch(() => {});
        await appendFile(file, s + '\n', 'utf8');
      } catch {
        /* 日志写不进去不影响主流程 */
      }
    })();
  };
  return {
    info: (m) => line('INFO', m),
    warn: (m) => line('WARN', m),
    error: (m) => line('ERROR', m),
  };
}

/* ------------------------------- 消息事件解析 ------------------------------ */

const sep = (s) => String(s ?? '').trim();

/**
 * 把 OneBot 消息事件拍平成 { kind, text, atMe, ... }。
 * 群消息两种回法：at = 被 @ 才回（默认，最不烦人）；all = 群里每条都回。
 */
export function normalizeMessage(ev, behavior = {}, { observeGroups = false } = {}) {
  if (!ev || ev.post_type !== 'message') return null;
  const selfId = String(ev.self_id ?? '');
  const senderId = String(ev.sender?.user_id ?? ev.user_id ?? '');
  if (!senderId || senderId === selfId) return null; // 自己的消息（含机器人自己）不回，防自激

  const isGroup = ev.message_type === 'group';
  const segs = Array.isArray(ev.message) ? ev.message : null;
  let atMe = false;
  const parts = [];

  if (segs) {
    for (const s of segs) {
      const type = s?.type;
      const d = s?.data ?? {};
      if (type === 'text') parts.push(String(d.text ?? ''));
      else if (type === 'at') {
        if (String(d.qq) === selfId) atMe = true;
        else parts.push(`@${sep(d.name) || String(d.qq)}`);
      } else if (type === 'image') parts.push('[图片]');
      else if (type === 'face' || type === 'mface') parts.push('[表情]');
      // reply / record / video / file / json / xml 等：不参与对话正文
    }
  } else if (typeof ev.raw_message === 'string') {
    atMe = new RegExp(`\\[CQ:at,qq=${selfId}(?:,[^\\]]*)?\\]`).test(ev.raw_message);
    parts.push(
      ev.raw_message
        .replace(/\[CQ:at,[^\]]*\]/g, ' ')
        .replace(/\[CQ:[a-z]+,[^\]]*\]/gi, ' '),
    );
  }

  const text = sep(parts.join(' ')).replace(/\s+/g, ' ');
  const senderName = sep(ev.sender?.card) || sep(ev.sender?.nickname) || senderId;

  const groupReply = behavior.groupReply ?? 'at';
  let observeOnly = false;
  if (isGroup) {
    if (groupReply === 'off') return null;
    if (groupReply === 'at' && !atMe) {
      // 没 @ 她：正常不用回，但可以「旁听」——交给调度器攒冲动，由它决定要不要插话
      if (!observeGroups) return null;
      observeOnly = true;
    }
  } else if (behavior.privateReply === false) {
    return null;
  }

  if (!text) return null;

  return {
    kind: isGroup ? 'group' : 'private',
    selfId,
    senderId,
    senderName,
    groupId: isGroup ? String(ev.group_id) : undefined,
    messageId: String(ev.message_id ?? ''),
    atMe,
    observeOnly,
    text,
  };
}

/* --------------------------------- 桥主体 --------------------------------- */

/**
 * @param {object} opt
 * @param {object} opt.conf       bridge.config.json 内容
 * @param {object} opt.personas   personas.json 内容
 * @param {{send:(msg:object,segments:object[])=>Promise<object|null>}} opt.transport
 * @param {object} [opt.log]
 */
export function createBridge({ conf, personas, transport, log = makeLogger('bridge') }) {
  const petId = conf.pet?.id ?? 'main';
  const behavior = conf.behavior ?? {};
  const groupWhitelist = new Set((conf.groupWhitelist ?? []).map(String));
  const userBlacklist = new Set((conf.userBlacklist ?? []).map(String));
  const seen = new Map(); // messageId → ts（去重，OneBot 重连时可能重放）
  const queues = new Map(); // 会话 → Promise 链（同一会话串行，避免并发抢记忆锁）
  let stats = { received: 0, replied: 0, ignored: 0, failed: 0, proactive: 0 };
  /** 主动性调度器（可选注入；注入后才有「主动开口 / 承诺 / 心思」这些能力） */
  let scheduler = null;

  const dedupe = (id) => {
    if (!id) return false;
    const now = Date.now();
    for (const [k, t] of seen) if (now - t > 5 * 60_000) seen.delete(k);
    if (seen.has(id)) return true;
    seen.set(id, now);
    return false;
  };

  const enqueue = (key, fn) => {
    const prev = queues.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    queues.set(
      key,
      next.finally(() => {
        if (queues.get(key) === next) queues.delete(key);
      }),
    );
    return next;
  };

  const sendText = (msg, text) => transport.send(msg, [{ type: 'text', data: { text } }]);

  /** 挂上主动性调度器（云端 start-bot 会注入；本机不注入就退化成纯应答模式） */
  const attachScheduler = (s) => {
    scheduler = s;
  };

  /** 'private:12345' / 'group:67890' → sendReply 需要的伪消息对象 */
  const parseConv = (conv) => {
    const m = /^(private|group):(.+)$/.exec(String(conv || '').trim());
    if (!m) return null;
    return m[1] === 'group'
      ? { kind: 'group', groupId: m[2], senderId: m[2] }
      : { kind: 'private', senderId: m[2] };
  };

  /** 主动发一条（不依赖收到的消息）：走同一个会话队列，避免和回复交错 */
  const sendProactive = (conv, payload) => {
    const target = parseConv(conv);
    if (!target) {
      log.warn(`主动消息的目标无法解析：${conv}`);
      return Promise.resolve(false);
    }
    return enqueue(`p:${conv}`, async () => {
      const res = await sendReply(target, payload);
      if (res) stats.proactive += 1;
      return Boolean(res);
    });
  };

  async function sendReply(msg, reply) {
    const text = String(reply?.text ?? '').trim();
    // 表情包：先按概率决定要不要带（不必每句都带），再单独发一条，不和文字挤在同一个气泡
    const chance = Number.isFinite(Number(behavior.memeChance)) ? Number(behavior.memeChance) : 0.35;
    const wantImage = behavior.sendMeme !== false && Boolean(reply?.image) && Math.random() < chance;
    const dropped = behavior.sendMeme !== false && Boolean(reply?.image) && !wantImage;

    // 一条回复拆成几个气泡发（模型自己分好段就用它的分段；没有就一整条）
    const maxBubbles = Math.max(1, Math.min(4, Math.floor(Number(behavior.maxBubbles) || 3)));
    const bubbles = (Array.isArray(reply?.segments) && reply.segments.length
      ? reply.segments
      : [text]
    )
      .map((s) => String(s).trim())
      .filter(Boolean)
      .slice(0, maxBubbles);

    let sent = 0;
    for (let i = 0; i < bubbles.length; i += 1) {
      const piece = bubbles[i];
      // 第一条按「正在输入」延迟；之后每条模拟继续打字——短句快、长句慢，再加一点随机
      const wait =
        i === 0
          ? Number(behavior.typingDelayMs) || 0
          : Math.max(0, Number(behavior.bubbleDelayMs) || 700) +
            Math.min(600, piece.length * 22) +
            Math.random() * 250;
      if (wait) await new Promise((r) => setTimeout(r, wait));
      const r = await transport.send(msg, [{ type: 'text', data: { text: piece } }]);
      if (r) sent += 1;
      else {
        log.warn('气泡发送失败，剩下的不发了');
        break;
      }
    }

    if (wantImage) {
      const buf = await fetchMemeImage(reply.image, 'main');
      if (buf) {
        if (behavior.imageDelayMs) await new Promise((r) => setTimeout(r, behavior.imageDelayMs));
        const r = await transport.send(msg, [
          { type: 'image', data: { file: `base64://${buf.toString('base64')}` } },
        ]);
        if (r) sent += 1;
        else log.warn(`表情包「${reply.image}」发送失败（文字已发）`);
      } else if (!text) {
        await transport.send(msg, [{ type: 'text', data: { text: `（想发「${reply.image}」那张图，但找不到）` } }]);
        sent += 1;
      }
    } else if (dropped) {
      log.info(`这条不带图（概率过滤）：${reply.image}`);
    }

    if (!sent) {
      const r = await transport.send(msg, [{ type: 'text', data: { text: text || '……' } }]);
      if (r) sent += 1;
    }

    if (sent) stats.replied += 1;
    else stats.failed += 1;
    return sent ? true : null;
  }

  async function personaLine(surface = 'any') {
    const { pet, conf } = await getPet(petId);
    const surfaces = conf?.surfaces ?? {};
    const id = surface === 'group' ? surfaces.group : surface === 'private' ? surfaces.private : null;
    let active = id ? personas.personas.find((p) => p.id === id) ?? null : null;
    if (!active) {
      const prompt = await currentPrompt(petId, 'any');
      active = identify(personas, prompt, pet.name);
    }
    return { pet, active, surfaces };
  }

  async function handleCommand(msg) {
    const raw = msg.text.trim();
    const m = raw.match(/^[/／]([^\s/／]*)\s*([\s\S]*)$/);
    if (!m) return false;
    const cmd = m[1].toLowerCase();
    const arg = m[2].trim();
    // 群聊/私聊各自的记忆桶（/记忆 要用；handleEvent 里的 conv 不在这个作用域）
    const conv = msg.kind === 'group' ? `group:${msg.groupId}` : `private:${msg.senderId}`;

    if (['help', '帮助', '?'].includes(cmd)) {
      await sendText(msg, HELP_TEXT);
      return true;
    }

    if (['人格', '人设', 'persona'].includes(cmd)) {
      if (!arg) {
        const { active, surfaces } = await personaLine(msg.kind);
        const byId = (id) => personas.personas.find((p) => p.id === id) ?? null;
        const priv = byId(surfaces.private ?? null);
        const grp = byId(surfaces.group ?? null);
        const lines = [
          `私聊：${priv ? priv.label : active ? active.label : '未单独设置'}`,
          `群聊：${grp ? grp.label : '（跟私聊一样）'}`,
          '',
          ...personas.personas.map((p, i) => `${i + 1}. ${p.label} —— ${p.tagline}`),
          '',
          `发「/人格 2」或「/人格 lin」就在**当前这个${msg.kind === 'group' ? '群' : '私聊'}**里换。`,
        ];
        await sendText(msg, lines.join('\n'));
        return true;
      }
      const list = personas.personas;
      const target = /^\d+$/.test(arg) ? list[Number(arg) - 1] : list.find((p) => p.id.toLowerCase() === arg.toLowerCase());
      if (!target) {
        await sendText(msg, `没有这个人格哦，可选：${list.map((p, i) => `${i + 1}=${p.id}`).join('、')}`);
        return true;
      }
      await applyPersona(target, { petId, surface: msg.kind });
      const scope = msg.kind === 'group' ? '这个群' : '私聊';
      log.info(`人格切换 → ${target.id}（${scope}，by ${msg.senderName}/${msg.senderId}）`);
      await sendText(msg, `${scope}换成「${target.name}」了。（${target.tagline}）`);
      return true;
    }

    if (['记忆', 'memory'].includes(cmd)) {
      const n = Number(arg) > 0 ? Math.min(Number(arg), 20) : 3;
      const r = await recentMessages(petId, n * 2, { surface: msg.kind, conv });
      const msgs = Array.isArray(r?.messages) ? r.messages.slice(-n * 2) : [];
      if (!msgs.length) {
        await sendText(msg, '记忆还是空白的。');
        return true;
      }
      const txt = msgs
        .map((x) => `${x.role === 'user' ? '你' : '她'}：${String(x.content).slice(0, 120)}`)
        .join('\n');
      await sendText(msg, txt);
      return true;
    }

    if (['状态', 'status'].includes(cmd)) {
      const [{ pet, active, surfaces }, state] = await Promise.all([personaLine(msg.kind), getState()]);
      const byId = (id) => personas.personas.find((p) => p.id === id) ?? null;
      const priv = byId(surfaces.private ?? null);
      const grp = byId(surfaces.group ?? null);
      const say = state?.pets?.[petId]?.say?.data?.text ?? '（没在说话）';
      await sendText(
        msg,
        [
          `宠物：${pet.name}（${petId}）`,
          `人格：私聊=${priv ? priv.label : active ? active.label : '未设置'}，群聊=${grp ? grp.label : '跟私聊一样'}`,
          `气泡：${String(say).slice(0, 80)}`,
          `模式：群=${behavior.groupReply ?? 'at'}，私聊=${behavior.privateReply === false ? '关' : '开'}`,
          `表情包：${behavior.sendMeme === false ? '关' : `约 ${Math.round((Number(behavior.memeChance) || 0.35) * 100)}% 的回复带一张`}`,
          `统计：收 ${stats.received} / 回 ${stats.replied} / 忽略 ${stats.ignored} / 失败 ${stats.failed}`,
        ].join('\n'),
      );
      return true;
    }

    if (cmd === 'ping') {
      await sendText(msg, 'pong');
      return true;
    }

    // 主动性相关指令（/心思 /承诺 /安静 /说话）挂在调度器上，没注入就跳过
    if (scheduler?.command) {
      const extra = await scheduler.command(msg);
      if (extra) {
        await sendText(msg, extra);
        return true;
      }
    }

    return false; // 不认识的 /xxx 当成普通聊天，交给她
  }

  /** 处理一条 OneBot 事件（transport 已把回复发出去） */
  async function handleEvent(ev) {
    if (ev?.post_type === 'meta_event') {
      if (ev.meta_event_type === 'lifecycle') log.info(`OneBot 就绪：self_id=${ev.self_id} (${ev.sub_type ?? ''})`);
      return null;
    }
    const msg = normalizeMessage(ev, behavior, { observeGroups: behavior.observeGroups !== false });
    if (!msg) {
      stats.ignored += 1;
      return null;
    }
    if (dedupe(msg.messageId)) {
      stats.ignored += 1;
      return null;
    }
    if (msg.kind === 'group' && groupWhitelist.size && !groupWhitelist.has(msg.groupId)) {
      stats.ignored += 1;
      return null;
    }
    if (userBlacklist.has(msg.senderId)) {
      stats.ignored += 1;
      return null;
    }
    stats.received += 1;

    const key = msg.kind === 'group' ? `g:${msg.groupId}` : `u:${msg.senderId}`;
    const conv = msg.kind === 'group' ? `group:${msg.groupId}` : `private:${msg.senderId}`;
    return enqueue(key, async () => {
      try {
        // 群里的每条消息都喂给调度器「旁听」：不 @ 她也会攒冲动，由调度器决定要不要插话
        if (msg.kind === 'group' && scheduler?.onGroupMessage) {
          try {
            await scheduler.onGroupMessage({ conv, text: msg.text, name: msg.senderName, atBot: msg.atMe });
          } catch (e) {
            log.warn(`onGroupMessage：${e?.message ?? e}`);
          }
        }
        if (msg.observeOnly) {
          stats.ignored += 1;
          return null;
        }

        await scheduler?.onInbound?.({ conv, text: msg.text });
        if (await handleCommand(msg)) return null;

        if (behavior.logMessages !== false) {
          log.info(`${msg.kind === 'group' ? `群${msg.groupId}` : `私聊${msg.senderId}`} ${msg.senderName}: ${msg.text.slice(0, 120)}`);
        }

        // 群聊里带上说话人，单一人格/单一记忆不至于把张三李四搞混
        const input =
          msg.kind === 'group' ? `【${msg.senderName}】${msg.text}` : msg.text;
        const capped = input.length > 2000 ? input.slice(0, 2000) : input;

        const reply = await chat(capped, { petId, surface: msg.kind, conv });
        if (!reply?.ok) {
          log.warn(`生成失败：${reply?.reason} ${reply?.message ?? ''}`);
          await sendText(msg, behavior.errorReply ?? '呜……脑袋卡住了，等我一下下。');
          stats.failed += 1;
          return null;
        }
        log.info(`回复：${String(reply.text).slice(0, 120)}${reply.image ? ` [图:${reply.image}]` : ''}`);
        await sendReply(msg, reply);
        // 承诺抽取要再调一次模型，不阻塞本会话队列
        void scheduler?.onExchange?.({ conv, userText: msg.text, replyText: reply.text })?.catch?.((e) =>
          log.warn(`onExchange: ${e?.message ?? e}`),
        );
        return reply;
      } catch (e) {
        stats.failed += 1;
        log.error(`处理消息失败：${e?.message ?? e}`);
        await sendText(msg, behavior.errorReply ?? '呜……脑袋卡住了，等我一下下。').catch(() => {});
        return null;
      }
    });
  }

  return { handleEvent, sendText, sendProactive, attachScheduler, stats };
}

/* ------------------------------ OneBot WS 客户端 ----------------------------- */

function connectOneBot({ conf, onEvent, log }) {
  const url = new URL(conf.onebot?.ws ?? 'ws://127.0.0.1:3001');
  if (conf.onebot?.accessToken) url.searchParams.set('access_token', conf.onebot.accessToken);

  let ws = null;
  let closedByUs = false;
  let attempt = 0;
  let selfId = null;
  const pending = new Map();
  let echoSeq = 0;

  const send = (action, params) =>
    new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== 1) return reject(new Error('WS 未连接'));
      const echo = `echo-${++echoSeq}`;
      const timer = setTimeout(() => {
        pending.delete(echo);
        reject(new Error(`OneBot 动作超时：${action}`));
      }, 15000);
      pending.set(echo, { resolve, reject, timer });
      ws.send(JSON.stringify({ action, params, echo }));
    });

  const sendMsg = async (msg, segments) => {
    const params =
      msg.kind === 'group'
        ? { message_type: 'group', group_id: Number(msg.groupId), message: segments }
        : { message_type: 'private', user_id: Number(msg.senderId), message: segments };
    try {
      const r = await send('send_msg', params);
      return r ?? {};
    } catch (e) {
      log.error(`发送失败：${e.message}`);
      return null;
    }
  };

  const open = () => {
    if (closedByUs) return;
    attempt += 1;
    log.info(`连接 OneBot：${url.origin}${url.pathname}（第 ${attempt} 次）`);
    ws = new WebSocket(url.toString());

    ws.addEventListener('open', () => {
      attempt = 0;
      log.info('OneBot WS 已连接');
    });

    ws.addEventListener('message', (e) => {
      let data;
      try {
        data = JSON.parse(typeof e.data === 'string' ? e.data : String(e.data));
      } catch {
        return;
      }
      if (data?.echo && pending.has(data.echo)) {
        const p = pending.get(data.echo);
        pending.delete(data.echo);
        clearTimeout(p.timer);
        if (data.status === 'failed' || data.retcode !== 0) p.reject(new Error(JSON.stringify(data).slice(0, 200)));
        else p.resolve(data.data);
        return;
      }
      if (data?.post_type === 'meta_event' && data.meta_event_type === 'lifecycle') selfId = data.self_id;
      onEvent(data);
    });

    ws.addEventListener('error', () => {
      log.warn('OneBot WS 连接错误（详情见下一条 error 日志或框架侧）');
    });

    ws.addEventListener('close', () => {
      if (closedByUs) return;
      const delay = Math.min(30000, 2000 * attempt);
      log.warn(`OneBot WS 关闭，${delay / 1000}s 后重连`);
      setTimeout(open, delay);
    });
  };

  return {
    sendMsg,
    start: open,
    stop: () => {
      closedByUs = true;
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
    },
    get selfId() {
      return selfId;
    },
  };
}

/* --------------------------------- 入口 --------------------------------- */

async function loadJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (e) {
    if (!fallback) throw e;
    return fallback;
  }
}

export async function start(configPath = DEFAULT_CONFIG_PATH) {
  const conf = await loadJson(configPath);
  const personas = await loadPersonas(process.env.DSH_PET_PERSONAS ?? DEFAULT_PERSONAS_PATH);
  const log = makeLogger('bridge');

  const onebot = connectOneBot({
    conf,
    log,
    onEvent: (ev) => {
      bridge.handleEvent(ev).catch((e) => log.error(`handleEvent: ${e?.message ?? e}`));
    },
  });
  const transport = { send: (msg, segments) => onebot.sendMsg(msg, segments) };
  const bridge = createBridge({ conf, personas, transport, log });

  onebot.start();
  log.info(`桥已启动：pet=${conf.pet?.id ?? 'main'} surface=${conf.pet?.surface ?? 'any'} ws=${conf.onebot?.ws}`);

  const shutdown = () => {
    log.info('收到退出信号，断开 OneBot');
    onebot.stop();
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return { bridge, onebot };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start(process.argv[2] ? process.argv[2] : DEFAULT_CONFIG_PATH).catch((e) => {
    console.error('启动失败：' + (e?.message ?? e));
    process.exitCode = 1;
  });
}
