/**
 * 看图：把 QQ 消息里的图片变成一句文字描述，塞进模型上下文。
 *
 * DeepSeek 的 /chat/completions 现在收 OpenAI 的 image_url 格式（实测 deepseek-chat → deepseek-flash
 * 能正确描述图片），所以不需要另买视觉模型，直接把图 base64 塞进去就行。
 *
 * 两条铁律：
 *  1. 看图失败绝不影响回消息——所有失败都返回 null，调用方退化成「[图片]」。
 *  2. 同一张图只描述一次——按 URL 的 sha1 缓存到 data/vision-cache.json（7 天、最多 300 条），
 *     群里反复转发的同一张图不会反复烧 token。
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { PATHS } from './store.mjs';
import { chatCompletion } from './llm.mjs';

const CACHE_FILE = join(PATHS.dataDir, 'vision-cache.json');
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
const CACHE_MAX = 300;
const MAX_BYTES = 4 * 1024 * 1024; // 太大就别看了，浪费 token 又容易超时
const FETCH_TIMEOUT = 15_000;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const QUESTION =
  '用一两句中文说清这张图的内容：画的是什么/写了什么字/是什么梗。' +
  '如果图里是聊天截图，把关键的几句对话和谁在说也说出来。只描述，不要评论。';

let cache = null;

async function loadCache() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(await readFile(CACHE_FILE, 'utf8'));
    cache = raw && typeof raw === 'object' ? raw : {};
  } catch {
    cache = {};
  }
  return cache;
}

async function saveCache() {
  try {
    const now = Date.now();
    const entries = Object.entries(cache ?? {}).filter(([, v]) => v && now - (v.at ?? 0) < CACHE_TTL);
    if (entries.length > CACHE_MAX) entries.sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0));
    const kept = Object.fromEntries(entries.slice(0, CACHE_MAX));
    cache = kept;
    await writeFile(CACHE_FILE, JSON.stringify(kept, null, 2), 'utf8');
  } catch {
    /* 缓存写不进去不算错 */
  }
}

function keyOf(url) {
  return createHash('sha1').update(String(url)).digest('hex');
}

/** 把图片地址变成 data: URL（已经是 data: 就原样返回） */
export async function toDataUrl(url, { timeoutMs = FETCH_TIMEOUT } = {}) {
  const src = String(url ?? '').trim();
  if (!src) return null;
  if (src.startsWith('data:')) return src;
  if (!/^https?:\/\//i.test(src)) return null;
  try {
    const res = await fetch(src, {
      headers: { 'user-agent': UA, accept: 'image/*' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_BYTES) return null;
    const type = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
    return `data:${type};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

/**
 * 看图 → 一句中文描述。失败返回 null（调用方退化成「[图片]」）。
 * @param {string} url  图片地址（QQ 的 multimedia 链接或 data:）
 * @param {{timeoutMs?: number, question?: string, fresh?: boolean}} [opts]
 */
export async function describeImage(url, opts = {}) {
  const src = String(url ?? '').trim();
  if (!src) return null;

  const store = await loadCache();
  const key = keyOf(src);
  if (!opts.fresh) {
    const hit = store[key];
    if (hit && Date.now() - (hit.at ?? 0) < CACHE_TTL && hit.desc) return hit.desc;
  }

  const dataUrl = await toDataUrl(src, { timeoutMs: opts.timeoutMs });
  if (!dataUrl) return null;

  const res = await chatCompletion(
    [
      {
        role: 'user',
        content: [
          { type: 'text', text: opts.question || QUESTION },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
    { temperature: 0.2, maxTokens: 160, timeoutMs: opts.timeoutMs ?? 40_000 },
  );
  if (!res.ok) return null;

  const desc = res.text.replace(/\s+/g, ' ').trim().slice(0, 220);
  if (!desc) return null;
  store[key] = { at: Date.now(), desc };
  await saveCache();
  return desc;
}

/** 测试用：清掉内存里的缓存 */
export function __resetVisionCache() {
  cache = null;
}
