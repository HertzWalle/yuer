/**
 * 云端版 pet-api：**接口与 E:\DeepSeekWorkSpace\dsh-pet-qq\lib\pet-api.mjs 完全一致**，
 * 区别只是背后不再是本机 DSH 的 dsh-pet 路由，而是云端自己的 LLM + 记忆文件。
 *
 * 为什么保持同签名：qq-bridge.mjs（OneBot 传输层、指令、去重、白名单、表情包发送）
 * 一行都不用改——打包时把本文件覆盖成 dist/lib/pet-api.mjs 即可。见 cloud/build.mjs。
 *
 * 语义逐条对齐 dsh-pet：
 * - system = 人设正文 + 「你的名字是"X"。」 + 时间背景（lib/prompt.mjs）；
 * - 对话携带最近 chatMemoryRounds 轮记忆，配图池非空时把整张清单交给模型按语境选；
 * - 回复写回 memory.json（全存不删）与 state.json 的气泡字段；
 * - 失败返回 {ok:false, reason, message}，绝不伪造文案。
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { composeSystemPrompt } from './prompt.mjs';
import { notesBrief, recall, recentNotes, seenBrief, touch } from './semantic.mjs';
import { loadSummary, manageHistory, selfBrief } from './memory-manager.mjs';
import { extractChatImage, imageInstruction, limitPool, readMemePool, resolveMemeFile } from './memes.mjs';
import { chatCompletion } from './llm.mjs';
import {
  PATHS,
  appendMessages,
  chatterStats,
  ensureDirs,
  loadMemory,
  loadPet,
  loadState,
  noteChatter,
  recentMessages as recentFromStore,
  savePet,
  writeSay,
} from './store.mjs';

const HERE = dirname(fileURLToPath(import.meta.url)); // <dist>/lib
const DIST_ROOT = resolve(HERE, '..');

/** 云端没有 HTTP 基址；保留常量只为与本地 pet-api 的导出面一致 */
export const BASE = '';
export const TOKEN = '';

const ENTRY = 'main';

/**
 * 换身份标记：换人格时往该会话的记忆里插一条这样的 user 消息。
 *
 * 为什么需要：模型是照着历史对话的语气说话的。群里从「你鱼姐」换成「小蓝」后，
 * 旧记忆里一堆「姐」的自称会把新人格带跑（实测回了「这 ID 一长串数字，姐看得眼都花了」）。
 * 所以换人格时打一个界碑，chat() 只取最后一块界碑之后的历史——旧语气不再喂给模型，
 * 但原文仍完整留在 memory.json 里（/记忆 能翻到）。
 */
export const PERSONA_MARK_PREFIX = '（换身份提示：';

/** 从最后一条换身份标记开始截取（标记本身保留，作为给模型的明确提示） */
export function sincePersonaMark(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  let idx = -1;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i];
    if (m?.mark === 'persona') { idx = i; break; }
    if (typeof m?.content === 'string' && m.content.startsWith(PERSONA_MARK_PREFIX)) { idx = i; break; }
  }
  return idx < 0 ? list : list.slice(idx);
}

/** 云端配置视图：形状与 dsh-pet 的 GET /config 合并成品一致，桥与 /人格 面板都按它取值 */
export async function getConfig() {
  const conf = await loadPet();
  const pets = [
    {
      id: conf.pet?.id || 'main',
      name: conf.pet?.name || '小蓝',
      size: 0,
      display: 'both',
      whisperPrompt: conf.pet?.prompt || '',
    },
  ];
  return {
    [ENTRY]: {
      whisperPrompt: conf.pet?.prompt || '',
      chatMemoryRounds: conf.chatMemoryRounds,
      chatImageLimit: conf.chatImageLimit,
      memes: conf.memes || {},
      /** 群 / 私聊各自用哪个人格（persona id）；桥的 /人格 面板据此标注 */
      surfaces: conf.surfaces || {},
      pets,
    },
  };
}

export async function getPet(petId = 'main') {
  const cfg = await getConfig();
  const conf = cfg[ENTRY];
  const pet = conf.pets.find((p) => p.id === petId);
  if (!pet) throw new Error(`没有这只桌宠：${petId}`);
  return { entry: ENTRY, conf, pet, cfg };
}

export function listPetIds(cfg) {
  return Object.values(cfg || {}).flatMap((entry) => (entry.pets || []).map((p) => p.id));
}

