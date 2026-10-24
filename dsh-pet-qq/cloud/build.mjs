/**
 * 打包云端发行包：`node cloud/build.mjs` → 生成 `dist/`（自包含，可直接 scp 到服务器）。
 *
 * 组装规则：
 *  - 复用本机已验证的 qq-bridge.mjs / personas.json（传输层、指令、去重、白名单零改动）；
 *  - **lib/pet-api.mjs 用云端实现覆盖**——桥的 import 路径不变，行为从「调本机 DSH」变成「调云端大脑」；
 *  - data/ 带上人设（pet.json）与 27 张表情包（memes/*.png），服务器无需再下载任何东西；
 *  - 附 .env.example、systemd 单元、备份服务与部署说明。
 *
 * 只用 Node 内置模块，无需 npm install（服务器上也不需要装任何依赖）。
 */

import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url)); // <repo>/cloud
const ROOT = resolve(HERE, '..'); // <repo>
const DIST = join(ROOT, 'dist');
const DSH_PET_ASSETS = process.env.DSH_PET_ASSETS || 'C:\\Users\\黄志\\.dsh\\profiles\\desktop\\node_modules\\dsh-pet\\assets';

const log = (...a) => console.log('[build]', ...a);

/** 去掉 JSONC 的注释（字符串内的 // 与 /* 必须保留） */
function stripJsonc(src) {
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i++;
      continue;
    }
    out += c;
  }
  // 去掉对象/数组尾逗号
  return out.replace(/,(\s*[}\]])/g, '$1');
}

async function ensureData() {
  const dataDir = join(HERE, 'data');
  const memesDir = join(dataDir, 'memes');
  await mkdir(memesDir, { recursive: true });

  // 1) 表情包图片
  const srcMemes = join(DSH_PET_ASSETS, 'memes');
  if (existsSync(srcMemes)) {
    const pngs = (await readdir(srcMemes)).filter((f) => f.endsWith('.png'));
    let copied = 0;
    for (const f of pngs) {
      const dst = join(memesDir, f);
      if (!existsSync(dst)) {
        await cp(join(srcMemes, f), dst);
        copied++;
      }
    }
    log(`表情包：${pngs.length} 张，新拷 ${copied} 张 → ${memesDir}`);
  } else {
    log(`⚠ 找不到 dsh-pet 素材目录（${srcMemes}），沿用 cloud/data/memes 里已有的图`);
  }

  // 2) pet.json（人设 + 表情包描述表），已存在则不覆盖（保留用户改过的名字/人设）
  const petFile = join(dataDir, 'pet.json');
  const personas = JSON.parse(await readFile(join(ROOT, 'personas.json'), 'utf8'));
  if (existsSync(petFile)) {
    log('data/pet.json 已存在，保留（要重生成请先删掉它）');
    return;
  }
  let memes = {};
  const cfgFile = join(DSH_PET_ASSETS, 'config.jsonc');
  if (existsSync(cfgFile)) {
    try {
      memes = JSON.parse(stripJsonc(await readFile(cfgFile, 'utf8'))).memes ?? {};
    } catch (e) {
      log('⚠ 解析 dsh-pet config.jsonc 失败：' + e.message);
    }
  }
  const def = personas.personas.find((p) => p.id === personas.default) ?? personas.personas[0];
  const pet = {
    version: 1,
    default: def.id,
    active: def.id,
    pet: { id: 'main', name: def.name, prompt: def.prompt },
    chatMemoryRounds: 5,
    chatImageLimit: 10,
    memes,
  };
  await writeFile(petFile, JSON.stringify(pet, null, 2), 'utf8');
  log(`data/pet.json 生成：人格 ${def.id}（${def.name}），表情包描述 ${Object.keys(memes).length} 条`);
}

async function main() {
  await ensureData();

  await rm(DIST, { recursive: true, force: true });
  await mkdir(join(DIST, 'lib'), { recursive: true });

  // 桥与人格表（本机已验证的版本，原样复用）
  await cp(join(ROOT, 'qq-bridge.mjs'), join(DIST, 'qq-bridge.mjs'));
  await cp(join(ROOT, 'personas.json'), join(DIST, 'personas.json'));
  await cp(join(ROOT, 'bridge.config.json'), join(DIST, 'bridge.config.json'));

  // 云端 lib：pet-api 换成云实现，其余（下载器不需要）不打包
  await cp(join(HERE, 'lib', 'pet-api.mjs'), join(DIST, 'lib', 'pet-api.mjs'));
  for (const f of ['prompt.mjs', 'memes.mjs', 'store.mjs', 'llm.mjs', 'agency.mjs', 'commitments.mjs', 'proactive.mjs', 'scheduler.mjs', 'groups.mjs', 'group-chat.mjs', 'qzone.mjs', 'semantic.mjs', 'feeds.mjs', 'memory-manager.mjs', 'turn-server.mjs', 'version.mjs']) {
    await cp(join(HERE, 'lib', f), join(DIST, 'lib', f));
  }

  // 版本号（turn-server 的 /health 会读它）。仓库根的 VERSION 在 cloud/ 的上两级。
  const versionFile = [join(ROOT, '..', 'VERSION'), join(ROOT, 'VERSION')].find((p) => existsSync(p));
  if (versionFile) {
    await cp(versionFile, join(DIST, 'VERSION'));
    console.log(`[build] 版本号：${(await readFile(versionFile, 'utf8')).trim()}`);
  } else {
    console.warn('[build] 没找到 VERSION，/health 会显示 0.0.0');
  }

  // 数据
  await cp(join(HERE, 'data'), join(DIST, 'data'), { recursive: true });

  // 运行时脚本
  await cp(join(HERE, 'backup-server.mjs'), join(DIST, 'backup-server.mjs'));
  await cp(join(HERE, 'start-bot.mjs'), join(DIST, 'start-bot.mjs'));
  await cp(join(HERE, '.env.example'), join(DIST, '.env.example'));
  await cp(join(HERE, 'deploy.md'), join(DIST, 'deploy.md'));
  await cp(join(HERE, 'systemd'), join(DIST, 'systemd'), { recursive: true });

  // 本机跑自测会往 dist/logs 写 trace，绝不能带到线上（会覆盖线上决策记录）
  await rm(join(DIST, 'logs'), { recursive: true, force: true });

  const files = [];
  async function walk(dir, prefix = '') {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? prefix + '/' + e.name : e.name;
      if (e.isDirectory()) await walk(join(dir, e.name), rel);
      else files.push(rel);
    }
  }
  await walk(DIST);
  const totalBytes = (await Promise.all(files.map((f) => readFile(join(DIST, f)).then((b) => b.length)))).reduce(
    (a, b) => a + b,
    0,
  );
  log(`dist/ 就绪：${files.length} 个文件，${(totalBytes / 1024 / 1024).toFixed(1)} MB → ${DIST}`);
  log('部署：把 dist/ 整个拷到服务器，按 dist/deploy.md 走。');
}

main().catch((e) => {
  console.error('[build] 失败：', e);
  process.exit(1);
});
