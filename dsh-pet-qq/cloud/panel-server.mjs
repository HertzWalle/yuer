/**
 * 面板后端：给她一个网页控制台。
 *
 * 三种能力：
 *  - **看**：冲动/心情/承诺/群档位/上下文预算/最近决策/用量，全是现成的 JSON 读出来；
 *  - **改**：只放白名单里的十几项数字与开关（`lib/config.mjs` 校验），改完**原地深合并**进
 *    桥和调度器手里的 `conf`，下一句就生效，不重启；
 *  - **编辑**：人格 prompt、自我模型、忘掉某条记忆。
 *
 * 安全：只绑 127.0.0.1 + 一个 token（`PANEL_TOKEN`）；不返回 `.env` 里任何密钥。
 * 结构照搬 `backup-server.mjs` / `turn-server.mjs`：node:http，无框架、无依赖。
 */

import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile, stat, readdir } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { deepMerge, project, readJsonFile, validatePatch, writeJsonAtomic, BRIDGE_RULES, PET_RULES } from './lib/config.mjs';
import { PATHS, loadMemory, loadPet, savePet, readJson } from './lib/store.mjs';
import { loadAgency } from './lib/agency.mjs';
import { loadCommitments } from './lib/commitments.mjs';
import { loadGroups, groupState, quotaOf, tierOf } from './lib/groups.mjs';
import { estimateTokens, loadSelf, selfBrief, SUMMARY_DIR } from './lib/memory-manager.mjs';
import { recentNotes } from './lib/semantic.mjs';
import { usageSummary } from './lib/usage.mjs';
import { applyPersona, invalidatePersonas, resolvePersona, recentMessages } from './lib/pet-api.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_DIR = join(HERE, 'panel');
// 打包后在 dist 根（personas.json 就在旁边）；在 cloud/ 里调试时它在上两级
const PERSONAS_PATH = [join(HERE, 'personas.json'), join(HERE, '..', 'personas.json')].find((p) => existsSync(p)) || join(HERE, 'personas.json');
// dist 布局下日志就在 dist/logs（build 时复制里没有 logs），cloud/ 调试时在仓库根的 logs/
const LOGS_DIR = [join(HERE, 'logs'), join(HERE, '..', 'logs')].find((p) => existsSync(p)) || join(HERE, 'logs');
const TRACE = join(LOGS_DIR, 'trace.jsonl');
const BRIDGE_LOG = join(LOGS_DIR, 'bridge.log');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

const json = (res, code, body) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(s);
};