/** 生效人设：实例级 prompt 优先、回落条目顶层（与 dsh-pet 的 petPersona 同语义） */
export async function currentPrompt(petId = 'main', surface = 'any', conv = '') {
  return (await resolvePersona(surface, petId, conv)).prompt;
}

/* --------------------------- 按会话分人格（群 / 私聊） --------------------------- */

const PERSONAS_PATH = join(DIST_ROOT, 'personas.json');
let personaCache = null;

/** 读 personas.json（读失败不致命：退回 pet.json 里的那份人设） */
async function personasList() {
  if (personaCache) return personaCache;
  try {
    personaCache = (await loadPersonas(PERSONAS_PATH)).personas;
  } catch {
    personaCache = [];
  }
  return personaCache;
}

const normSurface = (s) => (s === 'group' || s === 'private' ? s : 'any');

/** `group:1106592574` / `1106592574` → `1106592574`（pet.json 里按群号存） */
export function groupKeyOf(conv) {
  return String(conv ?? '').replace(/^group:/, '').trim();
}

/** pet.json 里的【身份】段（昵称/头像那段）对所有档位都生效，换人格时不能丢 */
function identityOf(conf) {
  if (typeof conf.identity === 'string' && conf.identity.trim()) return conf.identity;
  const p = String(conf.pet?.prompt ?? '');
  const i = p.indexOf('【身份】');
  return i >= 0 ? p.slice(i) : '';
}

const withIdentity = (prompt, identity) => {
  const body = String(prompt ?? '').trim();
  if (!identity || body.includes('【身份】')) return body;
  return body + '\n\n' + identity;
};

/**
 * 这个会话该用哪个人设。
 * pet.json 的 `surfaces = {private:'xiaolan', group:'niyujie', groups:{'1106592574':'lin'}}`
 * 存的是 persona id：`groups[群号]` 优先于 `group`，没有单独设置的群用 `group` 当默认。
 * 没配 / 配的 id 不在 personas.json 里 → 退回 pet.name + pet.prompt（桌面端行为不变）。
 * @param {'private'|'group'|'any'} [surface]
 * @param {string} [petId]
 * @param {string} [conv] 群会话（`group:<群号>` 或纯群号），用来查按群覆盖
 */
export async function resolvePersona(surface = 'any', petId = 'main', conv = '') {
  const conf = await loadPet();
  const kind = normSurface(surface);
  // 【身份】是账号层的（头像/昵称），只在私聊档带上；群里「你鱼姐」有自己的设定，塞进去会打架
  const identity = kind === 'group' ? '' : identityOf(conf);
  const groupKey = kind === 'group' ? groupKeyOf(conv) : '';
  const perGroup = groupKey ? conf.surfaces?.groups?.[groupKey] : null;
  const id = kind === 'any' ? null : perGroup || conf.surfaces?.[kind];
  if (id) {
    const hit = (await personasList()).find((p) => p.id === id);
    if (hit) {
      return {
        id: hit.id,
        label: hit.label ?? hit.name,
        name: hit.name || conf.pet?.name || '小蓝',
        prompt: withIdentity(hit.prompt, identity),
        scope: perGroup ? 'group' : kind,
      };
    }
  }
  return {
    id: conf.active ?? null,
    label: null,
    name: conf.pet?.name || '小蓝',
    prompt: withIdentity(conf.pet?.prompt, identity),
    scope: kind,
  };
}

/** 给调度器用：主动消息按目标会话取人设（群消息要带 conv 才拿得到按群覆盖） */
export const personaFor = (surface = 'private', conv = '') => resolvePersona(surface, 'main', conv);

/**
 * 换人格：
 *  - `surface: 'private'` → 写 `surfaces.private`，同时落 `pet.name/pet.prompt`（桌面气泡跟着变）
 *  - `surface: 'group'` + `conv` → 写 `surfaces.groups[群号]`（只影响这一个群）
 *  - `surface: 'group'` 不带 conv → 写 `surfaces.group`（所有群的默认，兼容老调用）
 *  - 不带 surface → 写 `pet.*`（老行为）
 * 写完回读校验，避免「说换好了其实没落盘」。
 */
