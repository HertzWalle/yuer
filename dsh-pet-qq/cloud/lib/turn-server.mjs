/**
 * S4：把「大脑」暴露成一个和接入层无关的 HTTP 契约。
 *
 * 目的：QQ 的传输细节（OneBot 事件、分气泡、引用、表情包、群旁听）留在 qq-bridge.mjs；
 * 任何别的接入层（AstrBot / LangBot / 以后别的平台）只要对着本机的
 * `POST /turn` 发一句话，就能拿到「按人设生成的若干条气泡 + 可选表情包名称」。
 *
 * 约定（见 docs/TURN.md）：
 *   POST /turn        { conv, user:{id,name}, text }  → { ok, segments, text, image, persona }
 *   GET  /health                                      → { ok, app, version, uptimeMs }
 * 鉴权：`x-turn-token` 头（或 `?token=`），TURN_TOKEN 未设置时只允许回环。
 *
 * 注意：这里只做「一轮对话」。主动性（scheduler）、承诺、空间、群旁听仍然跑在
 * qq-bridge.mjs 那套里，因为它们和「什么时候开口」的传输/时间语义绑在一起。
 */

import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

import { chat, resolvePersona } from './pet-api.mjs';
import { loadPet } from './store.mjs';
import { VERSION } from './version.mjs';

const MAX_BODY = 64 * 1024;

function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body-too-large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 从 conv 猜场景：`group:123` / `private:456`；猜不出按私聊 */
export function surfaceOfConv(conv) {
  return String(conv ?? '').startsWith('group:') ? 'group' : 'private';
}

/**
 * 一轮对话的纯函数入口（也方便测试直接调，不用起 HTTP）。
 * @returns {Promise<{ok:boolean, status?:number, reason?:string, segments?:string[], text?:string, image?:string, persona?:{id:string,name:string}}>}
 */
export async function runTurn({ conv, user = {}, text } = {}) {
  const input = String(text ?? '').trim();
  if (!input) return { ok: false, status: 400, reason: 'empty-text' };
  const c = String(conv ?? '').trim() || `private:${user?.id ?? 'unknown'}`;
  const surface = surfaceOfConv(c);
  const name = String(user?.name ?? '').trim();
  const body =
    surface === 'group' && name ? `【${name}】${input}` : surface === 'group' ? input : input;

  const before = await loadPet();
  const petId = before?.pet?.id || 'main';
  const persona = await resolvePersona(surface, petId, c).catch(() => null);

  const res = await chat(body.slice(0, 2000), { petId, surface, conv: c });
  if (!res?.ok) return { ok: false, status: 502, reason: res?.reason ?? 'generate-error' };

  return {
    ok: true,
    conv: c,
    surface,
    text: res.text,
    segments: Array.isArray(res.segments) && res.segments.length ? res.segments : [res.text],
    image: res.image ?? null,
    persona: persona ? { id: persona.id, name: persona.name } : null,
  };
}

/**
 * 起 HTTP 服务。默认只听 127.0.0.1:3030（要跨机请走 Tailscale/SSH 隧道，
 * 别把它暴露到公网——这台机器上的 DSH 面板能执行命令）。
 */
export function createTurnServer({ host = '127.0.0.1', port = 3030, token = '', log = console } = {}) {
  const startedAt = Date.now();
  const requireToken = Boolean(token);

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const path = url.pathname.replace(/\/+$/, '') || '/';

      if (req.method === 'GET' && path === '/health') {
        return send(res, 200, { ok: true, app: 'yuer-turn', version: VERSION, uptimeMs: Date.now() - startedAt });
      }

      if (!requireToken) {
        return send(res, 503, { ok: false, error: 'turn-token-not-configured' });
      }
      const given = req.headers['x-turn-token'] ?? url.searchParams.get('token') ?? '';
      if (!safeEqual(given, token)) return send(res, 401, { ok: false, error: 'unauthorized' });

      if (req.method === 'POST' && path === '/turn') {
        let payload;
        try {
          payload = JSON.parse(await readBody(req));
        } catch (e) {
          const tooLarge = String(e?.message ?? '').includes('too-large');
          return send(res, tooLarge ? 413 : 400, { ok: false, error: tooLarge ? 'body-too-large' : 'bad-json' });
        }
        const out = await runTurn(payload ?? {});
        if (!out.ok) return send(res, out.status ?? 500, out);
        log.info?.(`[turn] ${out.surface} ${out.conv} → ${out.segments.length} 段`);
        return send(res, 200, out);
      }

      if (req.method === 'GET' && path === '/personas') {
        const conf = await loadPet();
        return send(res, 200, { ok: true, active: conf.active ?? null, surfaces: conf.surfaces ?? {} });
      }

      return send(res, 404, { ok: false, error: 'not-found' });
    } catch (e) {
      log.error?.(`[turn] ${e?.message ?? e}`);
      return send(res, 500, { ok: false, error: 'internal', message: String(e?.message ?? e) });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      resolve({ server, host, port: actualPort, close: () => new Promise((r) => server.close(r)) });
    });
  });
}
