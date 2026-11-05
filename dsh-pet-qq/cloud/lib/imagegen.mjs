/**
 * 生图（ModelScope API-Inference，异步任务式）。
 *
 * 为什么是 ModelScope：它给免费额度（账号日配额 + 单模型日配额），中文提示词理解好，
 * Qwen-Image 的中文排版/文字渲染明显强于 flux；服务器直连约 0.2s 建连。备选见 docs/ROADMAP。
 *
 * 客户端流程改编自 `modelscope-image-mcp@1.0.3`（MIT，零依赖，18KB 单文件）——它把两个坑
 * 写在注释里，这里照抄这两条硬约定，否则永远拿不到 task_id / output_images：
 *   1. 提交必须带 `X-ModelScope-Async-Mode: true`；
 *   2. 轮询必须带 `X-ModelScope-Task-Type: image_generation`。
 *
 * 本模块只负责「拿提示词换一张图」+ 配额与安全闸，不关心发给谁（那是桥的事）。
 */

import { dirname, join } from 'node:path';

import { mkdir, rename, writeFile } from 'node:fs/promises';
import { PATHS, ensureDirs, readJson, withLock } from './store.mjs';

const DEFAULT_BASE = 'https://api-inference.modelscope.cn/v1';
const DEFAULT_MODEL = 'Qwen/Qwen-Image';
const DEFAULT_SIZE = '1024x1024';
const DEFAULT_TIMEOUT_MS = 240_000;
const DEFAULT_POLL_MS = 2_000;

/** 环境变量每次都现读：自测要用临时 base/key，不能在模块加载时固化 */
function cfg() {
  return {
    base: String(process.env.MODELSCOPE_API_BASE || DEFAULT_BASE).replace(/\/+$/, ''),
    key: String(process.env.MODELSCOPE_API_KEY || '').trim(),
    model: process.env.MODELSCOPE_MODEL || DEFAULT_MODEL,
    size: process.env.MODELSCOPE_SIZE || DEFAULT_SIZE,
    timeoutMs: Number(process.env.MODELSCOPE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
  };
}

/** 模型表：只留实测能用的；`fast` 用于「她随口要一张」时降延迟 */
export const IMAGE_MODELS = [
  { id: 'Qwen/Qwen-Image', name: 'Qwen-Image', fast: false, note: '中文最稳，文字渲染强' },
  { id: 'Tongyi-MAI/Z-Image-Turbo', name: 'Z-Image-Turbo', fast: true, note: '轻量快，出图快但细节少' },
  { id: 'Tongyi-MAI/Z-Image', name: 'Z-Image', fast: false, note: 'Z-Image 标准版，画质更好' },
  { id: 'black-forest-labs/FLUX.1-Krea-dev', name: 'FLUX.1-Krea-dev', fast: false, note: '质感细腻，中文理解差' },
];

/* ------------------------------ 安全闸 ------------------------------ */

/**
 * 生图比聊天危险得多：群里已经有人当面要过「涩图」。这里是硬拦，不靠模型自觉。
 * 命中任一条就直接拒，并把理由交给调用方去说人话。
 */
const BLOCKED = [
  // 露骨/色情
  /裸|全祼|露出|色情|涩图|色图|做爱|性交|口交|乳|下体|生殖器|内裤|情趣|调教|捆绑|强奸|迷奸|开房|约炮/iu,
  /\b(?:nude|naked|nsfw|porn|hentai|explicit|topless|lingerie|erotic|sex)\b/iu,
  // 血腥/猎奇
  /血腥|分尸|肢解|虐杀|爆头|割喉|\bgore\b|\bsnuff\b|\bdecapitat/iu,
  // 未成年相关（任何性化）
  /(?:萝莉|正太|幼女|幼童|小学生|初中生|未成年).{0,12}(?:裸|色|情|性|胸|腿|内裤|调教)/iu,
  /(?:loli|shota|lolita).{0,12}(?:nude|naked|nsfw|sexy|underwear)/iu,
  // 真实人物的伪造（防「画一下某某明星的裸照」这类）
  /(?:明星|网红|主播|同学|同事|老师|前女友|女朋友|男朋友|老婆|老公).{0,10}(?:裸|色|情|性|床|内衣|泳装)/iu,
];

export function checkPrompt(prompt) {
  const p = String(prompt ?? '').trim();
  if (!p) return { ok: false, reason: 'empty' };
  if (p.length > 800) return { ok: false, reason: 'too-long' };
  for (const re of BLOCKED) {
    if (re.test(p)) return { ok: false, reason: 'blocked' };
  }
  return { ok: true, prompt: p };
}

/* ------------------------------ 配额 ------------------------------ */

const QUOTA_FILE = () => join(PATHS.dataDir, 'image-quota.json');

function todayKey(now = new Date()) {
  const d = new Date(now.getTime() + 8 * 3600_000); // 固定按北京时间算「今天」
  return d.toISOString().slice(0, 10);
}

/**
 * 取一张图的配额。`limit` 为 0/负数 表示不限。
 * 返回 { ok, used, limit }；ok=false 时调用方应回一句「今天画够了」。
 */
export async function takeQuota(scope = 'private', limit = 0) {
  await ensureDirs();
  return withLock(async () => {
    const all = await readJson(QUOTA_FILE(), {});
    const day = todayKey();
    const bucket = all[day] && typeof all[day] === 'object' ? all[day] : {};
    const used = Math.max(0, Math.floor(Number(bucket[scope]) || 0));
    if (Number.isFinite(limit) && limit > 0 && used >= limit) {
      return { ok: false, used, limit };
    }
    bucket[scope] = used + 1;
    all[day] = bucket;
    // 只留最近 14 天，别把文件养大
    const days = Object.keys(all).sort();
    for (const d of days.slice(0, Math.max(0, days.length - 14))) delete all[d];
    // 注意：不能用 store.writeJson —— 它自己也走 withLock，而这里已经持有锁，会死锁。
    const file = QUOTA_FILE();
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, JSON.stringify(all, null, 2), 'utf8');
    await rename(tmp, file);
    return { ok: true, used: used + 1, limit };
  });
}