export async function applyPersona(persona, { petId = 'main', surface, conv } = {}) {
  if (!persona || typeof persona.prompt !== 'string' || !persona.prompt.trim()) {
    throw new Error('人格数据不完整（缺 prompt）');
  }
  const conf = await loadPet();
  if ((conf.pet?.id || 'main') !== petId) throw new Error(`没有这只桌宠：${petId}`);

  const kind = surface === 'group' || surface === 'private' ? surface : null;
  const groupKey = kind === 'group' ? groupKeyOf(conv) : '';
  const identity = identityOf(conf);
  const fullPrompt = withIdentity(persona.prompt, identity);
  const surfaces = { ...(conf.surfaces || {}) };
  let pet = { ...conf.pet, id: petId };
  let active = conf.active ?? null;

  if (kind === 'group' && groupKey) {
    surfaces.groups = { ...(surfaces.groups || {}), [groupKey]: persona.id ?? null };
  } else if (kind) {
    surfaces[kind] = persona.id ?? null;
    // 私聊档同时落到 pet.*，这样桌面气泡、/人格 面板、未指定 surface 的调用都看到同一份
    if (kind === 'private') {
      pet = { ...pet, name: persona.name || pet.name || '小蓝', prompt: fullPrompt };
      active = persona.id ?? null;
    }
  } else {
    pet = { ...pet, name: persona.name || pet.name || '小蓝', prompt: fullPrompt };
    active = persona.id ?? null;
  }

  const next = { ...conf, active, surfaces, identity, pet };
  await savePet(next);

  const got = await resolvePersona(kind ?? 'any', petId, groupKey);
  const expected = kind === 'group' ? withIdentity(persona.prompt, '') : fullPrompt;
  if (got.prompt !== expected) throw new Error('写入后回读的人设与期望不一致');

  // 打界碑：之后这个会话只按新人设的语气接话，旧语气留在原文里但不喂给模型
  const bucket = bucketOf(petId, kind === 'group' ? 'group' : 'private', kind === 'group' ? conv : '');
  await appendMessages(ENTRY, bucket, [
    {
      role: 'user',
      content: `${PERSONA_MARK_PREFIX}从现在起你是「${persona.name || persona.id}」。上面的记录里如果出现别的名字或别的自称（比如「姐」「本鱼」），那是以前的身份，现在只用这个名字、这个语气。其余设定照旧。）`,
      ts: Date.now(),
      mark: 'persona',
      persona: persona.id ?? null,
    },
  ]);

  return { ok: true, scope: kind === 'group' ? (groupKey ? `group:${groupKey}` : 'group') : kind ?? 'any' };
}

/** 由 prompt/名字反推是哪个内置人格（与本地 pet-api 的 identify 同一策略） */
export function identify(personas, prompt, petName) {
  const list = Array.isArray(personas?.personas) ? personas.personas : [];
  const p = String(prompt ?? '').trim();
  if (p) {
    const byPrompt = list.find((x) => String(x.prompt ?? '').trim() === p);
    if (byPrompt) return byPrompt;
  }
  const n = String(petName ?? '').trim();
  if (n) {
    const byName = list.find((x) => String(x.name ?? '').trim() === n);
    if (byName) return byName;
  }
  return null;
}

/** 表情包目录链：只认 data/memes（云端没有「种类独占目录」这一层） */
async function memePoolFor(conf) {
  const pool = readMemePool(conf.memes, [PATHS.memesDir]);
  return limitPool(pool, conf.chatImageLimit ?? 0);
}

/**
 * 「这一轮要不要给她配图资格」——骰子在**生成层**掷，不在发送层丢。
 *
 * 为什么：以前是每轮都把 54 条表情包清单（约 1.3k token）塞给模型让它挑，
 * 然后发送层按 35% 概率把挑好的图扔掉 —— 挑完扔 82%，纯浪费输入 token，
 * 而且模型「被要求挑图」本身就会拉高带图率。现在先决定有没有资格：
 * 没资格就完全不给清单、不给配图指令。
 *
 * 档位：私聊 conf.memeChancePrivate（默认 0.18）、群聊 conf.memeChanceGroup（默认 0.06）；
 * 冷却：本场景最近 conf.memeCooldown（默认 5）条里带过图就直接不给资格。
 */
