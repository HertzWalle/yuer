// P1：Letta 记忆块的审计与回滚。
// 每轮对话前后各拍一次快照，diff 出「她改了什么」，落 data/letta-audit.jsonl；
// 快照本身留在 data/letta-snapshots/，用 /回滚 <id> 把某一块恢复回去。
//
// 设计取舍：
// - 不去改 Letta 自己的表结构（升级不炸），只从外面读块、对比、留痕；
// - 快照只存块的值（几个 KB），不存整库；
// - 任何一步失败都只是「没记上账」，不能影响她正常回话。

import { appendFile, mkdir, readdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PATHS } from './store.mjs';

const AUDIT_FILE = join(dirname(PATHS.memory), 'letta-audit.jsonl');
const SNAP_DIR = join(dirname(PATHS.memory), 'letta-snapshots');
const KEEP_SNAPSHOTS = 200;
const KEEP_AUDIT_LINES = 2000;

function timeout(ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, done: () => clearTimeout(t) };
}

async function req(cfg, path, init = {}, ms = 15_000) {
  const base = String(cfg.baseUrl || '').replace(/\/+$/, '');
  const { signal, done } = timeout(ms);
  try {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { accept: 'application/json', connection: 'close', ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers || {}) },
      signal,
    });
    if (!res.ok) return { ok: false, status: res.status, data: null };
    return { ok: true, status: res.status, data: await res.json().catch(() => null) };
  } catch (e) {
    return { ok: false, status: 0, error: e?.name === 'AbortError' ? 'timeout' : e?.message ?? String(e) };
  } finally {
    done();
  }
}

function normBlock(b) {
  return {
    id: String(b?.id ?? ''),
    label: String(b?.label ?? ''),
    value: String(b?.value ?? ''),
    limit: Number(b?.limit ?? 0) || 0,
    readOnly: Boolean(b?.read_only ?? b?.readOnly),
  };
}

/** 读她当前的记忆块。Letta 有两个等价入口，先试 /blocks/，再试 /agents/:id/blocks */
export async function listBlocks(cfg) {
  const id = encodeURIComponent(cfg.agentId);
  let r = await req(cfg, `/blocks/?agent_id=${id}&limit=100`);
  let list = Array.isArray(r.data) ? r.data : r.data?.blocks;
  if (!r.ok || !Array.isArray(list)) {
    r = await req(cfg, `/agents/${id}/blocks`);
    list = Array.isArray(r.data) ? r.data : r.data?.blocks;
  }
  if (!Array.isArray(list)) return null;
  return list.map(normBlock).filter((b) => b.id && b.label);
}

/** 拍一张快照（返回文件名 + 块内容） */
export async function takeSnapshot(cfg, { reason = 'auto' } = {}) {
  const blocks = await listBlocks(cfg);
  if (!blocks) return null;
  await mkdir(SNAP_DIR, { recursive: true });
  const at = new Date();
  const id = `${at.toISOString().replace(/[-:T.]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`;
  const file = join(SNAP_DIR, `snap-${id}.json`);
  const shot = { id, at: at.toISOString(), reason, agentId: cfg.agentId, blocks };
  await writeFile(file, JSON.stringify(shot, null, 2), 'utf8');
  await pruneSnapshots();
  return { id, file, shot };
}

async function pruneSnapshots() {
  try {
    const names = (await readdir(SNAP_DIR)).filter((n) => n.startsWith('snap-') && n.endsWith('.json')).sort();
    const extra = names.length - KEEP_SNAPSHOTS;
    for (const n of names.slice(0, Math.max(0, extra))) await unlink(join(SNAP_DIR, n)).catch(() => {});
  } catch {
    /* 清不掉就算了 */
  }
}

/** 对比两份块：只返回真正变了的 */
export function diffBlocks(prev = [], next = []) {
  const byLabel = new Map(next.map((b) => [b.label, b]));
  const changes = [];
  for (const old of prev) {
    const now = byLabel.get(old.label);
    if (!now) {
      changes.push({ label: old.label, blockId: old.id, kind: 'removed', before: old.value, after: '' });
      continue;
    }
    if (now.value !== old.value) {
      changes.push({
        label: old.label,
        blockId: now.id,
        kind: now.readOnly ? 'readonly-changed' : 'edited',
        deltaChars: now.value.length - old.value.length,
        before: old.value,
        after: now.value,
      });
    }
  }
  for (const b of next) {
    if (!prev.some((p) => p.label === b.label)) {
      changes.push({ label: b.label, blockId: b.id, kind: 'added', before: '', after: b.value, deltaChars: b.value.length });
    }
  }
  return changes;
}

