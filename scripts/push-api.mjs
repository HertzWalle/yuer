#!/usr/bin/env node
/**
 * 用 GitHub REST（Git Data API）提交并推送。
 *
 * 为什么需要它：本机没有 git，`scripts/git-push.mjs` 走的是 git smart HTTP（github.com），
 * 网络一旦抽风就是 `Request timed out`；而 `api.github.com` 通常还能通。这个脚本只依赖
 * api.github.com：比对「工作区文件」与「远端 HEAD 的树」，把差异做成一次提交推上去。
 *
 * 用法：
 *   $env:GITHUB_TOKEN = 'github_pat_...'
 *   $env:GITHUB_REPO  = 'https://github.com/<owner>/<repo>.git'
 *   node scripts/push-api.mjs ["提交说明"]
 *   加 --tag 会把 VERSION 打成 vX.Y.Z 标签；加 --dry 只打印差异。
 */
import { readFile, stat } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const TOKEN = process.env.GITHUB_TOKEN || '';
const REPO_URL = process.env.GITHUB_REPO || '';

if (!TOKEN) fail('缺少 GITHUB_TOKEN');
if (!REPO_URL) fail('缺少 GITHUB_REPO');

const m = REPO_URL.match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?\/?$/i);
if (!m) fail(`看不懂的仓库地址：${REPO_URL}`);
const [, OWNER, REPO] = m;

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const TAG = args.includes('--tag');
const MESSAGE = args.filter((a) => !a.startsWith('--')).join(' ') || 'chore: 同步工作区';

const API = `https://api.github.com/repos/${OWNER}/${REPO}`;

function fail(msg) {
  console.error('✗ ' + msg);
  process.exit(1);
}