async function memeGate(conf, kind) {
  if (conf.memeEnabled === false) return { allow: false, why: 'disabled' };
  const isGroup = kind === 'group';
  const keys = isGroup ? ['memeChanceGroup'] : ['memeChancePrivate', 'memeChance'];
  let chance = NaN;
  for (const k of keys) {
    const v = Number(conf[k]);
    if (Number.isFinite(v)) {
      chance = v;
      break;
    }
  }
  if (!Number.isFinite(chance)) chance = isGroup ? 0.06 : 0.18;

  const cdRaw = Math.floor(Number(conf.memeCooldown));
  const cooldown = Number.isFinite(cdRaw) ? Math.max(0, cdRaw) : 5;
  if (cooldown > 0) {
    const stats = await chatterStats(isGroup ? 'group' : 'private', cooldown);
    if (stats.total > 0 && stats.withImage > 0) return { allow: false, why: 'cooldown' };
  }

  if (Math.random() >= chance) return { allow: false, why: 'chance' };
  return { allow: true, why: 'allowed' };
}

/** 没给清单时模型也可能凭习惯写 `[图:…]`——直接剥掉，别让它出现在消息里 */
function stripMemeTag(text) {
  return String(text ?? '')
    .replace(/\n?\s*\[图[:：]\s*[^\]\n]{1,40}\]\s*$/u, '')
    .trim();
}

/** 与人格无关的「打字习惯」硬约束：模型经常忘了字数上限，这句每轮都提醒它 */
const REPLY_STYLE =
  '\n\n【回复方式】像在 QQ 上跟人聊天：' +
  '想连发就分成 2~4 条短句（用换行隔开，每条尽量 20 字以内）；' +
  '想一口气说完就整段一条，别为了拆而拆。' +
  '不管几条，先给结论，别写成公文，也别用列表符号。';

/**
 * 记忆分桶：私聊和主人共用 `<petId>`（沿用旧结构，桌面端也认得），
 * 每个群单开一桶 `<petId>@<conv>`——群里是「你鱼姐」、私聊是「小蓝」，
 * 共用一份记忆会互相串味（群里刚骂过人，私聊就阴阳怪气）。
 */
function bucketOf(petId, kind, conv) {
  if (kind === 'group' && conv) return `${petId}@${conv}`;
  return petId;
}

/**
 * 把一条回复拆成「像真人打字那样」的几个气泡。
 *
 * **不写死条数**，按内容决定形态（对着真人聊天记录校准过）：
 * - 模型自己用换行 / `||` 分好了段 → 直接采纳（它知道自己在说什么，切点比机器自然）；
 * - 一整句 ≤30 字 → 约 30% 拆两条，其余整条（短句硬拆最假）；
 * - 30~90 字 → 约 40% **整段一条**（一口气说完那种），60% 拆 2~3 条；
 * - >90 字 → 默认整段一条，只在句号处切、最多 4 条（碎成八条比长段更像机器人）；
 * - 软上限 max（默认 6）：超了只合并相邻短句，不做「全塞最后一条」的硬合并；
 * - 两三个字的「嗯」「好」允许单独成条（真人就是这样）。
 *
 * bias（0~1，pet.json 的 splitChance）整体调「爱不爱拆」：越大越愿意拆。
 */
export function splitBubbles(text, { max = 6, bias = 0.5, rng = Math.random } = {}) {
  const raw = String(text ?? '');
  let parts = normalizeParts(raw);
  if (!parts.length) return [];

  if (parts.length === 1) parts = reshapeSingle(parts[0], { bias, rng });

  // 气泡结尾的逗号/分号去掉：真人分两条发时，前一条很少留个「，」吊着
  parts = parts
    .map((s, i, arr) => (i === arr.length - 1 ? String(s).trim() : String(s).replace(/[，,、；;：:\s]+$/, '').trim()))
    .filter(Boolean);

  if (parts.length > max) {
    // 只削掉多余的那几条：每次合并「最短的相邻一对」，保住原本的分段节奏
    while (parts.length > max) {
      let best = 1;
      let bestLen = Infinity;
      for (let i = 1; i < parts.length; i += 1) {
        const len = parts[i - 1].length + parts[i].length;
        if (len < bestLen) {
          bestLen = len;
          best = i;
        }
      }
      parts[best - 1] += parts[best];
      parts.splice(best, 1);
    }
  }
  return parts;
}

/** 按换行 / `||` 切段，去掉列表符号与空段、纯标点段 */
function normalizeParts(raw) {
  return raw
    .replace(/\\n/g, '\n')
    .split(/\n+|\|\|/)
    .map((s) => s.replace(/^\s*[-*·•]\s*/, '').trim())
    .filter((s) => s && !/^[。！？!?，,、；;…]+$/.test(s));
}