const head = (s, n = 200) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);

/** 一轮对话结束：对比前后快照、把改动记进账本 */
export async function recordTurn(cfg, { before, after, text = '', reply = '', tools = [] } = {}) {
  if (!before?.shot || !after?.shot) return [];
  const changes = diffBlocks(before.shot.blocks, after.shot.blocks);
  const entry = {
    ts: new Date().toISOString(),
    at: after.shot.at,
    agentId: cfg.agentId,
    heard: head(text, 120),
    said: head(reply, 120),
    tools: tools.slice(0, 6),
    snapshot: after.id,
    beforeSnapshot: before.id,
    changes: changes.map((c) => ({
      label: c.label,
      kind: c.kind,
      deltaChars: c.deltaChars ?? 0,
      beforeHead: head(c.before, 160),
      afterHead: head(c.after, 160),
    })),
  };
  try {
    await mkdir(dirname(AUDIT_FILE), { recursive: true });
    await appendFile(AUDIT_FILE, JSON.stringify(entry) + '\n', 'utf8');
    await trimAudit();
  } catch {
    /* 记账失败不影响回话 */
  }
  return changes;
}

async function trimAudit() {
  try {
    const raw = await readFile(AUDIT_FILE, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    if (lines.length <= KEEP_AUDIT_LINES) return;
    await writeFile(AUDIT_FILE, lines.slice(-KEEP_AUDIT_LINES).join('\n') + '\n', 'utf8');
  } catch {
    /* ignore */
  }
}

/** 最近 n 条账目（新的在前） */
export async function readAudit(n = 10) {
  try {
    const raw = await readFile(AUDIT_FILE, 'utf8');
    const lines = raw.split('\n').filter(Boolean).slice(-Math.max(1, n));
    return lines
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .reverse();
  } catch {
    return [];
  }
}

/** 快照列表（新的在前） */
export async function listSnapshots(n = 10) {
  try {
    const names = (await readdir(SNAP_DIR)).filter((x) => x.startsWith('snap-') && x.endsWith('.json')).sort().reverse();
    const out = [];
    for (const name of names.slice(0, n)) {
      const file = join(SNAP_DIR, name);
      try {
        const shot = JSON.parse(await readFile(file, 'utf8'));
        out.push({
          id: shot.id,
          at: shot.at,
          reason: shot.reason,
          blocks: (shot.blocks ?? []).map((b) => `${b.label}:${b.value.length}`),
          file,
        });
      } catch {
        /* 坏文件跳过 */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** 回滚：把快照里所有块恢复成当时的值（只读块跳过） */
export async function rollback(cfg, idOrPrefix) {
  const key = String(idOrPrefix || '').trim();
  if (!key) return { ok: false, reason: 'no-id' };
  let names = [];
  try {
    names = (await readdir(SNAP_DIR)).filter((x) => x.startsWith('snap-') && x.endsWith('.json')).sort().reverse();
  } catch {
    return { ok: false, reason: 'no-snapshots' };
  }
  const name = names.find((n) => n.includes(key)) || names.find((n) => n.includes(key.replace(/^snap-/, '')));
  if (!name) return { ok: false, reason: 'not-found', id: key };

  const shot = JSON.parse(await readFile(join(SNAP_DIR, name), 'utf8'));
  const now = await listBlocks(cfg);
  if (!now) return { ok: false, reason: 'letta-unreachable' };

  const restored = [];
  for (const target of shot.blocks ?? []) {
    if (target.read_only) continue;
    const cur = now.find((b) => b.label === target.label);
    if (!cur || cur.value === target.value) continue;
    const r = await req(cfg, `/blocks/${encodeURIComponent(cur.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ value: target.value }),
    });
    restored.push({ label: target.label, ok: r.ok, from: cur.value.length, to: target.value.length });
  }
  // 回滚本身也是一次改动，记一笔
  try {
    await mkdir(dirname(AUDIT_FILE), { recursive: true });
    await appendFile(
      AUDIT_FILE,
      JSON.stringify({
        ts: new Date().toISOString(),
        kind: 'rollback',
        snapshot: shot.id,
        restored,
      }) + '\n',
      'utf8',
    );
  } catch {
    /* ignore */
  }
  return { ok: true, snapshot: shot.id, restored };
}

export const AUDIT_PATH = AUDIT_FILE;
export const SNAPSHOT_DIR = SNAP_DIR;
export const auditReady = () => existsSync(AUDIT_FILE);
