/**
 * 云端存储层：pet.json（人设/表情包表）、memory.json（记忆）、state.json（气泡状态）、
 * backups/（记忆快照）。
 *
 * 设计要点（与 dsh-pet 的宿主侧一致，方便本地备份直接回灌桌面端）：
 * - memory.json 结构 `{ "<entry>": { "<petId>": { messages: [{role,content,ts}] } } }`，**全存不删**，
 *   每次请求只把最近 chatMemoryRounds 轮塞进上下文；
 * - 所有写操作走同一条串行队列 + 「写临时文件再 rename」，进程被 kill 也不会留半个 JSON；
 * - 数据目录可用 DSH_PET_DATA 覆盖（测试/多实例隔离用），默认 = dist/data。
 */

import { copyFile, mkdir, readFile, rename, readdir, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url)); // <dist>/lib
const DIST_ROOT = resolve(HERE, '..');

export const PATHS = (() => {
  const dataDir = resolve(process.env.DSH_PET_DATA || join(DIST_ROOT, 'data'));
  return {
    dataDir,
    pet: join(dataDir, 'pet.json'),
    memory: join(dataDir, 'memory.json'),
    state: join(dataDir, 'state.json'),
    groups: join(dataDir, 'groups.json'),
    /** 最近说过什么（只有 kind/时间/带没带图，不含正文）：表情包冷却与 /状态 用 */
    chatter: join(dataDir, 'chatter.json'),
    /** 语义记忆：从外部看到的事（QQ 空间动态等）压成短句，作为聊天背景 */
    semantic: join(dataDir, 'semantic.json'),
    memesDir: join(dataDir, 'memes'),
    backupsDir: join(dataDir, 'backups'),
  };
})();

/** 建好数据目录（启动时调用一次） */
export async function ensureDirs() {
  await mkdir(PATHS.dataDir, { recursive: true });
  await mkdir(PATHS.memesDir, { recursive: true });
  await mkdir(PATHS.backupsDir, { recursive: true });
}

