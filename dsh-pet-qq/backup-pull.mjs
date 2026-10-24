/**
 * 本机侧的「记忆备份拉取」：从云端 backup-server 拉 memory.json 存到本地工作区。
 *
 * 用法（本机开机后跑一次即可；也可以丢进启动文件夹）：
 *   node backup-pull.mjs --url http://100.x.y.z:3020 --token <BACKUP_TOKEN>
 *   node backup-pull.mjs --snapshot          # 先让云端打一份快照再拉
 *   node backup-pull.mjs --list              # 只列云端已有快照
 *
 * 环境变量等价写法：BACKUP_URL / BACKUP_TOKEN。
 * 落盘位置默认 <本文件目录>/backups：
 *   memory-latest.json          最新记忆（每次都覆盖）
 *   memory-<YYYYmmdd-HHMMSS>.json  与上次内容不同才写，保留历史
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { snapshot: false, list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--snapshot') out.snapshot = true;
    else if (a === '--list') out.list = true;
    else if (a === '--url') out.url = argv[++i];
    else if (a === '--token') out.token = argv[++i];
    else if (a === '--out') out.out = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const base = (args.url || process.env.BACKUP_URL || '').replace(/\/+$/, '');
const token = args.token || process.env.BACKUP_TOKEN || '';
const outDir = resolve(args.out || join(HERE, 'backups'));

if (!base || !token) {
  console.error(
    [
      '缺少参数。用法：',
      '  node backup-pull.mjs --url http://100.x.y.z:3020 --token <BACKUP_TOKEN>',
      '也可以设环境变量 BACKUP_URL / BACKUP_TOKEN。',
    ].join('\n'),
  );
  process.exit(2);
}

async function call(path, init = {}) {
  const res = await fetch(base + path, {
    ...init,
    headers: { 'x-backup-token': token, ...(init.headers || {}) },
    signal: AbortSignal.timeout(30_000),
  });
  const type = res.headers.get('content-type') || '';
  const body = type.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status} ${typeof body === 'string' ? body.slice(0, 200) : JSON.stringify(body).slice(0, 200)}`);
  return body;
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function main() {
  const stats = await call('/stats');
  console.log(`云端：${stats.pet?.name}（${stats.pet?.id}），人格 ${stats.active ?? '自定义'}，记忆 ${stats.memoryMessages} 条`);

  if (args.list) {
    const r = await call('/backups');
    if (!r.backups?.length) {
      console.log('云端还没有快照。');
      return;
    }
    for (const b of r.backups) console.log(`  ${b.name}  ${(b.bytes / 1024).toFixed(1)} KB  ${b.at}`);
    return;
  }

  if (args.snapshot) {
    const r = await call('/snapshot', { method: 'POST' });
    console.log(`已让云端打快照：${r.name ?? '(未知)'}`);
  }

  let memory;
  try {
    memory = await call('/memory');
  } catch (e) {
    if (/HTTP 404/.test(e.message)) {
      console.log('云端还没有任何对话记忆，跳过。');
      return;
    }
    throw e;
  }
  await mkdir(outDir, { recursive: true });

  const latest = join(outDir, 'memory-latest.json');
  const text = JSON.stringify(memory, null, 2);
  let changed = true;
  if (existsSync(latest)) {
    try {
      changed = (await readFile(latest, 'utf8')) !== text;
    } catch {
      changed = true;
    }
  }
  const tmp = latest + '.tmp';
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, latest);

  let extra = '';
  if (changed) {
    const file = join(outDir, `memory-${stamp()}.json`);
    await writeFile(file, text, 'utf8');
    extra = `；另存历史副本 ${file.split(/[\\/]/).pop()}`;
  }
  console.log(`已更新 ${latest}（${(Buffer.byteLength(text) / 1024).toFixed(1)} KB）${extra}`);
  if (!changed) console.log('内容与上次一致，未新增历史副本。');
}

main().catch((e) => {
  console.error('拉取失败：' + (e?.message ?? e));
  process.exit(1);
});
