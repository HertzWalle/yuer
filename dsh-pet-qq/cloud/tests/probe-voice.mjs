/**
 * 服务器侧验证：主人要语音 → chat 带 voiceWanted → 合成成功（只发语音的判定依据）。
 * 用法（服务器上）：sudo -u dshpet env DSH_PET_DATA=/tmp/tv14 ... node /tmp/probe-voice.mjs
 */
import { mkdtempSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = '/opt/dsh-pet';
const data = mkdtempSync(join(tmpdir(), 'yuer-voice-'));
cpSync(join(APP, 'data'), data, { recursive: true });

// 用干净的上下文，别把线上记忆带进来
const memFile = join(data, 'memory.json');
try {
  const mem = JSON.parse(readFileSync(memFile, 'utf8'));
  for (const k of Object.keys(mem)) delete mem[k];
  writeFileSync(memFile, JSON.stringify(mem));
} catch {}

process.env.DSH_PET_DATA = data;

const api = await import(`${APP}/lib/pet-api.mjs`);
const tts = await import(`${APP}/lib/tts.mjs`);

const cases = ['语音呢？打字敷衍我', '唱两句我听听', '今天好累啊'];
for (const text of cases) {
  const r = await api.chat(text, { petId: 'main', surface: 'private', conv: 'private:probe' });
  const line = (r.segments ?? []).join(' ');
  const spoken = r.voiceWanted ? await tts.synthesizeBuffer(line, { conf: { chance: 1 } }) : null;
  console.log(
    JSON.stringify({
      text,
      voiceWanted: Boolean(r.voiceWanted),
      segments: (r.segments ?? []).length,
      reply: line.slice(0, 40),
      mp3: spoken ? (spoken.ok ? 'ok' : String(spoken.reason)) : '(未合成)',
    }),
  );
}
