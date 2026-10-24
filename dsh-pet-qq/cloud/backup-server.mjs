/**
 * 记忆备份服务（跑在云端，随机器人一起常驻）。
 *
 * 为什么单独一个 HTTP 服务而不是「云端主动推」：本机会关机，云端 24h 在线；拉取式
 * （本机开机时来拉）才是最省事、最不容易坏的方向——云端不需要知道本机任何凭证。
 *
 * 鉴权：`x-backup-token` 头或 `?token=`，值 = 环境变量 BACKUP_TOKEN（必须设置，否则拒绝启动）。
 * 监听默认 127.0.0.1:3020 —— **只绑本机回环**，跨机访问走 Tailscale 或
 * `ssh -L 3020:127.0.0.1:3020 user@server`，绝不直接暴露公网。
 *
 * 路由：
 *   GET  /health                 → {ok, uptime, pid}
 *   GET  /stats                  → 当前人格 / 记忆条数 / 数据目录
 *   GET  /memory                 → memory.json 全文
 *   POST /snapshot               → 立刻打一份快照，返回文件名
 *   GET  /backups                → 快照清单 [{name, bytes, at}]
 *   GET  /backups/<name>         → 下载某份快照
 */

import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { PATHS, ensureDirs, loadMemory, snapshotMemory } from './lib/store.mjs';
import { stats } from './lib/pet-api.mjs';

const PORT = Number(process.env.BACKUP_PORT || 3020);
const HOST = process.env.BACKUP_HOST || '127.0.0.1';
const TOKEN = (process.env.BACKUP_TOKEN || '').trim();
const SNAPSHOT_EVERY_MS = Number(process.env.BACKUP_INTERVAL_MS || 6 * 3600_000);
const NAME_RE = /^memory-\d{8}-\d{6}\.json$/;

if (!TOKEN) {
  console.error('[backup] 缺少 BACKUP_TOKEN 环境变量，拒绝启动（随便一串长随机字符即可）');
  process.exit(1);
}

function authorized(req, url) {
  const got = req.headers['x-backup-token'] || url.searchParams.get('token') || '';
  return String(got) === TOKEN;
}

function json(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body, null, 2));
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length });
  res.end(buf);
}

const started = Date.now();

async function handle(req, res) {
  const url = new URL(req.url || '/', 'http://' + (req.headers.host || 'localhost'));
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (path === '/health') return json(res, 200, { ok: true, uptime: Math.round((Date.now() - started) / 1000) });

  if (!authorized(req, url)) return json(res, 401, { ok: false, error: 'unauthorized' });

  if (path === '/stats') return json(res, 200, { ok: true, ...(await stats()) });

  if (path === '/memory') {
    if (!existsSync(PATHS.memory)) return json(res, 404, { ok: false, error: '还没有记忆' });
    const buf = await readFile(PATHS.memory);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length });
    return res.end(buf);
  }

  if (path === '/snapshot' && req.method === 'POST') {
    const file = await snapshotMemory();
    if (!file) return json(res, 404, { ok: false, error: '还没有记忆，无法快照' });
    return json(res, 200, { ok: true, name: file.split(/[\\/]/).pop() });
  }

  if (path === '/backups') {
    await ensureDirs();
    const names = (await readdir(PATHS.backupsDir)).filter((f) => NAME_RE.test(f)).sort().reverse();
    const out = [];
    for (const name of names) {
      const s = await stat(join(PATHS.backupsDir, name));
      out.push({ name, bytes: s.size, at: s.mtime.toISOString() });
    }
    return json(res, 200, { ok: true, backups: out });
  }

  const m = path.match(/^\/backups\/([^/]+)$/);
  if (m) {
    const name = decodeURIComponent(m[1]);
    if (!NAME_RE.test(name)) return json(res, 400, { ok: false, error: 'bad name' });
    const file = join(PATHS.backupsDir, name);
    if (!existsSync(file)) return json(res, 404, { ok: false, error: 'not found' });
    const buf = await readFile(file);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length });
    return res.end(buf);
  }

  json(res, 404, { ok: false, error: 'not found' });
}

await ensureDirs();
// 启动即打一份，之后每 6 小时一份（保留最近 72 份 = 约 18 天）
await snapshotMemory().catch(() => {});
setInterval(() => snapshotMemory().catch(() => {}), SNAPSHOT_EVERY_MS).unref?.();

createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error('[backup] 处理失败：', e?.message ?? e);
    try {
      json(res, 500, { ok: false, error: String(e?.message ?? e) });
    } catch {}
  });
}).listen(PORT, HOST, () => {
  console.log(`[backup] 记忆备份服务已启动 http://${HOST}:${PORT}（数据目录 ${PATHS.dataDir}）`);
});

/** 供测试/调试：读一遍当前记忆（不经过 HTTP） */
export async function readMemorySnapshot() {
  return loadMemory();
}