export async function readJson(file, fallback) {
  try {
    const raw = await readFile(file, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    if (e?.code === 'ENOENT') return fallback;
    if (e instanceof SyntaxError) {
      // 坏文件不覆盖：改名留档后返回 fallback，避免一次崩溃把用户的记忆抹掉
      const keep = file + '.broken-' + Date.now();
      await copyFile(file, keep).catch(() => {});
      console.error(`[store] ${file} 不是合法 JSON，已另存为 ${keep}`);
      return fallback;
    }
    throw e;
  }
}

let chain = Promise.resolve();

/** 串行执行写操作（同一进程内唯一写者；跨进程靠 rename 的原子性兜底） */
export function withLock(fn) {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

export async function writeJson(file, value) {
  return withLock(async () => {
    await mkdir(dirname(file), { recursive: true });
    const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
    await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
    await rename(tmp, file);
  });
}

/* ------------------------------- pet.json -------------------------------- */

const EMPTY_PET = {
  version: 1,
  default: 'xiaolan',
  active: null,
  pet: { id: 'main', name: '小蓝', prompt: '' },
  chatMemoryRounds: 5,
  chatImageLimit: 10,
  memes: {},
};

export async function loadPet() {
  const raw = await readJson(PATHS.pet, null);
  if (!raw || typeof raw !== 'object') return { ...EMPTY_PET, pet: { ...EMPTY_PET.pet } };
  return { ...EMPTY_PET, ...raw, pet: { ...EMPTY_PET.pet, ...(raw.pet || {}) } };
}

export async function savePet(next) {
  await writeJson(PATHS.pet, next);
}

/* ------------------------------- memory ---------------------------------- */

export async function loadMemory() {
  const raw = await readJson(PATHS.memory, {});
  return raw && typeof raw === 'object' ? raw : {};
}

/**
 * 追加若干条消息并落盘，返回落盘后的全部消息。
 * @param {string} entry 条目名（云端固定 'main'）
 * @param {string} petId 宠物实例 id
 * @param {{role: 'user'|'assistant', content: string, ts?: number}[]} messages
 */
export async function appendMessages(entry, petId, messages) {
  return withLock(async () => {
    const all = await loadMemory();
    const bucket = ((all[entry] ||= {})[petId] ||= { messages: [] });
    if (!Array.isArray(bucket.messages)) bucket.messages = [];
    for (const m of messages) bucket.messages.push({ ts: Date.now(), ...m });
    await mkdir(dirname(PATHS.memory), { recursive: true });
    const tmp = PATHS.memory + '.tmp-' + process.pid + '-' + Date.now();
    await writeFile(tmp, JSON.stringify(all, null, 2), 'utf8');
    await rename(tmp, PATHS.memory);
    return bucket.messages;
  });
}

/** 最近 n 条（按写入顺序取尾部；memory.json 全量保存，这里只裁上下文） */
export async function recentMessages(entry, petId, n) {
  const all = await loadMemory();
  const list = all?.[entry]?.[petId]?.messages;
  if (!Array.isArray(list)) return [];
  const k = Math.max(0, Math.floor(Number(n) || 0));
  return k > 0 ? list.slice(-k) : [];
}

/* -------------------------------- state ---------------------------------- */

export async function loadState() {
  const raw = await readJson(PATHS.state, {});
  return raw && typeof raw === 'object' ? raw : {};
}

/** 写「气泡」：与 dsh-pet 的 state.pets.<id>.say 同构，本地备份拉回去后 /状态 也读得到 */
export async function writeSay(petId, data) {
  const state = await loadState();
  const pets = (state.pets ||= {});
  const cur = (pets[petId] ||= {});
  const counter = Number(cur?.say?.counter) || 0;
  pets[petId] = { ...cur, say: { counter: counter + 1, at: Date.now(), data } };
  await writeJson(PATHS.state, state);
}

/* ------------------------------- chatter --------------------------------- */

const CHATTER_KEEP = 40;

/** 最近说过的话（只记 kind/at/image，不记正文——不回灌桌面端，也不涉及隐私） */
export async function loadChatter() {
  const raw = await readJson(PATHS.chatter, {});
  const list = Array.isArray(raw?.recent) ? raw.recent : [];
  return { recent: list.slice(-CHATTER_KEEP) };
}

/** 记一条「刚说过」：表情包冷却靠它，/状态 的带图比例也靠它 */
export async function noteChatter(kind, { image = false, at = Date.now() } = {}) {
  const db = await loadChatter();
  db.recent.push({ kind: kind === 'group' ? 'group' : 'private', at, image: Boolean(image) });
  db.recent = db.recent.slice(-CHATTER_KEEP);
  await writeJson(PATHS.chatter, db);
  return db;
}

/** 最近 n 条（按场景过滤）里带图的比例；list 留原始条目给冷却判断用 */
export async function chatterStats(kind, n = 20) {
  const db = await loadChatter();
  const list = db.recent.filter((r) => (kind ? r.kind === kind : true)).slice(-n);
  const withImage = list.filter((r) => r.image).length;
  return {
    total: list.length,
    withImage,
    ratio: list.length ? withImage / list.length : 0,
    lastImageAt: [...list].reverse().find((r) => r.image)?.at ?? null,
    list,
  };
}

/* ------------------------------- backups --------------------------------- */

/**
 * 把 memory.json 复制一份到 backups/memory-<时间戳>.json，并剔除超过 keep 份的旧快照。
 * @returns {Promise<string|null>} 新快照路径；memory 不存在时 null
 */
export async function snapshotMemory(keep = 72) {
  if (!existsSync(PATHS.memory)) return null;
  await mkdir(PATHS.backupsDir, { recursive: true });
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  // 本地时间命名（服务器时区由 .env 的 TZ 决定），拉回本机时文件名一眼能对上
  const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const out = join(PATHS.backupsDir, `memory-${ts}.json`);
  await copyFile(PATHS.memory, out);
  const files = (await readdir(PATHS.backupsDir))
    .filter((f) => /^memory-\d{8}-\d{6}\.json$/.test(f))
    .sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) {
    await unlink(join(PATHS.backupsDir, f)).catch(() => {});
  }
  return out;
}