const readBody = (req, limit = 1 << 20) =>
  new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) {
        reject(new Error('请求体太大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });

/* ------------------------------- 数据汇总 ------------------------------- */

const TOKEN_LIMIT = Number(process.env.MODEL_CONTEXT || 64000);
const CHARS_PER_TOKEN = 1.5; // 中文大约 1 token ≈ 1.5 字，够粗糙但够用

async function overview(ctx) {
  const [pet, agency, cm, groups, self, usage, notes] = await Promise.all([
    loadPet(),
    loadAgency(),
    loadCommitments(),
    loadGroups(),
    loadSelf(),
    usageSummary({ days: 7 }).catch(() => null),
    recentNotes(6).catch(() => []),
  ]);

  const p = ctx.confs[0]?.proactive || {};
  const quiet = p.quietHours || ['23:30', '07:30'];
  const persona = await resolvePersona('private', 'main').catch(() => ({ name: '?', prompt: '' }));
  const history = await recentMessages('main', 10, { surface: 'private' }).catch(() => ({ messages: [] }));
  const msgs = Array.isArray(history) ? history : history.messages || [];

  const parts = [
    { key: 'system', label: '人设与规则', chars: String(persona.prompt || '').length },
    { key: 'history', label: '最近对话', chars: msgs.reduce((n, m) => n + String(m.content || '').length, 0) },
    { key: 'memory', label: '摘要与自我', chars: (self?.text || '').length + (await selfBriefLength()) },
    { key: 'notes', label: '语义记忆', chars: (notes || []).reduce((n, x) => n + String(x.text || '').length, 0) },
  ];
  const usedChars = parts.reduce((n, x) => n + x.chars, 0);
  const budget = parts.map((x) => ({ ...x, tokens: Math.round(x.chars / CHARS_PER_TOKEN) }));

  const groupRows = Object.entries(groups || {})
    .filter(([k]) => k.startsWith('group:'))
    .map(([conv, g]) => ({
      conv,
      tier: tierOf(g),
      quota: quotaOf(g),
      annoyance: Math.round(Number(g.annoyance || 0)),
      lastSpoke: g.lastSpoke || null,
    }));

  return {
    ok: true,
    version: ctx.version,
    now: new Date().toISOString(),
    pet: { id: pet.pet?.id || 'main', name: pet.pet?.name || '?', active: pet.active, surfaces: pet.surfaces || {} },
    agency: {
      impulse: Math.round(Number(agency.impulse?.owner || 0)),
      cap: 120,
      threshold: p.impulseThreshold,
      mood: agency.mood,
      moodWord: agency.moodWord || null,
      lastSpoke: agency.lastSpoke?.owner || null,
      todayCount: agency.counters?.ownerSent ?? 0,
      dailyLimit: p.dailyLimit,
      pausedUntil: agency.pausedUntil || null,
      rules: agency.rules || [],
    },
    quiet,
    commitments: (cm?.items || []).filter((x) => x.status === 'pending'),
    groups: groupRows,
    memory: {
      buckets: await bucketStats(),
      self: { text: self?.text || '', updatedAt: self?.updatedAt || null },
      notes: (notes || []).slice(0, 6).map((n) => ({ kind: n.kind, text: n.text, at: n.at })),
    },
    usage,
    budget: {
      limit: TOKEN_LIMIT,
      usedTokens: Math.round(usedChars / CHARS_PER_TOKEN),
      parts: budget,
    },
  };
}

async function selfBriefLength() {
  try {
    const s = await selfBrief();
    return String(s || '').length;
  } catch {
    return 0;
  }
}

async function bucketStats() {
  const mem = await loadMemory();
  const out = [];
  for (const [entry, pets] of Object.entries(mem || {})) {
    for (const [petId, box] of Object.entries(pets || {})) {
      const msgs = Array.isArray(box?.messages) ? box.messages : [];
      out.push({
        bucket: `${entry}.${petId}`,
        count: msgs.length,
        lastAt: msgs.length ? msgs[msgs.length - 1].ts || null : null,
      });
    }
  }
  return out.sort((a, b) => b.count - a.count);
}

/* --------------------------------- 路由 --------------------------------- */

async function applyConfig(ctx, target, flat) {
  const isPet = target === 'pet';
  const rules = isPet ? PET_RULES : BRIDGE_RULES;
  const { ok, patch, errors } = validatePatch(flat, rules);
  if (!ok) return { ok: false, errors };

  if (isPet) {
    const pet = await loadPet();
    deepMerge(pet, patch);
    await savePet(pet);
    return { ok: true, applied: Object.keys(flat) };
  }

  // 桥：先写真实配置文件，再合并进两个内存对象（桥一个、调度器一个）
  const file = ctx.configPath;
  const disk = (await readJsonFile(file, {})) || {};
  deepMerge(disk, patch);
  await writeJsonAtomic(file, disk);
  for (const c of ctx.confs) deepMerge(c, patch);
  return { ok: true, applied: Object.keys(flat) };
}

async function personasView(ctx) {
  const list = (await readJsonFile(PERSONAS_PATH, { personas: [] })) || {};
  const pet = await loadPet();
  const s = pet.surfaces || {};
  return {
    ok: true,
    default: list.default || null,
    surfaces: { private: s.private || null, group: s.group || null, groups: s.groups || {} },
    personas: (list.personas || []).map((x) => ({
      id: x.id,
      label: x.label,
      name: x.name,
      tagline: x.tagline,
      chars: String(x.prompt || '').length,
      prompt: x.prompt,
    })),
  };
}

async function usePersonById(ctx, { personaId, surface = 'private', groupId = '' }) {
  const list = (await readJsonFile(PERSONAS_PATH, { personas: [] })) || {};
  const target = (list.personas || []).find((x) => x.id === personaId);
  if (!target) return { ok: false, error: '没有这个人格' };
  const conv = surface === 'group' && groupId ? `group:${groupId}` : '';
  await applyPersona(target, { petId: 'main', surface, conv });
  return { ok: true, applied: target.id };
}

async function updatePersonaPrompt(ctx, id, prompt) {
  const file = PERSONAS_PATH;
  const list = (await readJsonFile(file, { personas: [] })) || {};
  const one = (list.personas || []).find((x) => x.id === id);
  if (!one) return { ok: false, error: '没有这个人格' };
  const text = String(prompt || '').trim();
  if (text.length < 50) return { ok: false, error: '太短了，至少 50 字' };
  if (text.length > 4000) return { ok: false, error: '太长了，最多 4000 字' };
  one.prompt = text;
  await writeJsonAtomic(file, list);
  invalidatePersonas();
  return { ok: true, chars: text.length };
}

async function memoryView(bucket) {
  const mem = await loadMemory();
  const [entry, petId] = String(bucket || 'main.main').split('.');
  const msgs = mem?.[entry]?.[petId]?.messages || [];
  const summary = await readJson(join(SUMMARY_DIR, `${entry}.${petId}.json`), null).catch(() => null);
  return { ok: true, bucket, count: msgs.length, messages: msgs.slice(-80), summary };
}

async function forgetMessage(bucket, index) {
  const mem = await loadMemory();
  const [entry, petId] = String(bucket || '').split('.');
  const box = mem?.[entry]?.[petId];
  if (!box || !Array.isArray(box.messages)) return { ok: false, error: '没有这个桶' };
  const i = box.messages.length - 1 - Number(index);
  if (!box.messages[i]) return { ok: false, error: '没有这一条' };
  const [gone] = box.messages.splice(i, 1);
  await writeJsonAtomic(PATHS.memory, mem);
  return { ok: true, removed: String(gone?.content || '').slice(0, 80) };
}

async function saveSelf(text) {
  const t = String(text || '').trim();
  if (!t) return { ok: false, error: '不能为空' };
  if (t.length > 220) return { ok: false, error: '自我模型最多 220 字' };
  const { updateSelf } = await import('./lib/memory-manager.mjs');
  await updateSelf({ text: t, force: true });
  return { ok: true, chars: t.length };
}

/* ------------------------------- 静态文件 ------------------------------- */

async function serveStatic(res, urlPath) {
  const raw = decodeURIComponent(urlPath.split('?')[0]);
  let clean = normalize(raw).replace(/^(\.\.[/\\])+/, '');
  // Windows 上 normalize('/') 会变成 '\'，直接 join 会指到目录本身 → 404
  if (!clean || clean === '/' || clean === '\\' || clean === '.') clean = 'index.html';
  else clean = clean.replace(/^[/\\]+/, '');
  const file = join(PANEL_DIR, clean);
  if (!file.startsWith(PANEL_DIR)) return json(res, 403, { ok: false, error: '越界' });
  try {
    const buf = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(buf);
  } catch {
    // 没有前端产物时给个能看懂的提示，而不是 404 空白页
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<h1>面板前端还没构建</h1><p>跑 <code>node panel/build.mjs</code>，或直接调 <code>/api/overview</code>。</p>');
  }
}

/* --------------------------------- SSE ---------------------------------- */

async function tailStream(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.write(': connected\n\n');

  const offsets = new Map();
  const sizeOf = async (f) => {
    try {
      return (await stat(f)).size;
    } catch {
      return 0;
    }
  };
  // 先把两个文件最后几行补上，否则刚打开日志页会一片空白（要等下一次决策才有输出）
  const headLines = 40;
  for (const file of [TRACE, BRIDGE_LOG]) {
    try {
      const buf = await readFile(file);
      const tail = buf.toString('utf8').split('\n').filter((x) => x.trim()).slice(-headLines);
      for (const line of tail) {
        res.write(`data: ${JSON.stringify({ src: file === TRACE ? 'trace' : 'log', line })}\n\n`);
      }
    } catch {
      /* 文件还没有就算了 */
    }
  }
  offsets.set(TRACE, await sizeOf(TRACE));
  offsets.set(BRIDGE_LOG, await sizeOf(BRIDGE_LOG));

  const timer = setInterval(async () => {
    for (const [file, prev] of offsets) {
      const size = await sizeOf(file);
      if (size <= prev) {
        offsets.set(file, size);
        continue;
      }
      try {
        const buf = await readFile(file);
        const chunk = buf.subarray(prev, size).toString('utf8');
        offsets.set(file, size);
        for (const line of chunk.split('\n')) {
          if (!line.trim()) continue;
          res.write(`data: ${JSON.stringify({ src: file === TRACE ? 'trace' : 'log', line })}\n\n`);
        }
      } catch {
        offsets.set(file, size);
      }
    }
  }, 1000);

  req.on('close', () => clearInterval(timer));
}

/* --------------------------------- 启动 --------------------------------- */

export async function createPanelServer({
  host = '127.0.0.1',
  port = 3040,
  token = '',
  configPath,
  confs = [],
  version = '0.0.0',
  log = console,
} = {}) {
  if (!token) throw new Error('缺 PANEL_TOKEN，拒绝启动（面板能改她的行为，不能裸奔）');
  const ctx = { configPath, confs, version };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = url.pathname;

    // 鉴权：头 / 查询参数 / cookie 三选一；带上 cookie 就不用每次敲 token
    const given =
      req.headers['x-panel-token'] ||
      url.searchParams.get('token') ||
      (req.headers.cookie || '').match(/(?:^|;\s*)panel_token=([^;]+)/)?.[1] ||
      '';
    const authed = decodeURIComponent(given) === token;

    if (!authed) {
      if (path === '/' && url.searchParams.get('token')) {
        res.writeHead(302, {
          location: '/',
          'set-cookie': `panel_token=${encodeURIComponent(url.searchParams.get('token'))}; Path=/; HttpOnly; SameSite=Strict`,
        });
        return res.end();
      }
      // 页面本身不含数据，允许先加载（前端 401 时会问你要 token）；只有 /api/* 必须鉴权，
      // 免得「打不开页面、又不知道去哪儿填 token」。
      if (path !== '/' && !path.startsWith('/api/')) {
        return serveStatic(res, path).catch(() => json(res, 404, { ok: false, error: 'not found' }));
      }
      if (path !== '/') return json(res, 401, { ok: false, error: 'unauthorized' });
    }

    try {
      if (path === '/api/events') return await tailStream(req, res);

      if (path === '/api/overview') return json(res, 200, await overview(ctx));

      if (path === '/api/config' && req.method === 'GET') {
        const bridge = (await readJsonFile(configPath, {})) || {};
        const pet = await loadPet();
        return json(res, 200, {
          ok: true,
          pet: project(pet, PET_RULES),
          bridge: project(bridge, BRIDGE_RULES),
          rules: { pet: PET_RULES, bridge: BRIDGE_RULES },
        });
      }

      if (path === '/api/config' && req.method === 'POST') {
        const body = await readBody(req);
        const out = await applyConfig(ctx, body.target === 'pet' ? 'pet' : 'bridge', body.patch || {});
        return json(res, out.ok ? 200 : 400, out);
      }

      if (path === '/api/personas' && req.method === 'GET') return json(res, 200, await personasView(ctx));

      if (path === '/api/personas/use' && req.method === 'POST') {
        const body = await readBody(req);
        const out = await usePersonById(ctx, body);
        return json(res, out.ok ? 200 : 400, out);
      }

      if (path.startsWith('/api/personas/') && req.method === 'PUT') {
        const id = decodeURIComponent(path.slice('/api/personas/'.length));
        const body = await readBody(req);
        const out = await updatePersonaPrompt(ctx, id, body.prompt);
        return json(res, out.ok ? 200 : 400, out);
      }

      if (path === '/api/memory' && req.method === 'GET') {
        return json(res, 200, await memoryView(url.searchParams.get('bucket') || 'main.main'));
      }

      if (path === '/api/memory/forget' && req.method === 'POST') {
        const body = await readBody(req);
        const out = await forgetMessage(body.bucket, body.index);
        return json(res, out.ok ? 200 : 400, out);
      }

      if (path === '/api/self' && req.method === 'POST') {
        const body = await readBody(req);
        const out = await saveSelf(body.text);
        return json(res, out.ok ? 200 : 400, out);
      }

      return await serveStatic(res, path);
    } catch (e) {
      log.error?.(`[panel] ${req.method} ${path} 出错：${e?.message ?? e}`);
      return json(res, 500, { ok: false, error: e?.message ?? String(e) });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  log.info?.(`[panel] 控制台已启动 http://${host}:${port}（token 鉴权，只绑本机）`);
  return { server, host, port, close: () => server.close() };
}

/* 直接 `node panel-server.mjs` 时也能跑（本机调试用） */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const token = (process.env.PANEL_TOKEN || '').trim();
  const confPath =
    process.env.PANEL_CONFIG ||
    [join(HERE, 'bridge.config.json'), join(HERE, '..', 'bridge.config.json')].find((p) => existsSync(p)) ||
    join(HERE, 'bridge.config.json');
  const conf = (await readJsonFile(confPath, {})) || {};
  await createPanelServer({
    host: (process.env.PANEL_HOST || '127.0.0.1').trim(),
    port: Number(process.env.PANEL_PORT || 3040),
    token,
    configPath: confPath,
    confs: [conf],
    version: (await readJsonFile(join(HERE, 'VERSION'), null)) || 'dev',
    log: {
      info: (m) => console.log(m),
      error: (m) => console.error(m),
    },
  });
}
