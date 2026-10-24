/**
 * 极简下载器（只依赖 Node 内置 fetch）：
 *   node lib/download.mjs <url> <outfile> [--range=bytes=0-262143]
 * GitHub Release 资产请优先用 --gh=owner/repo/asset-name 形式（见下），
 * 因为本机直连 github.com 会超时，而 api.github.com + release-assets CDN 可达。
 *   node lib/download.mjs --gh=NapNeko/NapCatQQ/NapCat.Shell.zip out.zip
 */
import { createWriteStream } from 'node:fs';
import { mkdir, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

async function resolveGh(spec) {
  const m = spec.match(/^([^/]+)\/([^/]+)\/(.+)$/);
  if (!m) throw new Error('--gh= 格式应为 owner/repo/asset-name');
  const [, owner, repo, name] = m;
  const rel = await (await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, {
    headers: { 'user-agent': 'dsh-downloader' },
  })).json();
  const asset = (rel.assets ?? []).find((a) => a.name === name);
  if (!asset) throw new Error(`release 里没有资产 ${name}（有：${(rel.assets ?? []).map((a) => a.name).join(', ')}）`);
  return {
    url: `https://api.github.com/repos/${owner}/${repo}/releases/assets/${asset.id}`,
    headers: { accept: 'application/octet-stream', 'user-agent': 'dsh-downloader' },
    size: asset.size,
  };
}

export async function download(urlOrGh, outFile, { timeoutMs = 15 * 60_000, label, resume = false } = {}) {
  const isGh = urlOrGh.startsWith('--gh=') || urlOrGh.startsWith('gh:');
  const spec = urlOrGh.replace(/^--gh=/, '').replace(/^gh:/, '');
  const { url, headers, size } = isGh
    ? await resolveGh(spec)
    : { url: urlOrGh, headers: { 'user-agent': 'dsh-downloader' }, size: 0 };

  await mkdir(dirname(outFile), { recursive: true });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const t0 = Date.now();
  let lastTick = 0;
  const part = outFile + '.part';
  let start = 0;
  if (resume) {
    try {
      start = (await stat(part)).size;
    } catch {
      start = 0;
    }
  }
  try {
    const res = await fetch(url, {
      headers: start ? { ...headers, range: `bytes=${start}-` } : headers,
      redirect: 'follow',
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url.slice(0, 120)}`);
    if (start && res.status !== 206) start = 0; // 服务器不给续传就从头来
    const total = (Number(res.headers.get('content-length')) || 0) + start || size || 0;
    let got = start;
    const body = Readable.fromWeb(res.body);
    body.on('data', (c) => {
      got += c.length;
      const now = Date.now();
      if (now - lastTick > 3000) {
        lastTick = now;
        const kbps = got / 1024 / ((now - t0) / 1000);
        const pct = total ? ((got / total) * 100).toFixed(1) + '%' : '?';
        console.log(`  ${label ?? outFile}: ${(got / 1048576).toFixed(1)}MB/${total ? (total / 1048576).toFixed(1) + 'MB' : '?'} (${pct}) ${kbps.toFixed(0)}KB/s`);
      }
    });
    if (resume) {
      await pipeline(body, createWriteStream(part, { flags: start ? 'a' : 'w' }));
      await rename(part, outFile);
    } else {
      await pipeline(body, createWriteStream(outFile));
    }
    console.log(`  完成 ${outFile}（${(got / 1048576).toFixed(2)}MB，${((Date.now() - t0) / 1000).toFixed(0)}s）`);
    return { file: outFile, bytes: got };
  } finally {
    clearTimeout(timer);
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll('\\', '/').split('/').pop())) {
  const args = process.argv.slice(2);
  const resume = args.includes('--resume');
  const [src, dst] = args.filter((a) => a !== '--resume');
  if (!src || !dst) {
    console.log('用法：node lib/download.mjs <url|--gh=owner/repo/asset> <outfile> [--resume]');
    process.exit(1);
  }
  download(src, dst, { resume }).catch((e) => {
    console.error('下载失败：' + e.message);
    process.exitCode = 1;
  });
}
