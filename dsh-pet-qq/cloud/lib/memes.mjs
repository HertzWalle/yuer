/**
 * 表情包（云端版）：与 dsh-pet src/host/memes.ts 同一套语义，但支持 gif/jpg 与「一个名字多张图」。
 *
 * - 池 = pet.json 的 memes（名称 → 描述）+ data/memes 里真实存在的素材：
 *   · `<名称>.png|gif|jpg|jpeg|webp`（老格式，一张）
 *   · `<名称>/` 目录（表情包分类，多张，发送时随机取一张）
 * - 对话时把整张清单交给模型，模型在结尾写 [图:名称]，只有命中池内才采纳（防幻觉）；
 * - 解析失败/没选/只回标记不回正文 → 一律当作没选，正文原样保留，绝不吞回复。
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

const IMG_TAG = /\[图[:：]\s*([^\]\n]+?)\s*\]\s*$/;
const MEME_EXTS = ['.png', '.gif', '.jpg', '.jpeg', '.webp'];
const MEME_EXT_SET = new Set(MEME_EXTS);

function imagesIn(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => MEME_EXT_SET.has(extname(n).toLowerCase()))
    .sort()
    .map((n) => join(dir, n));
}

/**
 * 解析「名称 → 素材文件」。
 * @param {string[]} dirs 素材根目录
 * @param {string} name 表情包名称
 * @param {{random?: boolean}} [opts] random=true 时在分类目录里随机挑一张
 * @returns {string|null}
 */
export function resolveMemeFile(dirs, name, opts = {}) {
  const key = String(name ?? '').trim();
  if (!key || !Array.isArray(dirs) || dirs.length === 0) return null;
  for (const dir of dirs) {
    for (const ext of MEME_EXTS) {
      const file = join(dir, key + ext);
      if (existsSync(file)) return file;
    }
  }
  for (const dir of dirs) {
    const sub = join(dir, key);
    if (!existsSync(sub) || !statSync(sub).isDirectory()) continue;
    const files = imagesIn(sub);
    if (files.length === 0) continue;
    return opts.random ? files[Math.floor(Math.random() * files.length)] : files[0];
  }
  return null;
}

/** @returns {{name: string, desc: string, file: string}[]} */
export function readMemePool(memes, dirs) {
  if (!memes || typeof memes !== 'object' || Array.isArray(memes)) return [];
  if (!dirs || dirs.length === 0) return [];
  const out = [];
  for (const [name, desc] of Object.entries(memes)) {
    const text = typeof desc === 'string' ? desc.trim() : '';
    if (!name || !text) continue;
    const file = resolveMemeFile(dirs, name);
    if (!file) continue;
    out.push({ name, desc: text, file });
  }
  return out;
}

/** 按 chatImageLimit 截断：<=0 / 非有限数 = 不限制，否则取前 N 张 */
export function limitPool(pool, limit) {
  const n = Math.floor(Number(limit));
  if (!Number.isFinite(n) || n <= 0) return pool;
  return pool.slice(0, n);
}

export function memeCatalog(pool) {
  return pool.map((m) => '- ' + m.name + '：' + m.desc).join('\n');
}

/**
 * 附在 user 正文之后的配图指令。
 * 与 dsh-pet 的 imageInstruction 相比**故意收紧了频率**：dsh-pet 是「可选」，
 * 模型几乎每条都带图；这里明确要求「大多数回复不要带图」，只在特别贴切时用。
 */
export function imageInstruction(pool) {
  if (pool.length === 0) return '';
  return (
    '\n\n[配图] 你偶尔会在回复结尾附一张表情包。只有跟当前语境特别贴合时才用，' +
    '大多数回复不要带图（连着带好几条会显得很吵）；想带就从下列清单里挑一张最贴合的：\n' +
    memeCatalog(pool) +
    '\n挑中就在回复最后另起一行写 [图:名称]（名称原样照抄）；没有特别合适的就完全不要写这个标记。'
  );
}

export function matchMeme(pool, name) {
  const key = String(name ?? '').trim();
  return key ? pool.find((m) => m.name === key) : undefined;
}

/** @returns {{text: string, image?: string}} */
export function extractChatImage(text, pool) {
  const m = IMG_TAG.exec(text ?? '');
  if (!m) return { text };
  const hit = matchMeme(pool, m[1] ?? '');
  const body = String(text).slice(0, m.index).trim();
  if (!hit || !body) return { text };
  return { text: body, image: hit.name };
}