/** 只有一整句时：按长度分档决定摊成几条 */
function reshapeSingle(one, { bias = 0.5, rng = Math.random } = {}) {
  const len = one.length;
  // bias 0.5 → 系数 1；bias 1 → 1.5 倍；bias 0 → 0.5 倍
  const p = (base) => Math.min(0.95, Math.max(0.05, base * (0.5 + bias)));

  if (len <= 30) {
    if (rng() < p(0.3)) {
      const two = cutInTwo(one);
      if (two) return two;
    }
    return [one];
  }

  if (len <= 90) {
    if (rng() < p(0.4)) return [one]; // 长段落模式：一口气说完
    const n = rng() < 0.55 ? 2 : 3;
    const chunks = chunkTo(one, n);
    if (chunks.length > 1) return chunks;
    return cutInTwo(one) ?? [one];
  }

  // >90：整段一条最像人；只有确实有句读（≥2 个句子收尾）时才切
  const sentenceCount = (one.match(/[。！？!?；;\n]/g) ?? []).length;
  if (sentenceCount < 2) return [one];
  return capParts(sentenceChunks(one, LONG_BUBBLE), 4);
}

/** 在标点处断成两条；断不开返回 null */
function cutInTwo(s) {
  const cut = pickCut(s);
  if (!cut) return null;
  const left = s.slice(0, cut).trim();
  const right = s
    .slice(cut)
    .replace(/^[。！？!?，,、；;…\s]+/, '')
    .trim();
  if (left.length < 5 || right.length < 2) return null;
  return [left, right];
}

/** 尽量摊成 n 条：句子够就按句攒，不够再按逗号硬切 */
function chunkTo(text, n) {
  const sentences = sentenceChunks(text, LONG_BUBBLE);
  if (sentences.length >= n) return capParts(sentences, n);
  const rough = splitRough(text, Math.max(8, Math.ceil(text.length / n)));
  if (rough.length >= n) return capParts(rough, n);
  return rough;
}

/** 超过 n 条时，把多出来的并进最后一条（太长就截断） */
function capParts(parts, n) {
  if (parts.length <= n) return parts;
  const head = parts.slice(0, n - 1);
  const tail = parts.slice(n - 1).join('');
  head.push(tail.length > HARD_BUBBLE ? clip(tail, HARD_BUBBLE) : tail);
  return head;
}

/** 单条气泡的舒适长度 / 拼接后的硬上限 */
const LONG_BUBBLE = 70;
const HARD_BUBBLE = 90;

/** 按句号/问号/叹号/分号切句，再贪心攒到不超过 limit 的块 */
function sentenceChunks(text, limit) {
  const sentences = text.match(/[^。！？!?；;\n]+[。！？!?；;]?/g) ?? [text];
  const out = [];
  let buf = '';
  for (const s of sentences) {
    const t = s.trim();
    if (!t) continue;
    if (!buf) buf = t;
    else if (buf.length + t.length <= limit) buf += t;
    else {
      out.push(buf);
      buf = t;
    }
  }
  if (buf) out.push(buf);
  return out.flatMap((x) => (x.length <= limit ? [x] : splitRough(x, limit)));
}

/** 没有标点可切时的兜底：按逗号硬切，再不行按字数切 */
function splitRough(text, limit) {
  const parts = text.split(/(?<=[，,、])/);
  const out = [];
  let buf = '';
  for (const p of parts) {
    if (!buf) buf = p;
    else if (buf.length + p.length <= limit) buf += p;
    else {
      out.push(buf);
      buf = p;
    }
  }
  if (buf) out.push(buf);
  return out.flatMap((x) => {
    if (x.length <= limit) return [x];
    const pieces = [];
    for (let i = 0; i < x.length; i += limit) pieces.push(x.slice(i, i + limit));
    return pieces;
  });
}

/** 截到 limit 以内并在标点处收尾，避免半句话 */
function clip(text, limit) {
  const cut = text.slice(0, limit);
  const at = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('，'));
  const body = at >= limit * 0.5 ? cut.slice(0, at + 1) : cut;
  return body.replace(/[，,、；;：:]+$/, '') + '…';
}

