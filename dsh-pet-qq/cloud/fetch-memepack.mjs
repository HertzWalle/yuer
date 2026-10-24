#!/usr/bin/env node
/**
 * 从 jsDelivr CDN 拉取 AstrBot 表情包仓库（GitHub 直连不通，codeload 只有 7KB/s）。
 *
 * 用法：
 *   node cloud/fetch-memepack.mjs --repo shirachino/astrbot-deepseek-meme-pack
 *   node cloud/fetch-memepack.mjs --repo ... --out downloads/memepack --only memes/happy,memes/sad
 *
 * 产物：<out>/memes/<分类>/<原文件名>，以及 <out>/manifest.json。
 */

import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const CDNS = ['https://gcore.jsdelivr.net', 'https://fastly.jsdelivr.net', 'https://cdn.jsdelivr.net'];
const CONCURRENCY = 6;
const RETRIES = 3;

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const repo = arg('repo');
if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
  console.error('缺少 --repo owner/name');
  process.exit(1);
}
const out = resolve(arg('out', join('downloads', 'memepack')));
const only = (arg('only', '') || '').split(',').map((s) => s.trim()).filter(Boolean);

const api = (path) => `https://api.github.com/repos/${repo}${path}`;
const ghHeaders = { 'user-agent': 'dsh-pet-memepack', accept: 'application/vnd.github+json' };

async function fetchJson(url) {
  const r = await fetch(url, { headers: ghHeaders, signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.json();
}

async function exists(file) {
  try {
    const s = await stat(file);
    return s.size > 0;
  } catch {
    return false;
  }
}

async function download(rel) {
  const dest = join(out, rel);
  if (await exists(dest)) return { rel, skipped: true, bytes: 0 };
  const errors = [];
  for (let attempt = 0; attempt < RETRIES; attempt += 1) {
    const cdn = CDNS[(attempt + rel.length) % CDNS.length];
    const url = `${cdn}/gh/${repo}@main/${rel}`;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length === 0) throw new Error('空响应');
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, buf);
      return { rel, bytes: buf.length };
    } catch (e) {
      errors.push(`${cdn.split('/')[2]}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  throw new Error(`${rel} 下载失败（${errors.join('; ')}）`);
}

async function main() {
  const meta = await fetchJson(api(''));
  const branch = meta.default_branch || 'main';
  console.log(`仓库 ${repo}，分支 ${branch}`);

  const manifestRes = await fetch(`https://gcore.jsdelivr.net/gh/${repo}@${branch}/manifest.json`, {
    signal: AbortSignal.timeout(60_000),
  });
  if (!manifestRes.ok) throw new Error(`manifest.json → HTTP ${manifestRes.status}`);
  const manifest = JSON.parse((await manifestRes.text()).replace(/^\uFEFF/, ''));
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  const tree = await fetchJson(api(`/git/trees/${branch}?recursive=1`));
  let files = (tree.tree || [])
    .filter((t) => t.type === 'blob' && /^memes\/.+\.(png|gif|jpe?g|webp)$/i.test(t.path))
    .map((t) => ({ path: t.path, size: t.size || 0 }));
  if (only.length) files = files.filter((f) => only.some((p) => f.path.startsWith(p)));
  const totalBytes = files.reduce((s, f) => s + f.size, 0);
  console.log(`待下载 ${files.length} 张，合计 ${(totalBytes / 1048576).toFixed(1)} MB`);

  let done = 0;
  let gotBytes = 0;
  let skipped = 0;
  const queue = [...files];
  const started = Date.now();

  async function worker() {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      const r = await download(item.path);
      done += 1;
      gotBytes += r.bytes;
      if (r.skipped) skipped += 1;
      if (done % 10 === 0 || done === files.length) {
        const sec = (Date.now() - started) / 1000;
        console.log(`  ${done}/${files.length} · ${(gotBytes / 1048576).toFixed(1)}MB · ${(gotBytes / 1024 / sec).toFixed(0)}KB/s`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`完成：${files.length - skipped} 张新下载，${skipped} 张已存在，${(gotBytes / 1048576).toFixed(1)} MB → ${out}`);
}

main().catch((e) => {
  console.error('失败：', e.message);
  process.exit(1);
});
