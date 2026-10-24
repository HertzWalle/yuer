#!/usr/bin/env node
// pet-gateway —— 把本机 dsh-pet 的 HTTP 接口安全地暴露给隧道（cloudflared / frp / tailscale）。
//
// 为什么需要它：DSH web 绑在 127.0.0.1:2627，直接拿隧道打洞等于把整个 DSH 面板（能跑命令）暴露到公网。
// 这个网关只放行 /dsh-pet-7340/* 这一段，并且要求 token，其它一律 404/401。
//
// 用法：
//   $env:PET_GATEWAY_TOKEN = "随便一串长随机串"
//   node pet-gateway.mjs            # 监听 0.0.0.0:2628
//   node pet-gateway.mjs --port 2628 --token xxx
//
// 云端桥那边：
//   $env:DSH_PET_BASE = "https://你的隧道域名"
//   $env:DSH_PET_TOKEN = "同一串 token"
//   node qq-bridge.mjs
//
// 健康检查（不需要 token）：GET /health -> {"ok":true}

import http from 'node:http';
import { randomBytes } from 'node:crypto';

function argOf(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

const PORT = Number(argOf('port', process.env.PET_GATEWAY_PORT || 2628));
const HOST = argOf('host', process.env.PET_GATEWAY_HOST || '0.0.0.0');
const UPSTREAM = argOf('upstream', process.env.PET_GATEWAY_UPSTREAM || 'http://127.0.0.1:2627');
const PREFIX = argOf('prefix', process.env.PET_GATEWAY_PREFIX || '/dsh-pet-7340');
const TOKEN = argOf('token', process.env.PET_GATEWAY_TOKEN || '');

if (!TOKEN) {
  console.error('[gateway] 没有 token。请设 PET_GATEWAY_TOKEN，或用 --token 传入。');
  console.error('[gateway] 下面这串可以直接用：' + randomBytes(24).toString('base64url'));
  process.exit(1);
}

function log(...a) {
  console.log(new Date().toISOString(), '[gateway]', ...a);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = decodeURIComponent(url.pathname);

  if (path === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ts: Date.now() }));
    return;
  }

  if (!path.startsWith(PREFIX)) {
    log('deny', req.method, path, 'path-not-allowed');
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, reason: 'not-found' }));
    return;
  }

  const got = req.headers['x-pet-token'] || url.searchParams.get('token') || '';
  if (got !== TOKEN) {
    log('deny', req.method, path, 'bad-token', req.headers['cf-connecting-ip'] || req.socket.remoteAddress);
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, reason: 'unauthorized' }));
    return;
  }

  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;

  const headers = { ...req.headers };
  delete headers['x-pet-token'];
  delete headers.host;
  delete headers['content-length'];
  delete headers['cf-connecting-ip'];
  delete headers['cf-ray'];
  headers['x-forwarded-host'] = req.headers.host || '';

  try {
    const up = await fetch(UPSTREAM + path + url.search, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
    });
    const buf = Buffer.from(await up.arrayBuffer());
    const out = {};
    up.headers.forEach((v, k) => {
      if (['content-encoding', 'transfer-encoding', 'connection', 'content-length'].includes(k)) return;
      out[k] = v;
    });
    out['content-length'] = String(buf.length);
    log('ok', req.method, path, up.status, buf.length + 'B');
    res.writeHead(up.status, out);
    res.end(buf);
  } catch (e) {
    log('error', req.method, path, e.message);
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, reason: 'upstream-error', message: e.message }));
  }
});

server.listen(PORT, HOST, () => {
  log(`listening on ${HOST}:${PORT} -> ${UPSTREAM}${PREFIX}/* (token ${TOKEN ? 'set' : 'MISSING'})`);
});
