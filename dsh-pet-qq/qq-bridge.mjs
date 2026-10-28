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
  '指令（只有主人发才生效）：',
  '/人格        看有哪几个人格、私聊/群聊/每个群各是谁',
  '/人格 2      当前场景换人格：群里只换这个群，私聊换私聊档（也可以写 id，比如 /人格 anmiao）',
  '/人格 群 1106592574 2   在私聊里给指定群单独换人格',
  '/记忆        看最近几轮记忆',
  '/状态        看桌宠当前状态（含本群人格）',
  '/心思        看她现在多想说话、心情如何、记着哪些承诺',
  '/承诺        看她答应过你、还没兑现的事',
  '/安静 [小时] 让她这段时间别主动找你（默认 12 小时）',
  '/说话        解除安静',
  '/空间        看她 QQ 空间在不在用、今天发没发',
  '/空间 发 内容 手动发一条纯文字说说（仅主人）',
  '/空间 关     让她别碰空间（不发也不看），/空间 开 恢复',
  '/看到        她最近刷到/看到的事（说说、B 站、抖音）',
  '/忘记 关键词 让她忘掉相关的语义记忆',
  '/我是谁      看她对自己的认识',
  '/解禁 [群号] 清掉某个群的“反感度冷却”（默认当前群）',
  '/规矩 [内容] 定一条硬规矩（/规矩 删 1 删除，/规矩 看全部）',
  '/画像        这个群里她攒的说话印象（群昵称、话多话少、常提什么）',
  '/用量 [天数] token 账本（默认近 7 天，按聊天/主动/群/说说分开）',
  '/余额        DeepSeek 账户还剩多少钱',
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