/* ------------------------------ 主流程 ------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function submitTask(prompt, { base, key, model, size, signal }) {
  const res = await fetch(`${base}/images/generations`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'X-ModelScope-Async-Mode': 'true',
    },
    body: JSON.stringify({ model, prompt, n: 1, size }),
    // 提交这一步也要有超时：没有超时的 fetch 会一直挂着，桥那边看起来就是「她卡住了」
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`提交任务失败：HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  if (!res.ok || !data.task_id) throw new Error(`提交任务失败：HTTP ${res.status} ${JSON.stringify(data).slice(0, 300)}`);
  return data.task_id;
}

async function waitTask(taskId, { base, key, timeoutMs, signal }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${base}/tasks/${encodeURIComponent(taskId)}`, {
      headers: {
        Authorization: `Bearer ${key}`,
        'X-ModelScope-Task-Type': 'image_generation',
      },
      signal,
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`查询任务失败：HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    const status = data.task_status;
    if (status === 'SUCCEED') {
      const list = Array.isArray(data.output_images) ? data.output_images.filter(Boolean) : [];
      if (!list.length) throw new Error('任务成功但没有图片');
      return list;
    }
    if (status === 'FAILED') throw new Error(`任务失败：${JSON.stringify(data.errors || data).slice(0, 300)}`);
    await sleep(Number(process.env.MODELSCOPE_POLL_MS || DEFAULT_POLL_MS) || DEFAULT_POLL_MS);
  }
  throw new Error(`任务超时（${Math.round(timeoutMs / 1000)}s）`);
}

async function fetchImage(url, { signal } = {}) {
  const res = await fetch(url, {
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`下载图片失败：HTTP ${res.status}`);
  const mime = String(res.headers.get('content-type') || '').split(';')[0] || 'image/png';
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length < 1024) throw new Error('下载到的图片太小，可能不是图');
  return { buffer, mime };
}

/** 环境里有没有 key（没配就别让她以为能画） */
export function imageReady() {
  return Boolean(cfg().key);
}

/**
 * 提示词 → 一张图。
 * 返回 { ok:true, buffer, mime, model, ms, taskId } 或 { ok:false, reason, message }。
 * 不抛异常：桥那边要能降级成一句人话。
 */
export async function generateImage(prompt, { model, size, signal, fast = false } = {}) {
  const c = cfg();
  if (!c.key) return { ok: false, reason: 'no-key', message: '生图没有配 key' };
  const checked = checkPrompt(prompt);
  if (!checked.ok) return { ok: false, reason: checked.reason, message: '提示词不可用' };

  const pick = model || (fast ? IMAGE_MODELS.find((m) => m.fast)?.id : c.model) || DEFAULT_MODEL;
  const started = Date.now();
  try {
    const taskId = await submitTask(checked.prompt, { base: c.base, key: c.key, model: pick, size: size || c.size, signal });
    const urls = await waitTask(taskId, { base: c.base, key: c.key, timeoutMs: c.timeoutMs, signal });
    const { buffer, mime } = await fetchImage(urls[0], { signal });
    return { ok: true, buffer, mime, model: pick, taskId, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, reason: 'generate-error', message: String(e?.message || e), ms: Date.now() - started };
  }
}

/** 给模型看的画图指令（只在有资格时拼进 system） */
export function drawInstruction() {
  return [
    '\n\n【画图】你也能画图。真想给她画一张时，在回复最后另起一行写 [画:一句画面描述]，',
    '描述要具体（谁、在哪、什么风格、什么氛围），别写露骨、血腥或真人肖像；',
    '不画就别写这个标记，也别口头说「我给你画」却不写标记。',
  ].join('');
}

const DRAW_TAG = /\[画[:：]\s*([^\]\n]{1,300}?)\s*\]\s*$/u;

/** 从回复里抠出 [画:…]：命中返回描述并剥掉标记，没命中原样返回 */
export function extractDraw(text) {
  const raw = String(text ?? '');
  const m = DRAW_TAG.exec(raw);
  if (!m) return { draw: null, text: raw };
  const prompt = String(m[1] || '').trim();
  const rest = raw.slice(0, m.index).trim();
  if (!prompt) return { draw: null, text: raw };
  // 只写了标记、没有正文时保留原文（别把她的话吞掉）
  return { draw: prompt, text: rest || raw };
}

/** 没给她画图资格时，模型自己写出来的 `[画:…]` 也要剥掉（别让标记漏到聊天里） */
export function stripDrawTag(text) {
  return String(text ?? '')
    .replace(/\[画[:：][^\]\n]{0,300}\]/gu, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
