#!/usr/bin/env node
/**
 * dsh-pet 人格切换 CLI。
 *
 *   node persona.mjs list            列出人格包 + 标出当前生效的那位
 *   node persona.mjs current         打印当前生效人设（原文截断）
 *   node persona.mjs use <序号|id>   切换人格（写配置 → 桌面宠物立刻换人设/换名）
 *   node persona.mjs show <序号|id>  完整打印某个人格的 prompt
 *   node persona.mjs test [文字]     用当前人设发一条对话，看回复（不经过 QQ）
 *
 * 环境变量：DSH_PET_BASE 覆盖 host 地址；DSH_PET_ID 覆盖宠物 id（默认 main）。
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  applyPersona,
  chat,
  currentPrompt,
  getPet,
  identify,
  loadPersonas,
} from './lib/pet-api.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PERSONAS_FILE = join(here, 'personas.json');
const PET_ID = process.env.DSH_PET_ID ?? 'main';

function usage() {
  console.log(`用法：
  node persona.mjs list
  node persona.mjs current
  node persona.mjs use <序号|id>
  node persona.mjs show <序号|id>
  node persona.mjs test [文字]

人格包：${PERSONAS_FILE}
宠物 id：${PET_ID}（可用 DSH_PET_ID 覆盖）`);
}

function pick(pack, key) {
  const list = pack.personas;
  if (/^\d+$/.test(key)) {
    const i = Number(key) - 1;
    const p = list[i];
    if (!p) throw new Error(`序号 ${key} 超出范围（1~${list.length}）`);
    return p;
  }
  const p = list.find((x) => x.id === key);
  if (!p) throw new Error(`没有这个 id：${key}（可选：${list.map((x) => x.id).join(', ')}）`);
  return p;
}

async function main() {
  const [cmd = 'list', ...rest] = process.argv.slice(2);
  const pack = await loadPersonas(PERSONAS_FILE);

  if (cmd === 'list' || cmd === 'ls') {
    const { pet } = await getPet(PET_ID);
    const active = identify(pack, await currentPrompt(PET_ID), pet.name);
    console.log(`宠物 ${PET_ID}：当前显示名「${pet.name}」`);
    console.log(`当前人格：${active ? `${active.label}（${active.id}）` : '（未匹配人格包，可能是自定义人设）'}\n`);
    pack.personas.forEach((p, i) => {
      const mark = active?.id === p.id ? '→' : ' ';
      console.log(`${mark} ${i + 1}. ${p.label}  [${p.id}]`);
      console.log(`     ${p.tagline}`);
    });
    return;
  }

  if (cmd === 'current') {
    const { pet } = await getPet(PET_ID);
    const prompt = await currentPrompt(PET_ID);
    const active = identify(pack, prompt, pet.name);
    console.log(`宠物：${PET_ID}（显示名 ${pet.name}）`);
    console.log(`人格：${active ? `${active.label}（${active.id}）` : '自定义'}`);
    console.log(`生效人设（前 400 字）：\n${prompt.slice(0, 400)}${prompt.length > 400 ? '…' : ''}`);
    return;
  }

  if (cmd === 'use' || cmd === 'set') {
    const key = rest[0];
    if (!key) throw new Error('缺少参数：use <序号|id>');
    const p = pick(pack, key);
    const r = await applyPersona(p, { petId: PET_ID });
    console.log(`已切换：${p.label}（宠物显示名 → ${r.name}）`);
    console.log('桌面宠物会由 host 重载（syncDesktop），外观位置不变，人设立即生效。');
    return;
  }

  if (cmd === 'show') {
    const p = pick(pack, rest[0] ?? String(pack.personas.findIndex((x) => x.id === pack.default) + 1));
    console.log(`${p.label} [${p.id}]  ${p.tagline}\n`);
    console.log(p.prompt);
    return;
  }

  if (cmd === 'test') {
    const text = rest.join(' ').trim() || '你好呀，今天过得怎么样？';
    const t0 = Date.now();
    const r = await chat(text, { petId: PET_ID });
    if (!r?.ok) throw new Error(`生成失败：${r?.reason} ${r?.message ?? ''}`);
    console.log(`你：${text}`);
    console.log(`宠物（${((Date.now() - t0) / 1000).toFixed(1)}s）：${r.text}`);
    if (r.image) console.log(`[表情包] ${r.image}`);
    return;
  }

  usage();
}

main().catch((e) => {
  console.error('出错：' + (e?.message ?? e));
  process.exitCode = 1;
});
