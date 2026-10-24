#!/usr/bin/env node
/**
 * 用 isomorphic-git 做提交 / 打标签 / 推送 —— 这台机器没有 git 二进制。
 *
 * 用法（在仓库根目录执行）：
 *   node scripts/git-push.mjs init
 *   node scripts/git-push.mjs commit "feat(cloud): 加入用量账本"
 *   node scripts/git-push.mjs tag                 # 读 VERSION，打 vX.Y.Z
 *   node scripts/git-push.mjs push                # 推分支 + 所有标签
 *   node scripts/git-push.mjs release "chore: ..." # commit + tag + push 一条龙
 *
 * 需要的环境变量：
 *   GITHUB_REPO=https://github.com/<user>/<repo>.git
 *   GITHUB_TOKEN=<有 repo 权限的 PAT>
 *   GIT_AUTHOR_NAME / GIT_AUTHOR_EMAIL（可选）
 */
import fs from 'node:fs';
import path from 'node:path';
import git from 'isomorphic-git';

const DIR = process.cwd();
const AUTHOR = {
  name: process.env.GIT_AUTHOR_NAME || 'dsh-pet',
  email: process.env.GIT_AUTHOR_EMAIL || 'dsh-pet@users.noreply.github.com',
};
const BRANCH = process.env.GIT_BRANCH || 'main';
const SKIP_DIRS = new Set(['.git', 'node_modules', '.tmp-memes-orig']);

const log = (...a) => console.log(...a);

function readVersion() {
  const p = path.join(DIR, 'VERSION');
  if (!fs.existsSync(p)) throw new Error('找不到 VERSION 文件');
  return fs.readFileSync(p, 'utf8').trim();
}

async function walk(rel = '') {
  const abs = path.join(DIR, rel);
  const out = [];
  for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
    const childRel = rel ? path.posix.join(rel, ent.name) : ent.name;
    if (SKIP_DIRS.has(ent.name)) continue;
    if (ent.isDirectory()) {
      out.push(...(await walk(childRel)));
    } else if (ent.isFile()) {
      out.push(childRel);
    }
  }
  return out;
}

async function ensureInit() {
  if (!fs.existsSync(path.join(DIR, '.git'))) {
    await git.init({ fs, dir: DIR, defaultBranch: BRANCH });
    log(`✓ git init（默认分支 ${BRANCH}）`);
  }
}

async function stageAll() {
  const prefixes = (process.env.STAGE_PREFIXES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const files = (await walk()).filter(
    (f) => prefixes.length === 0 || prefixes.some((p) => f === p || f.startsWith(p.endsWith('/') ? p : p + '/')),
  );
  let staged = 0;
  let ignored = 0;
  for (const filepath of files) {
    if (await git.isIgnored({ fs, dir: DIR, filepath })) {
      ignored++;
      continue;
    }
    await git.add({ fs, dir: DIR, filepath });
    staged++;
  }
  log(`✓ 暂存 ${staged} 个文件（按 .gitignore 跳过 ${ignored} 个）`);
  return staged;
}

async function doCommit(message) {
  if (!message) throw new Error('commit 需要提交信息');
  await stageAll();
  const status = await git.statusMatrix({ fs, dir: DIR });
  const changed = status.filter(([, head, workdir, stage]) => !(head === 1 && workdir === 1 && stage === 1));
  if (changed.length === 0) {
    log('= 没有变更，跳过提交');
    return null;
  }
  const oid = await git.commit({ fs, dir: DIR, message, author: AUTHOR });
  log(`✓ commit ${oid.slice(0, 8)} — ${message.split('\n')[0]}`);
  return oid;
}

async function doTag() {
  const version = readVersion();
  const ref = `v${version}`;
  const logEntries = await git.log({ fs, dir: DIR, depth: 1 });
  if (!logEntries.length) throw new Error('还没有任何提交，无法打标签');
  const oid = logEntries[0].oid;
  const existing = await git.listTags({ fs, dir: DIR }).catch(() => []);
  if (existing.includes(ref)) {
    log(`= 标签 ${ref} 已存在，跳过`);
    return ref;
  }
  await git.tag({ fs, dir: DIR, ref, object: oid, message: `release ${ref}` });
  log(`✓ tag ${ref} → ${oid.slice(0, 8)}`);
  return ref;
}

async function doPush() {
  const url = process.env.GITHUB_REPO;
  const token = process.env.GITHUB_TOKEN;
  if (!url || !token) throw new Error('需要 GITHUB_REPO 与 GITHUB_TOKEN');
  const remote = 'origin';
  const remotes = await git.listRemotes({ fs, dir: DIR });
  if (remotes.some((r) => r.remote === remote)) {
    await git.deleteRemote({ fs, dir: DIR, remote });
  }
  await git.addRemote({ fs, dir: DIR, remote, url });
  const onAuth = () => ({ username: 'x-access-token', password: token });
  await git.push({ fs, dir: DIR, remote, ref: BRANCH, onAuth, force: false });
  log(`✓ push ${BRANCH}`);
  const tags = await git.listTags({ fs, dir: DIR });
  for (const tag of tags) {
    await git.push({
      fs,
      dir: DIR,
      remote,
      ref: `refs/tags/${tag}`,
      remoteRef: `refs/tags/${tag}`,
      onAuth,
    });
    log(`✓ push tag ${tag}`);
  }
  const head = await git.resolveRef({ fs, dir: DIR, ref: BRANCH });
  log(`\n完成：${url.replace(/\.git$/, '')}/tree/${BRANCH} @ ${head.slice(0, 8)}`);
}

const [cmd, ...rest] = process.argv.slice(2);
const fail = (e) => {
  console.error('✗', e.message || e);
  process.exit(1);
};

try {
  await ensureInit();
  switch (cmd) {
    case 'init':
      await stageAll();
      break;
    case 'commit':
      await doCommit(rest.join(' '));
      break;
    case 'tag':
      await doTag();
      break;
    case 'push':
      await doPush();
      break;
    case 'release':
      await doCommit(rest.join(' ') || `chore: release v${readVersion()}`);
      await doTag();
      await doPush();
      break;
    case 'status': {
      const status = await git.statusMatrix({ fs, dir: DIR });
      const rows = status.filter(([, h, w, s]) => !(h === 1 && w === 1 && s === 1));
      if (!rows.length) log('= 工作区干净');
      for (const [f, h, w, s] of rows) log(`${h === 0 ? 'A' : w === 0 ? 'D' : 'M'} ${f}`);
      break;
    }
    default:
      log('用法: init | status | commit "<msg>" | tag | push | release "<msg>"');
  }
} catch (e) {
  fail(e);
}