/** get_msg 返回的 message（数组或 CQ 字符串）→ 纯文本，引用回复里显示用 */
export function segmentsToPlain(segs) {
  if (!Array.isArray(segs)) return sep(segs).replace(/\s+/g, ' ');
  const out = [];
  for (const s of segs) {
    const d = s?.data ?? {};
    if (s?.type === 'text') out.push(String(d.text ?? ''));
    else if (s?.type === 'at') out.push(`@${sep(d.name) || String(d.qq ?? '')}`);
    else if (s?.type === 'image') out.push('[图片]');
    else if (s?.type === 'face' || s?.type === 'mface') out.push('[表情]');
  }
  return sep(out.join(' ')).replace(/\s+/g, ' ');
}

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
  let quoteId = '';
  const parts = [];
  const ats = []; // 这条消息 @ 了谁（qq + 客户端给的名字），群聊里随后换成群昵称
  const images = []; // 这条消息里的图片地址（交给视觉模型看图）

  if (segs) {
    for (const s of segs) {
      const type = s?.type;
      const d = s?.data ?? {};
      if (type === 'text') parts.push(String(d.text ?? ''));
      else if (type === 'at') {
        if (String(d.qq) === selfId) atMe = true;
        else {
          const qq = String(d.qq ?? '');
          const name = sep(d.name);
          ats.push({ qq, name });
          parts.push(`@${name || qq}`);
        }
      } else if (type === 'image') {
        parts.push('[图片]');
        const u = String(d.url || d.file || '').trim();
        if (u) images.push(u);
      }
      else if (type === 'face' || type === 'mface') parts.push('[表情]');
      else if (type === 'reply') quoteId = String(d.id ?? '');
      // record / video / file / json / xml 等：不参与对话正文
    }
  } else if (typeof ev.raw_message === 'string') {
    atMe = new RegExp(`\\[CQ:at,qq=${selfId}(?:,[^\\]]*)?\\]`).test(ev.raw_message);
    quoteId = /\[CQ:reply,id=(-?\d+)[^\]]*\]/.exec(ev.raw_message)?.[1] ?? '';
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
    quoteId,
    atMe,
    ats,
    images,
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
  // 指令白名单：只有这些 QQ 号的指令会生效（群里别人发 /人格、/安静 之类一概不认）
  const ownerIds = new Set((conf.proactive?.ownerIds ?? []).map(String).filter(Boolean));
  const isOwner = (id) => (ownerIds.size === 0 ? true : ownerIds.has(String(id ?? '')));
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

  /* ----------------------- 引用回复（谁引用了谁的那句话） ----------------------- */

  const quoteCache = new Map(); // 被引用消息 id → { at, name, text, isSelf }
  const QUOTE_TTL = 10 * 60_000;
  const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n)}…` : String(s));

  /** 消息里带 reply 段时，把被引用的那句话捞出来（get_msg），拿不到就安静地忽略 */
  async function quoteOf(msg) {
    const id = String(msg.quoteId ?? '').trim();
    if (!id) return null;
    const hit = quoteCache.get(id);
    if (hit && Date.now() - hit.at < QUOTE_TTL) return hit;
    if (typeof transport.call !== 'function') return null;
    let data;
    try {
      data = await transport.call('get_msg', { message_id: Number(id) || id });
    } catch (e) {
      log.warn(`取被引用的消息失败：${e?.message ?? e}`);
      return null;
    }
    const text = segmentsToPlain(data?.message).slice(0, 200);
    const segs = Array.isArray(data?.message) ? data.message : [];
    const quoteImages = segs
      .filter((s) => s?.type === 'image')
      .map((s) => String(s?.data?.url || s?.data?.file || '').trim())
      .filter(Boolean);
    if (!text && !quoteImages.length) return null;
    const quote = {
      at: Date.now(),
      name: sep(data?.sender?.card) || sep(data?.sender?.nickname) || String(data?.sender?.user_id ?? '某人'),
      text,
      images: quoteImages,
      isSelf: String(data?.sender?.user_id ?? '') === String(msg.selfId ?? ''),
    };
    if (quoteCache.size > 200) quoteCache.clear();
    quoteCache.set(id, quote);
    return quote;
  }

  /* ----------------------------- 看图（图片 → 文字） ----------------------------- */

  const imageBuf = new Map(); // conv → [{ at, from, url, desc }]
  const IMAGE_TTL = 20 * 60_000;
  const IMAGE_KEEP = 3;

  const apiLib = async () => {
    try {
      return await import('./lib/pet-api.mjs');
    } catch {
      return null;
    }
  };

  /** 一张图 → 一句中文描述；任何失败都返回 null，绝不挡回复 */
  async function describe(url) {
    if (!url) return null;
    const api = await apiLib();
    if (typeof api?.describeImage !== 'function') return null;
    try {
      return await api.describeImage(url);
    } catch (e) {
      log.warn(`看图失败：${e?.message ?? e}`);
      return null;
    }
  }

  const convOf = (msg) => (msg.kind === 'group' ? `group:${msg.groupId}` : `private:${msg.senderId}`);

  /** 记一笔「这个会话刚有谁发了图」，供后面「这样」这类指代使用 */
  function rememberImage(msg) {
    const urls = Array.isArray(msg.images) ? msg.images : [];
    if (!urls.length) return;
    const key = convOf(msg);
    const list = (imageBuf.get(key) ?? []).filter((x) => Date.now() - x.at < IMAGE_TTL);
    for (const url of urls.slice(0, 3)) list.push({ at: Date.now(), from: msg.senderName, url, desc: '' });
    while (list.length > IMAGE_KEEP) list.shift();
    imageBuf.set(key, list);
  }

  /** 当前这条消息里的图：看懂了就写进正文（[图片：…]） */
  async function describeIncoming(msg) {
    const urls = Array.isArray(msg.images) ? msg.images : [];
    if (!urls.length) return;
    const descs = [];
    for (const url of urls.slice(0, 2)) {
      const d = await describe(url);
      if (d) descs.push(d);
    }
    if (!descs.length) return;
    let i = 0;
    msg.text = String(msg.text).replace(/\[图片\]/g, () => (i < descs.length ? `[图片：${descs[i++]}…]` : '[图片]'));
  }

  /** 会话里最近发过的图（含被引用的那张）——模型才接得住「这样」「这个」 */
  async function recentImagesBrief(msg, quote) {
    const key = convOf(msg);
    const list = (imageBuf.get(key) ?? []).filter((x) => Date.now() - x.at < IMAGE_TTL);
    const picked = list.slice(-2);
    const quoteUrl = quote?.images?.[0];
    if (quoteUrl && !picked.some((x) => x.url === quoteUrl)) {
      picked.push({ at: Date.now(), from: quote.name, url: quoteUrl, desc: '' });
    }
    const lines = [];
    for (const item of picked) {
      if (!item.desc) item.desc = (await describe(item.url)) || '';
      if (item.desc) lines.push(`- ${item.from} 发过一张图：${clip(item.desc, 90)}`);
    }
    if (!lines.length) return '';
    return `【这个会话里刚发过的图】最近真有人发过这些图，对方说「这样」「这个」时先对到这里来：\n${lines.join('\n')}`;
  }
  /* -------------------- 群成员称呼（群昵称，不拿 QQ 号凑数） -------------------- */

  const memberCache = new Map(); // `${groupId}:${userId}` → { at, name }
  const MEMBER_TTL = 30 * 60_000;

  /** 取群名片（群昵称），取不到退昵称；缓存 30 分钟，避免每条消息都打接口 */
  async function memberName(groupId, userId) {
    const gid = String(groupId ?? '');
    const uid = String(userId ?? '');
    if (!gid || !uid) return '';
    const key = `${gid}:${uid}`;
    const hit = memberCache.get(key);
    if (hit && Date.now() - hit.at < MEMBER_TTL) return hit.name;
    if (typeof transport.call !== 'function') return '';
    let name = '';
    try {
      const d = await transport.call('get_group_member_info', {
        group_id: Number(gid) || gid,
        user_id: Number(uid) || uid,
        no_cache: false,
      });
      name = sep(d?.card) || sep(d?.nickname) || '';
    } catch (e) {
      log.warn(`取群成员昵称失败（群${gid}/${uid}）：${e?.message ?? e}`);
    }
    if (memberCache.size > 500) memberCache.clear();
    memberCache.set(key, { at: Date.now(), name });
    return name;
  }

  /** 把消息里的 @QQ号 换成 @群昵称——模型该看到「@HudsonZephyr」，不是「@1360153202」 */
  async function resolveAtNames(msg) {
    if (msg.kind !== 'group') return;
    const list = Array.isArray(msg.ats) ? msg.ats : [];
    for (const at of list) {
      if (!at.qq) continue;
      const name = (await memberName(msg.groupId, at.qq)) || at.name || '';
      if (!name || name === at.qq) continue;
      at.resolved = name;
      msg.text = msg.text.replace(new RegExp(`@${at.qq}(?!\\d)`, 'g'), `@${name}`);
    }
  }

  /**
   * 群聊的「谁在说话」提示：说话人是群友还是主人。
   * 之前只给个【昵称】，模型会顺着人设把随便哪个群友都叫「主人」——这里把身份说死。
   */
  async function groupSpeakerNote(msg) {
    if (msg.kind !== 'group') return '';
    const speaker = (await memberName(msg.groupId, msg.senderId)) || msg.senderName;
    msg.senderName = speaker;
    const ownerId = [...ownerIds][0] ?? '';
    if (!ownerId) return `【群聊】说话的是群友「${speaker}」。`;
    // 主人可能有多个号：优先用「确实在这个群里」的那个的名字
    let ownerName = '';
    for (const id of ownerIds) {
      const n = await memberName(msg.groupId, id);
      if (n) {
        ownerName = n;
        break;
      }
    }
    if (!ownerName) ownerName = (await memberName(msg.groupId, ownerId)) || '主人';
    if (isOwner(msg.senderId)) return `【群聊】这条是主人本人说的（群里叫「${ownerName}」）。`;
    return (
      `【群聊】说话的是群友「${speaker}」，不是主人；主人是群里的「${ownerName}」。` +
      '别把群友叫成主人，也别拿 QQ 号当名字。'
    );
  }

  /**
   * 模型看到的正文：群里带说话人；有引用就把「被引的那句」写在前面，
   * 让她知道这句话是在接谁、接哪句，而不是凭空冒出来。
   */
  async function promptInput(msg, quote) {
    const who = isOwner(msg.senderId) ? `${msg.senderName}·主人` : msg.senderName;
    const head = msg.kind === 'group' ? `【${who}】` : '';
    await describeIncoming(msg);
    const note = await groupSpeakerNote(msg);
    const brief = await recentImagesBrief(msg, quote);
    const body = !quote
      ? `${head}${msg.text}`
      : `${head}（${quote.isSelf ? '引用了你自己刚才说的话' : `引用了${quote.name}的话`}：「${clip(quote.text, 120)}」）\n${msg.text}`;
    const parts = [note, brief, body].filter(Boolean);
    return parts.join('\n');
  }

  const quoteMode = String(behavior.quoteReply ?? 'auto').toLowerCase();
  /** 出站要不要带引用：auto = 被引用一定引用回、群里跟她说话也引用；私聊其余情况不引用 */
  function shouldQuote(msg) {
    if (quoteMode === 'off' || quoteMode === 'never' || !msg?.messageId) return false;
    if (quoteMode === 'always' || quoteMode === 'on') return true;
    return Boolean(msg.quoteId) || (msg.kind === 'group' && (msg.atMe || msg.addressedByQuote));
  }

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
    // 出站最后一道闸：模型偶尔会把内部结构（system_reminder / DSML / 我们拼进 prompt 的段落）
    // 当正文吐出来，漏一条人设就穿帮。云端 pet-api 已经洗过一遍，本机后端也要兜住。
    const scrub = (s) =>
      String(s ?? '')
        .replace(/<system[_-]?reminder>[\s\S]*?<\/system[_-]?reminder>/gi, '')
        .replace(/<\/?(?:DSML|dsml|tool_call|tool_result|function_calls?)\b[^>]*>/g, '')
        .replace(/^[ \t]*【(?:回复方式|规矩|你想起来的|你最近看到的|现在的心情|说话的人|这个会话里刚发过的图)】.*$/gmu, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    const text = scrub(reply?.text);
    // 带不带图**已经在生成层决定过了**（云端大脑只在有资格时才会给出图），
    // 这里不再掷一次骰子——发送层过滤等于挑完图再扔掉，纯浪费 token。
    const wantImage = behavior.sendMeme !== false && Boolean(reply?.image);

    // 一条回复拆成几个气泡（条数由内容决定，模型自己分好段就用它的分段）
    const maxBubbles = Math.max(1, Math.min(8, Math.floor(Number(behavior.maxBubbles) || 6)));
    const bubbles = (Array.isArray(reply?.segments) && reply.segments.length
      ? reply.segments
      : [text]
    )
      .map((s) => scrub(s))
      .filter(Boolean)
      .slice(0, maxBubbles);

    let sent = 0;
    for (let i = 0; i < bubbles.length; i += 1) {
      const piece = bubbles[i];
      // 第一条按「正在输入」延迟；之后每条模拟继续打字——短句快、长句慢，再加一点随机。
      // 最后一条如果很短（「嗯」「好」「对了」），多等一会儿：真人补一句前会停一下。
      const isTail = i === bubbles.length - 1 && i > 0 && piece.length <= 12;
      const wait =
        i === 0
          ? Number(behavior.typingDelayMs) || 0
          : Math.max(0, Number(behavior.bubbleDelayMs) || 700) +
            Math.min(600, piece.length * 22) +
            Math.random() * 250 +
            (isTail ? Math.max(0, Number(behavior.tailPauseMs) || 800) : 0);
      if (wait) await new Promise((r) => setTimeout(r, wait));
      // 只有第一条带引用段：后面几条继续接在同一个话头上
      const segments = [{ type: 'text', data: { text: piece } }];
      if (i === 0 && shouldQuote(msg)) segments.unshift({ type: 'reply', data: { id: String(msg.messageId) } });
      const r = await transport.send(msg, segments);
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
    }

    if (!sent) {
      const r = await transport.send(msg, [{ type: 'text', data: { text: text || '……' } }]);
      if (r) sent += 1;
    }

    // 语音：只私聊、只按概率，合成失败就当没这回事（绝不因为语音挂掉把文字也丢了）
    const voiceConf = behavior.voice || {};
    if (voiceConf.enabled !== false && msg.kind === 'private' && text) {
      try {
        const tts = await import('./lib/tts.mjs').catch(() => null);
        if (tts?.shouldSpeak?.(voiceConf, { kind: msg.kind }) && tts?.synthesizeBuffer) {
          const spoken = await tts.synthesizeBuffer(text, { conf: voiceConf });
          if (spoken?.ok && spoken.buffer) {
            if (behavior.voiceDelayMs) await new Promise((r) => setTimeout(r, Number(behavior.voiceDelayMs)));
            const r = await transport.send(msg, [
              { type: 'record', data: { file: `base64://${spoken.buffer.toString('base64')}` } },
            ]);
            if (r) sent += 1;
            else log.warn('语音发送失败（文字已发）');
          } else if (spoken && spoken.reason !== 'empty-text') {
            log.warn(`语音合成失败：${spoken.reason} ${spoken.message ?? ''}`);
          }
        }
      } catch (e) {
        log.warn(`语音流程异常：${e?.message ?? e}`);
      }
    }

    if (sent) stats.replied += 1;
    else stats.failed += 1;
    return sent ? true : null;
  }

  async function personaLine(surface = 'any', conv = '') {
    const { pet, conf } = await getPet(petId);
    const surfaces = conf?.surfaces ?? {};
    const groups = surfaces.groups ?? {};
    const groupKey = surface === 'group' ? String(conv ?? '').replace(/^group:/, '') : '';
    const id =
      surface === 'group' && groupKey
        ? groups[groupKey] ?? surfaces.group
        : surface === 'group'
          ? surfaces.group
          : surface === 'private'
            ? surfaces.private
            : null;
    let active = id ? personas.personas.find((p) => p.id === id) ?? null : null;
    if (!active) {
      const prompt = await currentPrompt(petId, 'any');
      active = identify(personas, prompt, pet.name);
    }
    return { pet, active, surfaces, groups, groupKey };
  }

  async function handleCommand(msg) {
    const raw = msg.text.trim();
    const m = raw.match(/^[/／]([^\s/／]*)\s*([\s\S]*)$/);
    if (!m) return false;
    const cmd = m[1].toLowerCase();
    const arg = m[2].trim();
    // 群聊/私聊各自的记忆桶（/记忆 要用；handleEvent 里的 conv 不在这个作用域）
    const conv = msg.kind === 'group' ? `group:${msg.groupId}` : `private:${msg.senderId}`;

    // 指令只认主人（proactive.ownerIds）：群里别人发的 /人格、/安静 之类一律吞掉、不回复
    if (!isOwner(msg.senderId)) {
      log.info(`忽略非主人指令：${cmd}（${msg.senderName}/${msg.senderId}，${msg.kind === 'group' ? `群${msg.groupId}` : '私聊'}）`);
      stats.ignored += 1;
      return true;
    }

    if (['help', '帮助', '?'].includes(cmd)) {
      await sendText(msg, HELP_TEXT);
      return true;
    }

    if (['人格', '人设', 'persona'].includes(cmd)) {
      // 语法：
      //   /人格                      → 面板（私聊档 / 群聊默认 / 每个群的单独设置）
      //   /人格 2                    → 当前会话换（群里=只换这个群，私聊=私聊档）
      //   /人格 群 <群号> 2          → 在私聊里给指定群换（也可以直接在群里发 /人格 2）
      //   /人格 群 <群号>            → 看那个群现在是谁
      const parts = arg.split(/\s+/).filter(Boolean);
      let groupArg = '';
      if (parts[0] && ['群', 'qun', 'group'].includes(parts[0].toLowerCase())) {
        groupArg = String(parts[1] ?? '').trim();
        parts.splice(0, 2);
      }
      if (groupArg && !/^\d{5,}$/.test(groupArg)) {
        await sendText(msg, '群号得是数字哦，比如：/人格 群 1106592574 2');
        return true;
      }
      const list = personas.personas;
      const byId = (id) => list.find((p) => p.id === id) ?? null;
      const targetConv = groupArg ? `group:${groupArg}` : conv;

      if (!parts.length) {
        const { active, surfaces, groups } = await personaLine(msg.kind, targetConv);
        const priv = byId(surfaces.private ?? null);
        const grp = byId(surfaces.group ?? null);
        const overrides = Object.entries(groups || {})
          .map(([gid, pid]) => {
            const p = byId(pid);
            return `  · 群 ${gid}：${p ? p.label : pid}`;
          })
          .sort();
        const lines = [
          `私聊：${priv ? priv.label : active ? active.label : '未单独设置'}`,
          `群聊默认：${grp ? grp.label : '（跟私聊一样）'}`,
          ...(overrides.length ? ['单独设置的群：', ...overrides] : []),
        ];
        if (msg.kind === 'group') {
          const cur = byId(groups?.[msg.groupId] ?? null) ?? byId(surfaces.group ?? null);
          lines.splice(2, 0, `本群（${msg.groupId}）：${cur ? cur.label : priv ? priv.label : '跟私聊一样'}`);
        }
        lines.push(
          '',
          ...list.map((p, i) => `${i + 1}. ${p.label} —— ${p.tagline}`),
          '',
          msg.kind === 'group'
            ? '发「/人格 2」只换这个群；想在私聊里给某个群换：/人格 群 <群号> 2'
            : '发「/人格 2」换私聊；给某个群单独换：/人格 群 <群号> 2',
        );
        await sendText(msg, lines.join('\n'));
        return true;
      }

      const want = parts.join(' ');
      const target = /^\d+$/.test(want) ? list[Number(want) - 1] : byId(want) ?? list.find((p) => p.id.toLowerCase() === want.toLowerCase());
      if (!target) {
        await sendText(msg, `没有这个人格哦，可选：${list.map((p, i) => `${i + 1}=${p.id}`).join('、')}`);
        return true;
      }
      const surface = groupArg || msg.kind === 'group' ? 'group' : 'private';
      await applyPersona(target, { petId, surface, conv: groupArg ? targetConv : msg.kind === 'group' ? conv : undefined });
      const scope = groupArg ? `群 ${groupArg}` : msg.kind === 'group' ? '这个群' : '私聊';
      log.info(`人格切换 → ${target.id}（${scope}，by ${msg.senderName}/${msg.senderId}）`);
      await sendText(msg, `${scope}换成「${target.name}」了。（${target.tagline}）`);
      return true;
    }

    if (['记忆', 'memory'].includes(cmd)) {
      const n = Number(arg) > 0 ? Math.min(Number(arg), 20) : 3;
      let api = null;
      try {
        api = await import('./lib/pet-api.mjs');
      } catch {
        /* 本地后端没有记忆分层，退化成只回放原文 */
      }
      const [r, sum] = await Promise.all([
        recentMessages(petId, n * 2, { surface: msg.kind, conv }),
        typeof api?.memorySummary === 'function' ? api.memorySummary(petId, { surface: msg.kind, conv }) : null,
      ]);
      const msgs = (Array.isArray(r?.messages) ? r.messages.slice(-n * 2) : []).filter(
        (x) => !String(x?.content ?? '').startsWith('（换身份提示'),
      );
      const summary = typeof sum?.summary === 'string' ? sum.summary.trim() : '';
      if (!msgs.length && !summary) {
        await sendText(msg, '记忆还是空白的。');
        return true;
      }
      const lines = [];
      if (summary) lines.push(`【压缩记忆】${summary.slice(0, 400)}`, '');
      lines.push(
        ...msgs.map((x) => `${x.role === 'user' ? '你' : '她'}：${String(x.content).slice(0, 120)}`),
      );
      await sendText(msg, lines.join('\n').trim());
      return true;
    }

    // 她最近刷到/看到的事（L3 语义记忆：说说、B 站、抖音热搜）
    if (['看到', 'seen'].includes(cmd)) {
      try {
        const api = await import('./lib/pet-api.mjs');
        const r = typeof api.seenNotes === 'function' ? await api.seenNotes(Number(arg) > 0 ? Number(arg) : 8) : null;
        const notes = Array.isArray(r?.notes) ? r.notes : [];
        if (!notes.length) {
          await sendText(msg, '最近没看到什么，脑子空空的。');
          return true;
        }
        await sendText(
          msg,
          notes
            .map((x) => {
              const d = new Date(x.at);
              return `${d.getMonth() + 1}/${d.getDate()} ${String(x.text).slice(0, 90)}`;
            })
            .join('\n'),
        );
      } catch (e) {
        log.warn(`/看到 失败：${e?.message ?? e}`);
      }
      return true;
    }

    // /忘记 关键词——只删语义记忆（她说看到/记住的事），对话原文不动
    if (['忘记', 'forget'].includes(cmd)) {
      const word = arg.trim();
      if (!word) {
        await sendText(msg, '要忘掉哪个词？比如：/忘记 空调');
        return true;
      }
      try {
        const api = await import('./lib/pet-api.mjs');
        const r = typeof api.forgetNotes === 'function' ? await api.forgetNotes(word) : null;
        await sendText(msg, r ? `忘了 ${r.removed} 条跟「${word}」有关的记忆。` : '这版后端不支持 /忘记。');
      } catch (e) {
        await sendText(msg, `没忘成：${e?.message ?? e}`);
      }
      return true;
    }

    // /我是谁——自我模型（≤220 字，一天最多变一次）
    if (['我是谁', 'self'].includes(cmd)) {
      try {
        const api = await import('./lib/pet-api.mjs');
        const r = typeof api.selfState === 'function' ? await api.selfState() : null;
        const text = r?.self?.text ? String(r.self.text) : '';
        await sendText(msg, text ? `【我】${text}` : '还没形成对自己的认识，再聊一阵子就有了。');
      } catch (e) {
        log.warn(`/我是谁 失败：${e?.message ?? e}`);
      }
      return true;
    }

    // 群里被触发反感度冷却后，主人可以手动解禁（否则要等 12h/7d）
    if (['解禁', '解冷却', 'unmute'].includes(cmd)) {
      try {
        const g = await import('./lib/groups.mjs');
        const db = await g.loadGroups();
        const all = db.groups || {};
        const listOf = () =>
          Object.entries(all)
            .map(([k, v]) => {
              const left = Number(v.cooldownUntil || 0) > Date.now()
                ? `冷却到 ${new Date(Number(v.cooldownUntil)).toLocaleString('zh-CN', { hour12: false })}`
                : '没在冷却';
              return `  · ${k.replace(/^group:/, '群 ')}：反感 ${Math.round(Number(v.annoyance || 0))}，冲动 ${Math.round(Number(v.impulse || 0))}，${left}`;
            })
            .sort()
            .join('\n');
        const target = (arg.replace(/^群\s*/, '') || (msg.kind === 'group' ? msg.groupId : '')).trim();
        if (!target) {
          await sendText(msg, ['各群状态：', listOf() || '  （还没有任何群的记录）', '', '发「/解禁 群号」清掉某个群的冷却与反感度。'].join('\n'));
          return true;
        }
        if (!/^\d{5,}$/.test(target)) {
          await sendText(msg, '群号得是数字哦，比如：/解禁 1106592574');
          return true;
        }
        const key = `group:${target}`;
        const st = g.groupState(db, key);
        const before = { annoyance: Math.round(Number(st.annoyance || 0)), cool: Number(st.cooldownUntil || 0) };
        st.annoyance = 0;
        st.cooldownUntil = 0;
        st.impulse = 0;
        st.afterSpeak = { at: 0, count: 0 };
        await g.saveGroups(db);
        const was = before.cool > Date.now() ? '在冷却中' : '本来没冷却';
        log.info(`手动解禁 ${key}（${was}，反感 ${before.annoyance} → 0，by ${msg.senderName}/${msg.senderId}）`);
        await sendText(msg, `群 ${target} 解禁了（${was}，反感 ${before.annoyance} → 0）。她得再攒够冲动才会插话。`);
      } catch (e) {
        log.warn(`/解禁 失败：${e?.message ?? e}`);
        await sendText(msg, '这个后端没有群状态（本机版没有群注意力）。');
      }
      return true;
    }

    // /规矩——主人定的硬约束，写在人格之前，冲突时以规矩为准
    if (['规矩', 'rule', 'rules'].includes(cmd)) {
      try {
        const ag = await import('./lib/agency.mjs');
        const sub = arg.trim();
        if (/^删\s*\d+$/.test(sub)) {
          const n = Number(sub.replace(/[^\d]/g, ''));
          const r = await ag.removeRule(n);
          await sendText(msg, r.ok ? `删掉了第 ${n} 条规矩。` : `没有第 ${n} 条规矩。`);
          return true;
        }
        if (sub) {
          const r = await ag.addRule(sub);
          if (r.ok) {
            log.info(`新增规矩：${sub}（by ${msg.senderName}/${msg.senderId}）`);
            await sendText(msg, `记住了：${sub}\n（现在共 ${r.rules.length} 条）`);
          } else if (r.reason === 'duplicate') {
            await sendText(msg, '这条已经有了。');
          } else {
            await sendText(msg, '没写成，换个说法？');
          }
          return true;
        }
        const agency = await ag.loadAgency(new Date());
        const rules = Array.isArray(agency.rules) ? agency.rules : [];
        await sendText(
          msg,
          rules.length
            ? ['现在的规矩：', ...rules.map((r, i) => `${i + 1}. ${r.text}`), '', '加：/规矩 不许叫我大肥鱼　删：/规矩 删 1'].join('\n')
            : ['还没有规矩。', '发「/规矩 不许叫我大肥鱼」这种，我就会当硬要求记着。'].join('\n'),
        );
      } catch (e) {
        log.warn(`/规矩 失败：${e?.message ?? e}`);
        await sendText(msg, '这个后端没有规矩模块（本机版没有）。');
      }
      return true;
    }

    // /画像——她自己攒的「这个人平时怎么说话」的统计（不花 token）
    if (['画像', 'profiles'].includes(cmd)) {
      try {
        const pf = await import('./lib/profiles.mjs');
        if (msg.kind !== 'group') {
          await sendText(msg, '画像只记群里的人（私聊就是你，不用记）。');
          return true;
        }
        const list = await pf.topProfiles(conv, Number(arg) > 0 ? Number(arg) : 10);
        if (!list.length) {
          await sendText(msg, '这个群我还没攒够印象，多聊几句就有了。');
          return true;
        }
        await sendText(
          msg,
          [
            `这个群的说话印象（${list.length} 人）：`,
            ...list.map(
              (p) =>
                `· ${p.name}：${p.msgs} 条，平均 ${p.avgLen} 字${p.words.length ? `，常提 ${p.words.join('、')}` : ''}`,
            ),
          ].join('\n'),
        );
      } catch (e) {
        log.warn(`/画像 失败：${e?.message ?? e}`);
        await sendText(msg, '这个后端没有画像模块（本机版没有）。');
      }
      return true;
    }

    // /用量——token 账本（按 kind 分：聊天/主动/承诺/群/说说）
    if (['用量', 'usage', 'token'].includes(cmd)) {
      try {
        const u = await import('./lib/usage.mjs');
        const days = Number(arg) > 0 ? Number(arg) : 7;
        const s = await u.usageSummary({ days });
        const line = (b) =>
          `${b.calls} 次，输入 ${b.prompt}（缓存命中 ${b.cacheHit}），输出 ${b.completion}`;
        const KIND_LABEL = { chat: '聊天', proactive: '主动开口', promise: '兑现承诺', group: '群插话', mood: '说说' };
        await sendText(
          msg,
          [
            `今天：${line(s.today)}`,
            `近 ${s.days} 天：${line(s.range)}，约 $${s.costUsd.toFixed(3)}`,
            ...s.byKind.map((k) => `  · ${KIND_LABEL[k.kind] ?? k.kind}：${k.calls} 次，输入 ${k.prompt}，输出 ${k.completion}`),
            s.range.calls ? '' : '（还没有记录，聊几句再看）',
          ]
            .filter(Boolean)
            .join('\n'),
        );
      } catch (e) {
        log.warn(`/用量 失败：${e?.message ?? e}`);
        await sendText(msg, '这个后端没有账本（本机版没有）。');
      }
      return true;
    }

    // /余额——DeepSeek 账户余额
    if (['余额', 'balance'].includes(cmd)) {
      try {
        const u = await import('./lib/usage.mjs');
        const b = await u.balance();
        await sendText(
          msg,
          b.ok
            ? `账户余额：${b.total.toFixed(2)} ${b.currency}${b.available === false ? '（不可用，可能欠费）' : ''}`
            : `查不到余额（${b.reason}）。`,
        );
      } catch (e) {
        log.warn(`/余额 失败：${e?.message ?? e}`);
        await sendText(msg, '这个后端查不了余额。');
      }
      return true;
    }

    if (['状态', 'status'].includes(cmd)) {
      const [{ pet, active, surfaces, groups }, state] = await Promise.all([personaLine(msg.kind, conv), getState()]);
      const byId = (id) => personas.personas.find((p) => p.id === id) ?? null;
      const priv = byId(surfaces.private ?? null);
      const grp = byId(surfaces.group ?? null);
      const curGroup = msg.kind === 'group' ? byId(groups?.[msg.groupId] ?? null) ?? grp : null;
      const say = state?.pets?.[petId]?.say?.data?.text ?? '（没在说话）';
      // 带图比例看实际发出去的（chat 后记的 chatter.json），不是配置里的概率
      let memeLine = behavior.sendMeme === false ? '关' : '开';
      if (behavior.sendMeme !== false) {
        try {
          const api = await import('./lib/pet-api.mjs');
          const s = typeof api.memeStats === 'function' ? await api.memeStats(msg.kind) : null;
          if (s && s.total > 0) memeLine = `开（最近 ${s.total} 条里 ${s.withImage} 条带图）`;
        } catch {
          /* 本地后端没有 memeStats，跳过 */
        }
      }
      await sendText(
        msg,
        [
          `宠物：${pet.name}（${petId}）`,
          `人格：私聊=${priv ? priv.label : active ? active.label : '未设置'}，群聊默认=${grp ? grp.label : '跟私聊一样'}`,
          ...(msg.kind === 'group' ? [`本群：${curGroup ? curGroup.label : '跟群聊默认一样'}`] : []),
          `气泡：${String(say).slice(0, 80)}`,
          `模式：群=${behavior.groupReply ?? 'at'}，私聊=${behavior.privateReply === false ? '关' : '开'}`,
          `表情包：${memeLine}`,
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

  /**
   * 连发合并：真人说话常常一口气发三四条短的（「在吗」「我跟你说」「今天出事了」），
   * 一条一句地回会显得像客服机器人。这里把 coalesceMs 窗口内的消息收成一个批次，
   * 只由**第一条**负责跑一次生成——其余几条的信道信息（旁听、引用、@）照样各自记下。
   */
  const coalesceMs = Math.max(0, Number(behavior.coalesceMs ?? 1600));
  const pendingBatch = new Map(); // conv -> { items, waiters, timer }

  function collectBatch(conv, msg) {
    let slot = pendingBatch.get(conv);
    if (!slot) {
      slot = { items: [], waiters: [] };
      pendingBatch.set(conv, slot);
    }
    slot.items.push(msg);
    const done = new Promise((resolve) => slot.waiters.push(resolve));
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = setTimeout(() => {
      const batch = slot.items.slice();
      pendingBatch.delete(conv);
      slot.waiters.forEach((resolve) => resolve(batch));
    }, coalesceMs);
    return done;
  }

  /** 连发合并：第一条当正文，后面几条压成「接着又发了几条」 */
  function withEarlier(input, later) {
    const list = (later ?? []).map((t) => String(t || '').trim()).filter(Boolean);
    if (!list.length) return input;
    return `${input}\n（他接着又发了几条，别一条条回，合起来说）\n${list.map((t) => `- ${t}`).join('\n')}`;
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

    // 每条消息「立刻」要做的事（不进队列，也别等 1.6 秒的合并窗口）：
    // @QQ号换群昵称、记住图片、攒说话画像、喂调度器旁听。
    try {
      await resolveAtNames(msg);
      rememberImage(msg);
      if (msg.kind === 'group' && msg.senderId) {
        // 画像模块只有云端版才有；本机后端没有就安静跳过
        const profiles = await import('./lib/profiles.mjs').catch(() => null);
        await profiles
          ?.noteSpeaker?.({ conv: `group:${msg.groupId}`, userId: msg.senderId, name: msg.senderName, text: msg.text })
          ?.catch?.(() => {});
      }
    } catch (e) {
      log.warn(`预处理失败：${e?.message ?? e}`);
    }
    if (msg.kind === 'group' && scheduler?.onGroupMessage) {
      try {
        await scheduler.onGroupMessage({
          conv: `group:${msg.groupId}`,
          text: msg.text,
          name: msg.senderName,
          atBot: msg.atMe,
        });
      } catch (e) {
        log.warn(`onGroupMessage：${e?.message ?? e}`);
      }
    }
    // 群里没 @ 她、只是引用了她说过的那句话——那也是在跟她说话（QQ 里引用通常不带 @）
    if (msg.observeOnly && msg.quoteId) {
      const q = await quoteOf(msg);
      if (q?.isSelf) {
        msg.observeOnly = false;
        msg.addressedByQuote = true;
        log.info(`${msg.senderName} 引用了她说过的话，当成本群在对她说话`);
      }
    }
    if (msg.observeOnly) {
      stats.ignored += 1;
      return null;
    }

    const key = msg.kind === 'group' ? `g:${msg.groupId}` : `u:${msg.senderId}`;
    const conv = msg.kind === 'group' ? `group:${msg.groupId}` : `private:${msg.senderId}`;
    const isCommand = /^\s*\//.test(msg.text);

    // 指令和「合并关闭」走原路；普通聊天先等一小会儿看看有没有后续
    let batch = [msg];
    if (!isCommand && coalesceMs > 0) {
      batch = await collectBatch(conv, msg);
      if (batch[0] !== msg) return null; // 只让批次里的第一条去生成
    }

    return enqueue(key, async () => {
      try {
        await scheduler?.onInbound?.({ conv, text: msg.text });
        if (await handleCommand(msg)) return null;

        if (behavior.logMessages !== false) {
          const extra = batch.length > 1 ? `（+${batch.length - 1} 条连发）` : '';
          log.info(
            `${msg.kind === 'group' ? `群${msg.groupId}` : `私聊${msg.senderId}`} ${msg.senderName}: ${msg.text.slice(0, 120)}${extra}`,
          );
        }

        // 群聊里带上说话人（主人单独标一下），单一人格/单一记忆不至于把张三李四搞混；
        // 消息是「引用某句」时，把被引用的原话一并写进去，她才接得上话。
        const input = await promptInput(msg, await quoteOf(msg));
        // 连发合并：第一条当正文，后面几条附在后面
        const merged = withEarlier(
          input,
          batch.slice(1).map((m) => m.text),
        );
        const capped = merged.length > 2000 ? merged.slice(0, 2000) : merged;

        const reply = await chat(capped, {
          petId,
          surface: msg.kind,
          conv,
          speaker: { id: msg.senderId, name: msg.senderName },
        });
        if (!reply?.ok) {
          log.warn(`生成失败：${reply?.reason} ${reply?.message ?? ''}`);
          await sendText(msg, behavior.errorReply ?? '唔……脑袋卡住了，等我一下下。');
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
        await sendText(msg, behavior.errorReply ?? '唔……脑袋卡住了，等我一下下。').catch(() => {});
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

  let retryTimer = null;
  let connecting = false;
  let online = false;
  let downSince = 0; // 第一次连不上/断开的时间，用来算「已经断了多久」

  /**
   * 断线重连：以前只在 close 里重试，而握手失败只会触发 error、不会触发 close，
   * 于是桥就「安静地死」在那里——现在 error / close / 心跳巡检三条路都能触发重连。
   */
  const scheduleReconnect = (why = '断开') => {
    if (closedByUs || retryTimer) return;
    attempt += 1;
    if (!downSince) downSince = Date.now();
    const delay = Math.min(60_000, 1000 * 2 ** Math.min(attempt - 1, 6)) + Math.floor(Math.random() * 400);
    // 长时间连不上时别每分钟刷一行：前 5 次每次都记，之后每 10 次记一行，并提示可能需要重新扫码
    if (attempt <= 5 || attempt % 10 === 0) {
      const minutes = Math.max(1, Math.round((Date.now() - downSince) / 60_000));
      log.warn(`OneBot ${why}，${Math.round(delay / 100) / 10}s 后重连（第 ${attempt} 次，约 ${minutes} 分钟未连通）`);
      if (attempt === 20) log.error('OneBot 已连续 20 次连不上：多半是 QQ 掉登录了，需要重新扫码（refresh-qr.ps1）');
      if (attempt % 60 === 0) log.error('OneBot 已约 1 小时连不上：确认小号是否在别处登录/被踢，扫码后会自动恢复');
    }
    retryTimer = setTimeout(() => {
      retryTimer = null;
      open();
    }, delay);
    retryTimer.unref?.();
  };

  const open = () => {
    if (closedByUs || connecting || online) return;
    connecting = true;
    log.info(`连接 OneBot：${url.origin}${url.pathname}（第 ${attempt + 1} 次）`);
    ws = new WebSocket(url.toString());

    ws.addEventListener('open', () => {
      attempt = 0;
      connecting = false;
      online = true;
      if (downSince) log.info(`OneBot 恢复连接（断了约 ${Math.max(1, Math.round((Date.now() - downSince) / 60_000))} 分钟）`);
      downSince = 0;
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

    ws.addEventListener('error', (ev) => {
      connecting = false;
      online = false;
      const detail = ev?.message ?? ev?.error?.message ?? ev?.type ?? '未知';
      log.warn(`OneBot WS 连接错误：${detail}`);
      scheduleReconnect('连不上');
    });

    ws.addEventListener('close', (ev) => {
      connecting = false;
      online = false;
      if (closedByUs) return;
      log.warn(`OneBot WS 关闭（code=${ev?.code ?? '?'}${ev?.reason ? `，${ev.reason}` : ''}）`);
      scheduleReconnect('已断开');
    });
  };

  // 心跳巡检：万一 error/close 都没来（半开连接），每分钟兜底看一眼
  const watchdog = setInterval(() => {
    if (closedByUs || online || connecting || retryTimer) return;
    scheduleReconnect('巡检发现离线');
  }, 60_000);
  watchdog.unref?.();

  return {
    sendMsg,
    call: (action, params) => send(action, params),
    start: open,
    stop: () => {
      closedByUs = true;
      clearInterval(watchdog);
      if (retryTimer) clearTimeout(retryTimer);
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
    },
    get online() {
      return online;
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
  const transport = {
    send: (msg, segments) => onebot.sendMsg(msg, segments),
    // 引用回复要用 get_msg 取被引用的原话（没有这个方法的旧 transport 会安静跳过）
    call: (action, params) => onebot.call(action, params),
  };
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
