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
import { extractChatImage, imageInstruction, limitPool, readMemePool, resolveMemeFile } from './memes.mjs';
import { chatCompletion } from './llm.mjs';
import {
  PATHS,
  appendMessages,
  ensureDirs,
  loadMemory,
  loadPet,
  loadState,
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
export async function currentPrompt(petId = 'main', surface = 'any') {
  return (await resolvePersona(surface, petId)).prompt;
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
 * pet.json 的 `surfaces = {private:'xiaolan', group:'niyujie'}` 存的是 persona id；
 * 没配 / 配的 id 不在 personas.json 里 → 退回 pet.name + pet.prompt（桌面端行为不变）。
 * @param {'private'|'group'|'any'} [surface]
 */
export async function resolvePersona(surface = 'any', petId = 'main') {
  const conf = await loadPet();
  const kind = normSurface(surface);
  // 【身份】是账号层的（头像/昵称），只在私聊档带上；群里「你鱼姐」有自己的设定，塞进去会打架
  const identity = kind === 'group' ? '' : identityOf(conf);
  const id = kind === 'any' ? null : conf.surfaces?.[kind];
  if (id) {
    const hit = (await personasList()).find((p) => p.id === id);
    if (hit) {
      return { id: hit.id, label: hit.label ?? hit.name, name: hit.name || conf.pet?.name || '小蓝', prompt: withIdentity(hit.prompt, identity) };
    }
  }
  return {
    id: conf.active ?? null,
    label: null,
    name: conf.pet?.name || '小蓝',
    prompt: withIdentity(conf.pet?.prompt, identity),
  };
}

/** 给调度器用：主动消息按目标会话取人设 */
export const personaFor = (surface = 'private') => resolvePersona(surface);

/**
 * 换人格：写 pet.name/pet.prompt（无 surface，兼容老调用），或只写某一档
 * `surfaces[surface]`（群里换不影响私聊）。写完回读校验，避免「说换好了其实没落盘」。
 */
export async function applyPersona(persona, { petId = 'main', surface } = {}) {
  if (!persona || typeof persona.prompt !== 'string' || !persona.prompt.trim()) {
    throw new Error('人格数据不完整（缺 prompt）');
  }
  const conf = await loadPet();
  if ((conf.pet?.id || 'main') !== petId) throw new Error(`没有这只桌宠：${petId}`);

  const kind = surface === 'group' || surface === 'private' ? surface : null;
  const identity = identityOf(conf);
  const fullPrompt = withIdentity(persona.prompt, identity);
  const surfaces = { ...(conf.surfaces || {}) };
  let pet = { ...conf.pet, id: petId };
  let active = conf.active ?? null;

  if (kind) {
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

  const got = await resolvePersona(kind ?? 'any', petId);
  if (got.prompt !== fullPrompt) throw new Error('写入后回读的人设与期望不一致');
  return { ok: true };
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

/** 与人格无关的「打字习惯」硬约束：模型经常忘了字数上限，这句每轮都提醒它 */
const REPLY_STYLE =
  '\n\n【回复方式】像在 QQ 上打字：把话分成 1~3 条短消息（用换行隔开），每条尽量 20 字以内；' +
  '问题再复杂也先说结论，最多 3 条，别写成一大段。';

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
 * 两条路径：
 * 1. 模型自己用换行/`||` 分好了段——直接采纳（它的分段点通常更自然）；
 * 2. 模型给了一整句——**按概率**在标点处断成 2 段（不是每次都断，否则更假）。
 *
 * 无论哪条路径都做同样的收尾：去掉列表符号、丢掉空段、太短的并回上一段、最多 max 段。
 */
export function splitBubbles(text, { max = 3, chance = 0.5, rng = Math.random } = {}) {
  const raw = String(text ?? '');
  let parts = raw
    .replace(/\\n/g, '\n')
    .split(/\n+|\|\|/)
    .map((s) => s.replace(/^\s*[-*·•]\s*/, '').trim())
    .filter((s) => s && !/^[。！？!?，,、；;…]+$/.test(s));

  if (!parts.length) return [];

  if (parts.length === 1) {
    const one = parts[0];
    // 短句不拆：本来一句话就说完的，硬拆反而假
    if (one.length >= 26 && rng() < chance) {
      const cut = pickCut(one);
      if (cut) {
        const left = one.slice(0, cut).trim();
        const right = one.slice(cut).replace(/^[。！？!?，,、；;…\s]+/, '').trim();
        if (left.length >= 5 && right.length >= 4) parts = [left, right];
      }
    }
  }

  // 太碎的并回上一段
  const merged = [];
  for (const p of parts) {
    if (merged.length && p.length < 3) merged[merged.length - 1] += p;
    else merged.push(p);
  }

  // 气泡结尾的逗号/分号去掉：真人分两条发时，前一条很少留个「，」吊着
  const tidy = merged.map((s, i) =>
    i === merged.length - 1 ? s.trim() : s.replace(/[，,、；;：:\s]+$/, '').trim(),
  );

  const kept = tidy.filter((s) => s.length > 0);

  // 一条塞太多字时按句号再切（模型偶尔会忘了字数上限，长段落一条气泡很难读）
  const expanded = [];
  for (const s of kept) {
    if (s.length <= LONG_BUBBLE) {
      expanded.push(s);
      continue;
    }
    for (const piece of sentenceChunks(s, LONG_BUBBLE)) expanded.push(piece);
  }

  if (expanded.length > max) {
    const head = expanded.slice(0, max - 1);
    const tail = expanded.slice(max - 1).join('');
    head.push(tail.length > HARD_BUBBLE ? clip(tail, HARD_BUBBLE) : tail);
    return head;
  }
  return expanded;
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
  const persona = await resolvePersona(surface, petId);
  const system =
    composeSystemPrompt({ prompt: persona.prompt, name: persona.name, id: petId, now: new Date() }) +
    REPLY_STYLE;

  const rounds = Math.max(1, Math.floor(Number(conf.chatMemoryRounds) || 5));
  const history = await recentFromStore(ENTRY, bucket, rounds * 2);

  const pool = await memePoolFor(conf);
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

  const { text: body, image } = extractChatImage(res.text, pool);
  const finalText = body.trim() || res.text.trim();

  // 拆成几个气泡：模型自己分好段的直接采纳，一整句的按概率断一次
  const maxBubbles = Math.max(1, Math.min(4, Math.floor(Number(conf.maxBubbles) || 3)));
  const splitChance = Number.isFinite(Number(conf.splitChance)) ? Number(conf.splitChance) : 0.5;
  const segments = splitBubbles(finalText, { max: maxBubbles, chance: splitChance });
  const stored = (segments.length ? segments.join(' ') : finalText).trim();

  await appendMessages(ENTRY, bucket, [
    { role: 'user', content: input },
    { role: 'assistant', content: stored },
  ]);
  await writeSay(petId, image ? { text: stored, image } : { text: stored });

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