/** 在标点后找一个离中间最近的断点；找不到返回 0 */
function pickCut(s) {
  const marks = /[，,、；;。！？!?…~～]/g;
  const mid = s.length / 2;
  let best = 0;
  let bestDist = Infinity;
  for (let m = marks.exec(s); m; m = marks.exec(s)) {
    const at = m.index + m[0].length;
    if (at < 5 || s.length - at < 4) continue;
    const d = Math.abs(at - mid);
    if (d < bestDist) {
      bestDist = d;
      best = at;
    }
  }
  return best;
}

/**
 * 生成一句回复并写入记忆。
 * @param {string} text 用户这句话（已由桥裁到 2000 字）
 * @param {{petId?: string, surface?: 'private'|'group'|'any', conv?: string, timeoutMs?: number}} [opts]
 *   surface 决定用哪一档人格：群里可以是「你鱼姐」，私聊仍是「小蓝」；
 *   conv（如 `group:123456`）决定记忆桶，群聊必须传。
 */
export async function chat(text, { petId = 'main', surface = 'private', conv = '', timeoutMs = 90_000 } = {}) {
  const input = String(text ?? '').trim();
  if (!input) return { ok: false, reason: 'bad-request', message: '消息为空' };

  await ensureDirs();
  const conf = await loadPet();
  const kind = normSurface(surface);
  const bucket = bucketOf(petId, kind, conv);
  const persona = await resolvePersona(surface, petId, conv);
  // 语义记忆（她看到的说说/热搜、说过的旧事、对自己的认识）只挂在私聊：
  // 群里不需要她汇报私事，也不需要她把「自我模型」念一遍。
  let background = '';
  if (kind === 'private') {
    const [seen, self, hits] = await Promise.all([
      seenBrief({ n: 6 }),
      selfBrief(),
      recall(input, { n: 3 }),
    ]);
    const recalled = hits.length
      ? '\n\n【你想起来的】下面几件旧事跟你现在这句话有关，用得上的话自然带一句，用不上就当没看见，别复述：\n' +
        hits
          .map((h) => {
            const d = new Date(h.at);
            return `- ${d.getMonth() + 1}月${d.getDate()}日：${h.text}`;
          })
          .join('\n')
      : '';
    background = seen + recalled + self;
    if (hits.length) await touch(hits.map((h) => h.id));
  }
  const system =
    composeSystemPrompt({ prompt: persona.prompt, name: persona.name, id: petId, now: new Date() }) +
    REPLY_STYLE +
    background;

  const rounds = Math.max(1, Math.floor(Number(conf.chatMemoryRounds) || 5));
  // 多取一些再交给记忆管理：早期轮次会被压成摘要（L2），摘要落盘、重启不丢
  const raw = sincePersonaMark(await recentFromStore(ENTRY, bucket, rounds * 6));
  const managed = await manageHistory({ bucket, messages: raw, conf });
  const history = managed.messages;

  // 配图资格：先掷骰子，有资格才把清单交给模型（省 token、也压住带图率）
  const gate = await memeGate(conf, kind);
  const pool = gate.allow ? await memePoolFor(conf) : [];
  const messages = [
    { role: 'system', content: system },
    ...history
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content)
      .map((m) => ({ role: m.role, content: String(m.content) })),
    { role: 'user', content: input + imageInstruction(pool) },
  ];

  const res = await chatCompletion(messages, { timeoutMs, maxTokens: 256 });
  if (!res.ok) {
    if (res.reason === 'provider-missing') return { ok: false, reason: 'provider-missing', message: res.message };
    return { ok: false, reason: 'generate-error', message: res.message };
  }

  const parsed = extractChatImage(res.text, pool);
  const image = parsed.image;
  const finalText = (image ? parsed.text : stripMemeTag(parsed.text)).trim() || res.text.trim();

  // 拆成几个气泡：模型自己分好段的直接采纳，一整句的按内容决定要不要拆
  const maxBubbles = Math.max(1, Math.min(8, Math.floor(Number(conf.maxBubbles) || 6)));
  const bias = Number.isFinite(Number(conf.splitChance)) ? Number(conf.splitChance) : 0.5;
  const segments = splitBubbles(finalText, { max: maxBubbles, bias });
  const stored = (segments.length ? segments.join(' ') : finalText).trim();

  await appendMessages(ENTRY, bucket, [
    { role: 'user', content: input },
    { role: 'assistant', content: stored },
  ]);
  await writeSay(petId, image ? { text: stored, image } : { text: stored });
  await noteChatter(kind, { image: Boolean(image) });

  return image
    ? { ok: true, text: stored, segments, image }
    : { ok: true, text: stored, segments };
}

