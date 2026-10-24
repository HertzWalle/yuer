/**
 * dsh-pet 的本地 HTTP 封装（host 路由前缀 /dsh-pet-7340，挂在 DSH web 服务器上）。
 *
 * 为什么不直接改配置文件：dsh-pet 的配置有「内置默认 → 用户层 → 文件宠物」三层合并，
 * 用户层路径在 %USERPROFILE%\.dsh\dsh-pet\main-config.jsonc（工作区之外，需提权）。
 * host 已经给了 PUT /config 这个写入通道（白名单重建 + 合并后回读 + 同步桌面 Helper），
 * 走它就不必碰文件系统，也不会把用户手改的高级字段抹掉。
 */
import { readFile } from 'node:fs/promises';

// 云端部署时：DSH_PET_BASE 指向隧道（如 https://xxx.trycloudflare.com，不含 /dsh-pet-7340 前缀时自动补），
// DSH_PET_TOKEN 给出 pet-gateway 的 token。
function normalizeBase(raw) {
  const s = String(raw).replace(/\/+$/, '');
  return s.endsWith('/dsh-pet-7340') ? s : s + '/dsh-pet-7340';
}

export const BASE = normalizeBase(
  process.env.DSH_PET_BASE ?? 'http://127.0.0.1:2627',
);

export const TOKEN = process.env.DSH_PET_TOKEN ?? '';

