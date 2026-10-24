#!/bin/sh
# v1.3.0 部署：表情包降率 / 气泡自由度 / QQ 空间 A+B 档
set -e
cd /opt/dsh-pet

echo "== 1. 解包代码（dist 不含 data）"
sudo tar -xzf /tmp/dist.tgz -C /opt/dsh-pet

echo "== 2. 合并 pet.json 的 qzone 配置"
sudo -u dshpet /usr/local/bin/node - <<'NODE'
const fs = require('fs');
const p = '/opt/dsh-pet/data/pet.json';
const c = JSON.parse(fs.readFileSync(p, 'utf8'));
c.maxBubbles = 6;
c.splitChance = 0.5;
c.memeChancePrivate = 0.18;
c.memeChanceGroup = 0.06;
c.memeCooldown = 5;
c.qzone = {
  enabled: true,
  readHour: 21,
  readNum: 10,
  freshDays: 30,
  publishEnabled: true,
  dailyLimit: 1,
  impulseThreshold: 85,
  impulseCost: 30,
  maxChars: 90,
  dryRun: true,
  maxFails: 3,
};
fs.writeFileSync(p, JSON.stringify(c, null, 2));
console.log('pet.json: maxBubbles=6 memeChance 0.18/0.06 qzone.dryRun=', c.qzone.dryRun);
NODE

echo "== 3. 权限与重启"
sudo chown -R dshpet:dshpet /opt/dsh-pet/lib /opt/dsh-pet/*.mjs /opt/dsh-pet/logs /opt/dsh-pet/data 2>/dev/null || true
sudo systemctl restart dsh-pet-bot
sleep 4
echo "== 4. 状态"
systemctl is-active dsh-pet-bot
sudo journalctl -u dsh-pet-bot -n 12 --no-pager | sed 's/^/  /'
echo "== 5. 文件检查"
grep -c 'qzone' /opt/dsh-pet/lib/scheduler.mjs || true
ls -l /opt/dsh-pet/lib/qzone.mjs /opt/dsh-pet/lib/semantic.mjs
