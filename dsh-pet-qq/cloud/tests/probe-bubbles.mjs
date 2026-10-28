/**
 * 气泡断句实测：真打 DeepSeek，看条数与每条的完整性。
 * 用法：node cloud/tests/probe-bubbles.mjs（读 cloud/bot.env 里的 key）
 */
import { readFileSync, mkdtempSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, '..', '..', 'dist');

// 读 key
const envText = readFileSync(join(HERE, '..', 'bot.env'), 'utf8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] ??= m[2];
}

const data = mkdtempSync(join(tmpdir(), 'yuer-bub-'));
cpSync(join(DIST, 'data'), data, { recursive: true });
process.env.DSH_PET_DATA = data;

const api = await import(new URL('file://' + join(DIST, 'lib', 'pet-api.mjs')).href);

const cases = ['在吗', '今天上班被老板骂了', '帮我解释一下什么是递归，顺便给个例子', '晚安'];
for (const text of cases) {
  const r = await api.chat(text, { petId: 'main', surface: 'private', conv: 'private:1' });
  const segs = r.segments ?? [];
  console.log(`\n> ${text}`);
  console.log(`  条数=${segs.length}  字数=${segs.map((s) => s.length).join('/')}`);
  for (const s of segs) console.log(`  · ${s}`);
  const bad = segs.filter((s) => !/[。！？!?…~～]$/.test(s));
  if (bad.length) console.log(`  ⚠ 没以标点收尾：${JSON.stringify(bad)}`);
}

rmSync(data, { recursive: true, force: true });
