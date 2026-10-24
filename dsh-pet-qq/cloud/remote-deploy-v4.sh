#!/usr/bin/env bash
# v1.3.0 部署：#1 表情包降率（生成层掷骰子）+ #2 气泡自由度（按内容决定条数）
# 只更新代码；data/ 里只合并参数键，不动记忆/人格正文
set -euo pipefail

APP=/opt/dsh-pet

echo "== 解包代码 =="
tar -xzf /tmp/dist.tgz -C "$APP"

echo "== 合并参数 =="
/usr/local/bin/node <<'NODE'
const fs = require('fs');
const petFile = '/opt/dsh-pet/data/pet.json';
const pet = JSON.parse(fs.readFileSync(petFile, 'utf8'));
pet.maxBubbles = 6;          // 软上限（原来 3，是硬上限）
pet.splitChance = 0.5;       // 爱不爱拆的总开关
pet.memeChancePrivate = 0.18; // 私聊带图概率（生成层）
pet.memeChanceGroup = 0.06;   // 群聊带图概率
pet.memeCooldown = 5;         // 最近 N 条带过图就不再给资格
fs.writeFileSync(petFile, JSON.stringify(pet, null, 2) + '\n', 'utf8');
console.log('pet.json：maxBubbles=' + pet.maxBubbles + ' 私聊带图=' + pet.memeChancePrivate + ' 群聊=' + pet.memeChanceGroup + ' 冷却=' + pet.memeCooldown);

const bf = '/opt/dsh-pet/bridge.config.json';
const conf = JSON.parse(fs.readFileSync(bf, 'utf8'));
conf.behavior = conf.behavior || {};
conf.behavior.maxBubbles = 6;
conf.behavior.tailPauseMs = 800;
delete conf.behavior.memeChance; // 概率已经移到生成层，发送层不再二次过滤
fs.writeFileSync(bf, JSON.stringify(conf, null, 2) + '\n', 'utf8');
console.log('bridge.config.json：behavior=' + JSON.stringify(conf.behavior));
NODE

echo "== 权限 + 重启 =="
chown -R dshpet:dshpet "$APP/lib" "$APP"/*.mjs "$APP/data" "$APP/bridge.config.json" "$APP/personas.json" 2>/dev/null || true
systemctl restart dsh-pet-bot
sleep 3
systemctl is-active dsh-pet-bot

echo "== 日志（最近 12 行）=="
journalctl -u dsh-pet-bot -n 12 --no-pager | tail -12
