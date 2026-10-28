/**
 * 语音：用 Edge TTS（微软免费在线合成，不需要 key、不占显存）。
 *
 * 为什么先用它：豆包/火山要钱要备案，本地 TTS 在 2C2G 上跑不动（还得占 1G 内存）。
 * Edge TTS 是命令行一句话的事，音色够自然，缺点是要联网、偶尔抽风——所以失败一律退回文字，
 * 绝不让「语音挂了」变成「消息没回」。
 *
 * 服务器依赖：`pip install edge-tts`（apt 装 python3-pip）+ `apt install ffmpeg`（转码兜底）。
 */
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CACHE_DIR = join(tmpdir(), 'yuer-tts');
const KEEP_FILES = 40;

/** 念出来之前先洗一遍：表情包标记、括号动作、链接、多余符号都去掉 */
export function speechText(text = '', maxChars = 60) {
  let s = String(text || '')
    .replace(/\[\s*图\s*[:：][^\]\n]*\]/gu, '')
    .replace(/[（(][^（()）]{0,40}[)）]/gu, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_#`>~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = [...s];
  if (chars.length > maxChars) {
    // 尽量在标点处断，别把词切两半
    const cut = chars.slice(0, maxChars).join('');
    s = cut.replace(/[，,、；;：:。.!！?？]?[^，,、；;：:。.!！?？]*$/, '') || cut;
  }
  return s.trim();
}

function voiceOf(conf = {}) {
  return String(conf.voice || process.env.YUER_TTS_VOICE || 'zh-CN-XiaoyiNeural').trim();
}

async function prune() {
  try {
    const files = (await readdir(CACHE_DIR))
      .filter((f) => f.endsWith('.mp3'))
      .map((f) => join(CACHE_DIR, f));
    if (files.length <= KEEP_FILES) return;
    const withTime = await Promise.all(
      files.map(async (f) => {
        try {
          return { f, t: (await stat(f)).mtimeMs };
        } catch {
          return { f, t: 0 };
        }
      }),
    );
    withTime
      .sort((a, b) => a.t - b.t)
      .slice(0, withTime.length - KEEP_FILES)
      .forEach(({ f }) => unlink(f).catch(() => {}));
  } catch {
    // 清理失败无所谓
  }
}

/**
 * 合成一句语音。
 * @returns {Promise<{ok: true, path: string, bytes: number, text: string} | {ok: false, reason: string, message?: string}>}
 */
export async function synthesize(text, { conf = {}, timeoutMs = 20_000 } = {}) {
  const say = speechText(text, Number(conf.maxChars) || 60);
  if (!say) return { ok: false, reason: 'empty-text' };
  await mkdir(CACHE_DIR, { recursive: true });
  const out = join(CACHE_DIR, `tts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp3`);
  const args = ['--voice', voiceOf(conf), '--text', say, '--write-media', out];
  if (conf.rate) args.push('--rate', String(conf.rate));
  try {
    await new Promise((resolve, reject) => {
      execFile('edge-tts', args, { timeout: timeoutMs, windowsHide: true }, (err, _stdout, stderr) => {
        if (err) reject(new Error(String(stderr || err.message || err)));
        else resolve();
      });
    });
    const info = await stat(out);
    if (!info.size) throw new Error('合成结果为空');
    prune().catch(() => {});
    return { ok: true, path: out, bytes: info.size, text: say };
  } catch (e) {
    unlink(out).catch(() => {});
    const message = String(e?.message || e);
    return {
      ok: false,
      reason: /ENOENT/.test(message) ? 'tts-not-installed' : 'tts-failed',
      message,
    };
  }
}

/** 合成并读成 Buffer，方便直接塞进 OneBot 的 record 段 */
export async function synthesizeBuffer(text, opts = {}) {
  const res = await synthesize(text, opts);
  if (!res.ok) return res;
  try {
    const buf = await readFile(res.path);
    return { ...res, buffer: buf };
  } catch (e) {
    return { ok: false, reason: 'read-failed', message: String(e?.message || e) };
  }
}

/**
 * 是否该给这条消息配语音。
 * @param {object} conf behavior.voice
 * @param {{kind?:string, forced?:boolean, rng?:Function}} opts
 *   forced = 主人明确要语音（「语音呢」「唱两句」）——不看概率，直接说。
 */
export function shouldSpeak(conf = {}, { kind = 'private', forced = false, rng = Math.random } = {}) {
  if (conf.enabled === false) return false;
  if (conf.privateOnly !== false && kind !== 'private') return false;
  if (forced) return true;
  const chance = Number.isFinite(Number(conf.chance)) ? Number(conf.chance) : 0.15;
  return rng() < chance;
}