/** 带超时的 fetch + JSON 解析；非 2xx 抛错并带上响应体（便于定位 400/409）。 */
async function req(path, { method = 'GET', body, timeoutMs = 15000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (TOKEN) headers['x-pet-token'] = TOKEN;
    const res = await fetch(BASE + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ac.signal,
    });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const err = new Error(`${method} ${path} → HTTP ${res.status}: ${String(text).slice(0, 400)}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/** 合并后的成品配置：{ main: { pets: [...], whisperPrompt, chatMemoryRounds, ... }, <filePet>: {...} } */
export async function getConfig() {
  return req('/config', { timeoutMs: 10000 });
}

/** 按 id 定位宠物实例：{ entry, conf, pet }（host 的 findPetInstance 同语义） */
export async function getPet(petId = 'main') {
  const cfg = await getConfig();
  for (const [entry, conf] of Object.entries(cfg ?? {})) {
    const pets = Array.isArray(conf?.pets) ? conf.pets : [];
    const pet = pets.find((p) => String(p.id) === petId);
    if (pet) return { entry, conf, pet, cfg };
  }
  throw new Error(`没有这只桌宠：${petId}（可用：${listPetIds(cfg).join(', ') || '无'}）`);
}

export function listPetIds(cfg) {
  const ids = [];
  for (const conf of Object.values(cfg ?? {})) {
    if (Array.isArray(conf?.pets)) for (const p of conf.pets) ids.push(String(p.id));
  }
  return ids;
}

/** 该宠物当前生效的人设原文（实例级优先，其次所属条目顶层） */
export async function currentPrompt(petId = 'main') {
  const { pet, conf } = await getPet(petId);
  const own = typeof pet.whisperPrompt === 'string' ? pet.whisperPrompt.trim() : '';
  if (own) return own;
  const top = typeof conf.whisperPrompt === 'string' ? conf.whisperPrompt.trim() : '';
  return top;
}

/**
 * 把某个人格的 prompt（和显示名）写进配置，成为该宠物**实例级**人设。
 *
 * 注意两点：
 * 1) 保留配置里其它宠物与所有其它字段——只改目标宠物的 name / whisperPrompt，
 *    其余实例字段按原值带回，避免把用户调好的 size/position/display 冲掉。
 * 2) 空字符串 = 删除实例级覆盖（回落条目人设），这里显式拒绝，免得"切了个空人设"。
 */
export async function applyPersona(persona, { petId = 'main' } = {}) {
  const prompt = String(persona?.prompt ?? '').trim();
  if (!prompt) throw new Error(`人格「${persona?.id ?? '?'}」的 prompt 为空，拒绝写入`);
  const { entry, conf, pet, cfg } = await getPet(petId);

  const pets = (Array.isArray(conf.pets) ? conf.pets : []).map((p) => {
    const id = String(p.id);
    const base = {
      id,
      name: String(p.name ?? id),
      size: Number(p.size),
      balanceEnabled: p.balanceEnabled === true,
      whisperEnabled: p.whisperEnabled !== false,
      workStatusEnabled: p.workStatusEnabled !== false,
      fixedEnabled: p.fixedEnabled === true,
      display: String(p.display ?? 'both'),
      position: {
        corner: String(p.position?.corner ?? 'top-right'),
        marginX: Number(p.position?.marginX ?? 24),
        marginY: Number(p.position?.marginY ?? 100),
      },
    };
    if (typeof p.whisperPrompt === 'string' && p.whisperPrompt.trim()) {
      base.whisperPrompt = p.whisperPrompt.trim();
    }
    return base;
  });

  const target = pets.find((p) => p.id === petId);
  if (!target) throw new Error(`配置里找不到宠物实例：${petId}`);
  if (persona.name) target.name = String(persona.name).trim();
  target.whisperPrompt = prompt;

  // 只提交 pets：其余顶层字段由 host 的 saveUserConfig 从磁盘现有用户层透传保留。
  const merged = await req('/config', { method: 'PUT', body: { pets }, timeoutMs: 20000 });

  // 回读校验（merge 后的生效值必须等于刚写的 prompt）
  const got = String(merged?.[entry]?.pets?.find((p) => String(p.id) === petId)?.whisperPrompt ?? '').trim();
  if (got !== prompt) throw new Error('写入后回读的人设与期望不一致，配置可能被其它写入方覆盖');
  return { ok: true, entry, petId, name: persona.name ?? pet.name, prompt };
}

/** 匹配当前生效人设属于哪个人格（按 prompt 全等，其次按名字） */
export function identify(personas, prompt, petName) {
  const list = personas?.personas ?? [];
  const byPrompt = list.find((p) => p.prompt.trim() === (prompt ?? '').trim());
  if (byPrompt) return byPrompt;
  return list.find((p) => p.name && petName && p.name.trim() === String(petName).trim()) ?? null;
}

/** 对话：POST /chat?pet=&surface=（surface 必填，any = web/desktop/both 任一都算） */
export async function chat(text, { petId = 'main', surface = 'any', timeoutMs = 90000 } = {}) {
  const q = new URLSearchParams({ pet: petId, surface });
  return req(`/chat?${q}`, { method: 'POST', body: { text }, timeoutMs });
}

/** 最近记忆窗口（GET /chat?pet=&rounds=） */
export async function recentMessages(petId = 'main', rounds) {
  const q = new URLSearchParams({ pet: petId });
  if (rounds !== undefined) q.set('rounds', String(rounds));
  return req(`/chat?${q}`, { timeoutMs: 10000 });
}

/** 桌面状态（pets.<id>.say 就是宠物气泡当前内容） */
export async function getState() {
  return req('/state', { timeoutMs: 10000 });
}

/** 表情包 PNG：/pic/memes/<素材根>/<名称>.png → Buffer（取不到返回 null） */
export async function fetchMemeImage(name, entry = 'main') {
  if (!name) return null;
  const url = `${BASE}/pic/memes/${encodeURIComponent(entry)}/${encodeURIComponent(String(name))}.png`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10000);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: TOKEN ? { 'x-pet-token': TOKEN } : undefined,
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length ? buf : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 读人格包 */
export async function loadPersonas(fileUrl) {
  const raw = await readFile(fileUrl, 'utf8');
  const data = JSON.parse(raw);
  if (!Array.isArray(data.personas) || !data.personas.length) throw new Error('personas.json 里没有 personas 数组');
  return data;
}
