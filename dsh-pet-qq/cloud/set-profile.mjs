/**
 * 通过 OneBot 正向 WS 改机器人资料：昵称 + 头像。
 *
 *   node set-profile.mjs --avatar /tmp/avatar.png --nick "dsh大肥鱼·小蓝"
 *   node set-profile.mjs --nick "..."            # 只改昵称
 *   node set-profile.mjs --avatar /tmp/a.png     # 只改头像
 *
 * 环境变量：ONEBOT_WS（默认 ws://127.0.0.1:3001）、ONEBOT_TOKEN。
 */
import { readFile } from 'node:fs/promises';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--avatar') out.avatar = argv[++i];
    else if (a === '--nick') out.nick = argv[++i];
    else if (a === '--ws') out.ws = argv[++i];
    else if (a === '--uin') out.uin = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const wsUrl = args.ws || process.env.ONEBOT_WS || 'ws://127.0.0.1:3001';
const token = process.env.ONEBOT_TOKEN || '';

if (!args.nick && !args.avatar) {
  console.error('用法：node set-profile.mjs --nick "新昵称" [--avatar /path/to.png]');
  process.exit(2);
}

const url = token ? `${wsUrl}?access_token=${encodeURIComponent(token)}` : wsUrl;
const ws = new WebSocket(url);
let seq = 0;
const pending = new Map();

function call(action, params = {}, timeoutMs = 30000) {
  const echo = `c${++seq}`;
  ws.send(JSON.stringify({ action, params, echo }));
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { pending.delete(echo); reject(new Error(`${action} 超时`)); }, timeoutMs);
    pending.set(echo, { resolve, reject, t });
  });
}

ws.addEventListener('message', (ev) => {
  let msg;
  try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch { return; }
  if (!msg.echo) return;
  const p = pending.get(msg.echo);
  if (!p) return;
  pending.delete(msg.echo);
  clearTimeout(p.t);
  if (msg.status === 'ok' || msg.retcode === 0) p.resolve(msg.data);
  else p.reject(new Error(`${msg.status || 'failed'} retcode=${msg.retcode} ${msg.message || msg.wording || ''}`.trim()));
});

ws.addEventListener('error', () => {
  console.error('WS 连接失败：' + url);
  process.exit(1);
});

ws.addEventListener('open', async () => {
  try {
    const me = await call('get_login_info');
    console.log(`当前：${me.nickname} (${me.user_id})`);

    if (args.nick) {
      await call('set_qq_profile', { nickname: args.nick });
      console.log(`昵称已改为：${args.nick}`);
    }
    if (args.avatar) {
      const buf = await readFile(args.avatar);
      const b64 = 'base64://' + buf.toString('base64');
      console.log(`上传头像 ${(buf.length / 1024).toFixed(0)} KB ...`);
      await call('set_qq_avatar', { file: b64 }, 60000);
      console.log('头像已更新');
    }

    const after = await call('get_login_info');
    console.log(`现在：${after.nickname} (${after.user_id})`);
    ws.close();
    process.exit(0);
  } catch (e) {
    console.error('失败：' + (e?.message ?? e));
    ws.close();
    process.exit(1);
  }
});
