#!/usr/bin/env node
/**
 * 把 AstrBot 表情包仓库（fetch-memepack.mjs 的产物）导入云端数据目录。
 *
 * 做三件事：
 * 1. 按 manifest 的分类建「名字」——分类名换成中文短名（如 happy → 开心），描述取 manifest 的 categories[*].description；
 * 2. 图片拷到 <data>/memes/<中文名>/ 下（同名分类多张，发送时随机取一张）；
 * 3. 把新名字合并进 <data>/pet.json 的 memes（保留原有表情包与顺序，新条目追加在后）。
 *
 * 用法：
 *   node cloud/import-memes.mjs --pack downloads/memepack-deepseek --data cloud/data
 *   node cloud/import-memes.mjs --pack ... --data ... --per 4 --maxkb 1500 --dry
 *
 * 子集会打印「新增 N 个分类 / 跳过 M 张过大的图」，并把结果写成 <data>/memes.extra.json 供服务器合并。
 */

import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

/** 分类 → 中文短名（未列出的分类用原 key，避免漏图） */
const LABELS = {
  angry: '生气',
  baka: '笨蛋',
  color: '暧昧',
  confused: '疑惑',
  cpu: '卡壳',
  fool: '装傻',
  givemoney: '要钱',
  happy: '开心',
  like: '喜欢',
  meow: '卖萌',
  morning: '早安',
  reply: '等回复',
  sad: '难过',
  see: '偷看',
  shy: '害羞',
  sigh: '叹气',
  sleep: '睡觉',
  surprised: '惊讶',
  work: '干活',
  _red: '股票涨了',
  _green: '股票跌了',
  _stock: '说股票',
  _genshin: '原神',
  _kg: '酷狗',
  _lkll: '库洛拉了',
  _lksl: '库洛神了',
  _laugh: '大笑',
};

const IMG_RE = /\.(png|gif|jpe?g|webp)$/i;

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

/** 去掉零宽字符（manifest 里有几个分类 key 被插了 U+200C） */
const clean = (s) => String(s ?? '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();

const pack = resolve(String(arg('pack', 'downloads/memepack-deepseek')));
const data = resolve(String(arg('data', 'cloud/data')));
const per = Math.max(1, Number(arg('per', 4)) || 4);
const maxKb = Math.max(0, Number(arg('maxkb', 1500)) || 0);
const dry = arg('dry', false) === true;
const writePet = arg('write-pet', true) !== '--no-write-pet';

const manifestPath = join(pack, 'manifest.json');
if (!existsSync(manifestPath)) {
  console.error(`找不到 ${manifestPath}，先跑 cloud/fetch-memepack.mjs`);
  process.exit(1);
}

const manifest = JSON.parse((await readFile(manifestPath, 'utf8')).replace(/^\uFEFF/, ''));
const categories = manifest.categories || {};
/** manifest 里几个分类 key 插了零宽字符，按「清洗后的 key」查描述 */
const catByKey = new Map(Object.entries(categories).map(([k, v]) => [clean(k), v]));
const memesRoot = join(pack, 'memes');
const outMemes = join(data, 'memes');

async function dirs(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function pick(catDir) {
  const names = (await readdir(catDir)).filter((n) => IMG_RE.test(n));
  const items = [];
  for (const name of names) {
    const s = await stat(join(catDir, name));
    items.push({ name, size: s.size });
  }
  let chosen = items;
  if (maxKb > 0) {
    const small = items.filter((i) => i.size <= maxKb * 1024);
    chosen = small.length > 0 ? small : items;
  }
  chosen.sort((a, b) => a.size - b.size);
  return chosen.slice(0, per);
}

const extra = {};
let copied = 0;
let skippedBig = 0;
let bytes = 0;
const rows = [];

for (const rawKey of await dirs(memesRoot)) {
  const key = clean(rawKey);
  const label = LABELS[key] ?? key;
  const desc = clean(catByKey.get(key)?.description ?? '');
  if (!desc) {
    console.log(`跳过 ${key}：manifest 里没有描述`);
    continue;
  }
  const files = await pick(join(memesRoot, rawKey));
  if (files.length === 0) continue;
  const target = join(outMemes, label);
  if (!dry) await mkdir(target, { recursive: true });
  for (const f of files) {
    if (!dry) await copyFile(join(memesRoot, rawKey, f.name), join(target, f.name));
    copied += 1;
    bytes += f.size;
  }
  const total = (await readdir(join(memesRoot, rawKey))).length;
  skippedBig += Math.max(0, total - files.length);
  extra[label] = desc;
  rows.push([label, key, files.length, total, (files.reduce((s, f) => s + f.size, 0) / 1024).toFixed(0) + 'KB']);
}

console.log(`分类 ${rows.length} 个，拷入 ${copied} 张，${(bytes / 1048576).toFixed(1)} MB，跳过 ${skippedBig} 张`);
for (const r of rows) console.log(`  ${r[0].padEnd(6)} ← ${r[1].padEnd(10)} ${r[2]}/${r[3]} 张  ${r[4]}`);

if (!dry) {
  await mkdir(data, { recursive: true });
  await writeFile(join(data, 'memes.extra.json'), JSON.stringify(extra, null, 2), 'utf8');
  console.log(`写入 ${join(data, 'memes.extra.json')}`);
}

if (writePet && !dry) {
  const petPath = join(data, 'pet.json');
  const pet = JSON.parse(await readFile(petPath, 'utf8'));
  const before = Object.keys(pet.memes || {}).length;
  pet.memes = { ...(pet.memes || {}), ...extra };
  // 让整池都能进提示词（默认 10 会截断，新分类就永远轮不到）
  const poolSize = Object.keys(pet.memes).length;
  pet.chatImageLimit = Math.max(Number(pet.chatImageLimit) || 0, poolSize);
  await writeFile(petPath, JSON.stringify(pet, null, 2), 'utf8');
  console.log(`pet.json：表情包 ${before} → ${poolSize}，chatImageLimit=${pet.chatImageLimit}`);
}
