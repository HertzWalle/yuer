#!/usr/bin/env bash
# 只更新代码与表情包素材，不动 data/pet.json 里的记忆/人设状态（surfaces 单独 merge）。
set -euo pipefail

cd /opt/dsh-pet

echo "== 解包代码 =="
tar -xzf /tmp/dist.tgz -C /opt/dsh-pet

echo "== 解包表情包（覆盖同名文件，尺寸已缩到 240px） =="
tar -xzf /tmp/memes.tgz -C /opt/dsh-pet/data

echo "== 合并 surfaces / identity 到 pet.json =="
node <<'NODE'
const fs = require('fs');
const p = '/opt/dsh-pet/data/pet.json';
const c = JSON.parse(fs.readFileSync(p, 'utf8'));
c.surfaces = { private: 'xiaolan', group: 'niyujie' };
const m = /【身份】[\s\S]*$/.exec(c.pet.prompt || '');
if (m && !c.identity) c.identity = m[0].trim();
fs.writeFileSync(p, JSON.stringify(c, null, 2));
console.log('  surfaces =', JSON.stringify(c.surfaces), '| identity 长度', (c.identity || '').length);
NODE

chown -R dshpet:dshpet /opt/dsh-pet
systemctl restart dsh-pet-bot
sleep 3
echo "== 服务状态：$(systemctl is-active dsh-pet-bot) =="
journalctl -u dsh-pet-bot -n 5 --no-pager | tail -5