async function api(path, init = {}, { soft = false } = {}) {
  const res = await fetch(path.startsWith('http') ? path : API + path, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${TOKEN}`,
      'user-agent': 'yuer-push-api',
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON（多半是错误页） */
  }
  if (!res.ok) {
    if (soft) return { __error: { status: res.status, message: json?.message ?? text.slice(0, 200) } };
    fail(`${init.method || 'GET'} ${path} → ${res.status} ${json?.message ?? text.slice(0, 200)}`);
  }
  return json;
}

/** 与 .gitignore 一致的忽略规则（不引第三方库，保持最小实现） */
const IGNORE_DIRS = [/^node_modules$/, /^\.git$/, /^\.npm-cache$/, /^dist$/, /^napcat$/, /^downloads$/, /^logs$/, /^backups$/, /^\.ssh$/, /^memes$/];
const IGNORE_FILES = [
  /^\.tmp-/,
  /\.pem$/,
  /\.tgz$/,
  /^memory\.json$/,
  /^memory\.json\.bak.*$/,
  /^state\.json$/,
  /^commitments\.json$/,
  /^usage\.jsonl$/,
  /^bot\.env$/,
  /^turn\.token$/,
];

const ignored = (relPath) => {
  const parts = relPath.split('/');
  if (parts.some((p) => IGNORE_DIRS.some((re) => re.test(p)))) return true;
  return IGNORE_FILES.some((re) => re.test(parts[parts.length - 1]));
};

/** 本地工作区里要提交的文件（相对路径用 / 分隔） */
function collect(dir = ROOT, out = [], rel = '') {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (ignored(relPath)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out, relPath);
    else if (entry.isFile()) out.push(relPath);
  }
  return out;
}

async function main() {
  const info = await api(''); // 仓库信息（顺便验证权限）
  const branch = info.default_branch || 'main';
  console.log(`仓库 ${OWNER}/${REPO} 分支 ${branch}`);

  const head = await api(`/git/ref/heads/${branch}`);
  const headSha = head.object.sha;
  const headCommit = await api(`/git/commits/${headSha}`);
  const baseTree = headCommit.tree.sha;
  console.log(`远端 HEAD ${headSha.slice(0, 8)}（${String(headCommit.message ?? '').split('\n')[0]}）`);

  const remoteTree = await api(`/git/trees/${baseTree}?recursive=1`);
  const remote = new Map();
  for (const node of remoteTree.tree) if (node.type === 'blob') remote.set(node.path, node.sha);

  const files = collect();
  const local = new Map();
  for (const f of files) local.set(f, await readFile(join(ROOT, f.split('/').join(sep))));

  // 远端 blob sha 与本地内容比对：先按「同名不同 sha」后按内容生成 sha 太麻烦，
  // 直接对每个本地文件算 git blob sha（sha1("blob <len>\0"+content)）
  const { createHash } = await import('node:crypto');
  const blobSha = (buf) => {
    const h = createHash('sha1');
    h.update(`blob ${buf.length}\0`);
    h.update(buf);
    return h.digest('hex');
  };

  const puts = [];
  for (const [path, buf] of local) {
    if (remote.get(path) !== blobSha(buf)) puts.push({ path, buf });
  }
  const deletes = [...remote.keys()].filter((p) => !local.has(p));

  if (!puts.length && !deletes.length) {
    console.log('✓ 远端已是最新，无需提交');
    if (TAG) await makeTag(headSha, baseTree);
    return;
  }
  console.log(`变更：新增/修改 ${puts.length}，删除 ${deletes.length}`);
  for (const p of puts.slice(0, 15)) console.log('  M ' + p.path);
  if (puts.length > 15) console.log(`  … 另有 ${puts.length - 15} 个`);
  for (const p of deletes.slice(0, 10)) console.log('  D ' + p);
  if (DRY) return;

  const entries = [];
  for (const { path, buf } of puts) {
    const blob = await api('/git/blobs', {
      method: 'POST',
      body: JSON.stringify({ content: buf.toString('base64'), encoding: 'base64' }),
    });
    entries.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  for (const path of deletes) entries.push({ path, mode: '100644', type: 'blob', sha: null });

  const tree = await api('/git/trees', {
    method: 'POST',
    body: JSON.stringify({ base_tree: baseTree, tree: entries }),
  });

  const name = process.env.GIT_AUTHOR_NAME || 'HudsonZephyr';
  const email = process.env.GIT_AUTHOR_EMAIL || '1360153202@qq.com';
  const now = new Date().toISOString();
  const commit = await api('/git/commits', {
    method: 'POST',
    body: JSON.stringify({
      message: MESSAGE,
      tree: tree.sha,
      parents: [headSha],
      author: { name, email, date: now },
      committer: { name, email, date: now },
    }),
  });

  await api(`/git/refs/heads/${branch}`, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha, force: false }) });
  console.log(`✓ commit ${commit.sha.slice(0, 8)} — ${MESSAGE}`);
  if (TAG) await makeTag(commit.sha, tree.sha);
  console.log(`完成：https://github.com/${OWNER}/${REPO}/tree/${branch} @ ${commit.sha.slice(0, 8)}`);
}

async function makeTag(commitSha, treeSha) {
  const version = (await readFile(join(ROOT, 'VERSION'), 'utf8')).trim();
  const ref = `refs/tags/v${version}`;
  const author = { name: process.env.GIT_AUTHOR_NAME || 'HudsonZephyr', email: process.env.GIT_AUTHOR_EMAIL || '1360153202@qq.com', date: new Date().toISOString() };
  const tag = await api('/git/tags', {
    method: 'POST',
    body: JSON.stringify({ tag: `v${version}`, message: `v${version}`, object: commitSha, type: 'commit', tagger: author }),
  });
  const created = await api('/git/refs', { method: 'POST', body: JSON.stringify({ ref, sha: tag.sha }) }, { soft: true });
  if (created?.__error?.status === 422) {
    // 标签已存在（发版重打）：把标签挪到新的提交上
    await api(`/git/refs/tags/v${version}`, { method: 'PATCH', body: JSON.stringify({ sha: tag.sha, force: true }) });
    console.log(`✓ tag v${version} 已移动到 ${commitSha.slice(0, 8)}`);
    return;
  }
  console.log(`✓ tag v${version} → ${commitSha.slice(0, 8)}`);
}

main().catch((e) => fail(e?.stack || String(e)));