/** 最近若干条记忆（桥的 /记忆 用；rounds 是条数，conv 决定桶） */
export async function recentMessages(petId = 'main', rounds, { surface = 'private', conv = '' } = {}) {
  const n = Math.max(0, Math.floor(Number(rounds) || 0));
  const messages = await recentFromStore(ENTRY, bucketOf(petId, normSurface(surface), conv), n);
  return { ok: true, messages };
}

/**
 * 喂给模型的历史：只取最后一次换身份之后的片段。
 * 主动消息、群旁听、空间说说都要用这份，否则旧人格的语气会从历史里漏出来。
 */
export async function recentForContext(petId = 'main', rounds = 5, { surface = 'private', conv = '' } = {}) {
  const n = Math.max(1, Math.floor(Number(rounds) || 5));
  const raw = await recentFromStore(ENTRY, bucketOf(petId, normSurface(surface), conv), n);
  return sincePersonaMark(raw);
}

/** /记忆 用的摘要（L2 压缩产物；没有就空） */
export async function memorySummary(petId = 'main', { surface = 'private', conv = '' } = {}) {
  const bucket = bucketOf(petId, normSurface(surface), conv);
  const saved = await loadSummary(bucket);
  return { ok: true, bucket, summary: saved?.summary ?? '', updatedAt: saved?.updatedAt ?? null };
}

/** /看到 用：最近她刷到/看到的事（L3 语义记忆） */
export async function seenNotes(n = 10, kind = null) {
  const list = await recentNotes(Math.max(1, Math.min(30, Number(n) || 10)), kind);
  return { ok: true, notes: list };
}

/** 记住一条（工具/指令用；importance 决定它多抗遗忘） */
export async function remember(text, { kind = 'note', importance = 0.6 } = {}) {
  const { addNote } = await import('./semantic.mjs');
  const note = await addNote(kind, text, { importance });
  return { ok: Boolean(note), note };
}

/** 忘掉含某个词的语义记忆（/忘记 用），返回删掉的条数 */
export async function forgetNotes(keyword) {
  const { forget } = await import('./semantic.mjs');
  return { ok: true, removed: await forget(keyword) };
}

/** /我是谁 用：自我模型（≤220 字，一天最多变一次） */
export async function selfState() {
  const { loadSelf } = await import('./memory-manager.mjs');
  return { ok: true, self: await loadSelf() };
}

export async function getState() {
  return loadState();
}

/**
 * 表情包原图：data/memes/<名称>.png|gif|jpg… 或 data/memes/<名称>/ 里的随机一张。
 * 缺失返回 null（桥会退化成一句文字提示）。
 */
export async function fetchMemeImage(name, entry = 'main') {
  const key = String(name ?? '').trim();
  if (!key) return null;
  const file = resolveMemeFile([PATHS.memesDir], key, { random: true });
  if (!file) return null;
  return readFile(file);
}

/** 读 personas.json（与本地同名同语义：{version, default, personas:[{id,label,name,tagline,prompt}]}） */
export async function loadPersonas(fileUrl) {
  const file = fileUrl ? resolve(String(fileUrl)) : join(DIST_ROOT, 'personas.json');
  const raw = await readFile(file, 'utf8');
  const parsed = JSON.parse(raw);
  const list = Array.isArray(parsed?.personas) ? parsed.personas : [];
  if (!list.length) throw new Error('personas.json 里没有可用人格');
  return { version: parsed.version ?? 1, default: parsed.default ?? list[0].id, personas: list };
}

/** 给备份服务用：内存里的观测值（记忆条数、当前人格） */
export async function stats() {
  const conf = await loadPet();
  const mem = await loadMemory();
  const messages = mem?.[ENTRY]?.[conf.pet?.id || 'main']?.messages;
  return {
    pet: { id: conf.pet?.id || 'main', name: conf.pet?.name || '小蓝' },
    active: conf.active ?? null,
    memoryMessages: Array.isArray(messages) ? messages.length : 0,
    dataDir: PATHS.dataDir,
  };
}

/** /状态 用：本场景最近 20 条里带图多少条 */
export async function memeStats(surface = 'private') {
  const kind = surface === 'group' ? 'group' : 'private';
  const s = await chatterStats(kind, 20);
  return { kind, total: s.total, withImage: s.withImage, ratio: s.ratio };
}
