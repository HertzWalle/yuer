#!/usr/bin/env node
/**
 * 服务器端：把 memes.extra.json 里的分类表情包合并进 data/pet.json。
 *
 * 只改 memes 与 chatImageLimit，不动人设（pet.prompt/name）、不动记忆。
 * 用法：node merge-memes.mjs [--data /opt/dsh-pet/data] [--file <data>/memes.extra.json]
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const data = resolve(arg('data', 'data'));
const extraPath = resolve(arg('file', join(data, 'memes.extra.json')));
const petPath = join(data, 'pet.json');

const extra = JSON.parse(await readFile(extraPath, 'utf8'));
const pet = JSON.parse(await readFile(petPath, 'utf8'));
const before = Object.keys(pet.memes || {}).length;
pet.memes = { ...(pet.memes || {}), ...extra };
const pool = Object.keys(pet.memes).length;
pet.chatImageLimit = Math.max(Number(pet.chatImageLimit) || 0, pool);
await writeFile(petPath, JSON.stringify(pet, null, 2), 'utf8');
console.log(`pet.json：表情包 ${before} → ${pool}，chatImageLimit=${pet.chatImageLimit}`);
