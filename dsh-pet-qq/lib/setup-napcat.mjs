/**
 * 给 NapCat Shell 写「正向 WebSocket」OneBot v11 配置，让 qq-bridge.mjs 能直接连。
 *
 *   node lib/setup-napcat.mjs --uin 123456789 [--root <NapCat.xxx.Shell 目录>] [--port 3001]
 *
 * 会在 NapCat 的 napcat/config/ 下写：
 *   - napcat.json       （保留原文件，缺字段才补）
 *   - webui.json        （缺 token 时生成一个）
 *   - onebot11_<uin>.json （WS 服务器监听 127.0.0.1:<port>，消息格式 array）
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const port = Number(opt('port', 3001));
let uin = opt('uin', '');
const here = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

async function findNapCatRoot() {
  const hint = opt('root', '');
  if (hint) return resolve(hint);
  const searchDirs = [join(here, '..', 'napcat'), join(here, '..')];
  const found = [];
  for (const base of searchDirs) {
    if (!existsSync(base)) continue;
    for (const name of await readdir(base)) {
      const dir = join(base, name);
      // 官方 zip 解出来是 NapCat.xxx.Shell/launcher.bat；解压到自定义目录时可能就叫 shell
      if (!existsSync(join(dir, 'launcher.bat'))) continue;
      if (name.startsWith('NapCat.') || name === 'shell') found.push(dir);
    }
  }
  if (!found.length) throw new Error('没找到 NapCat 目录（里面应有 launcher.bat），请用 --root 指定');
  found.sort();
  return found[found.length - 1];
}

const root = await findNapCatRoot();
// 两种布局都要认：<root>/config（官方 Shell zip）与 <root>/napcat/config（一键安装器）
const configDir = existsSync(join(root, 'config')) ? join(root, 'config') : join(root, 'napcat', 'config');
await mkdir(configDir, { recursive: true });

// 没给 --uin 时，看 NapCat 登录后自己生成的 onebot11_<uin>.json，捡现成的号
if (!uin) {
  const hit = (await readdir(configDir)).filter((n) => /^onebot11_\d+\.json$/i.test(n)).sort();
  if (hit.length) uin = hit[hit.length - 1].replace(/^onebot11_/i, '').replace(/\.json$/i, '');
}

async function patchJson(file, patch) {
  let cur = {};
  if (existsSync(file)) {
    try {
      cur = JSON.parse(await readFile(file, 'utf8'));
    } catch {
      cur = {};
    }
  }
  const next = { ...cur, ...patch };
  await writeFile(file, JSON.stringify(next, null, 2), 'utf8');
  return { file, added: Object.keys(patch).filter((k) => !(k in cur)) };
}

const napcatJson = await patchJson(join(configDir, 'napcat.json'), {
  fileLog: true,
  consoleLog: true,
  fileLogLevel: 'info',
  consoleLogLevel: 'info',
  autoStart: false,
  autoRestart: false,
  quickLoginQQ: uin || '',
});

let webuiToken = '';
const webuiFile = join(configDir, 'webui.json');
if (!existsSync(webuiFile)) {
  webuiToken = randomBytes(16).toString('hex');
  await writeFile(webuiFile, JSON.stringify({ token: webuiToken, loginRate: 3, host: '127.0.0.1', port: 6099 }, null, 2), 'utf8');
} else {
  try {
    webuiToken = JSON.parse(await readFile(webuiFile, 'utf8')).token ?? '';
  } catch {
    webuiToken = '';
  }
}

// 已有文件要保留其它键（timeout / imageDownloadProxy 等），只替换 websocketServers
const target = join(configDir, uin ? `onebot11_${uin}.json` : 'onebot11.json');
let cur = {};
if (existsSync(target)) {
  try {
    cur = JSON.parse(await readFile(target, 'utf8'));
  } catch {
    cur = {};
  }
}
const onebot = {
  ...cur,
  network: {
    httpServers: [],
    httpSseServers: [],
    httpClients: [],
    ...(cur.network || {}),
    websocketServers: [
      {
        name: 'dsh-pet-bridge',
        enable: true,
        host: '127.0.0.1',
        port,
        enableForcePushEvent: true,
        reportSelfMessage: false,
        messagePostFormat: 'array',
        token: '',
        debug: false,
        heartInterval: 30000,
      },
    ],
  },
};
await writeFile(target, JSON.stringify(onebot, null, 2), 'utf8');

const fingerprint = createHash('sha1').update(target).digest('hex').slice(0, 8);
console.log('NapCat 目录：' + root);
console.log('配置目录：' + configDir);
console.log('  - napcat.json ' + (napcatJson.added.length ? '(补了 ' + napcatJson.added.join(',') + ')' : '(已是最新)'));
console.log('  - webui.json  ' + (webuiToken ? 'token=' + webuiToken : '(沿用已有)'));
console.log('  - ' + target.split(/[\\/]/).pop() + '  正向 WS 127.0.0.1:' + port + '（messagePostFormat=array）');
console.log('指纹 ' + fingerprint + '（写入 onebot11 配置）');
