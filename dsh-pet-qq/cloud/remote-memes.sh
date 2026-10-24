#!/usr/bin/env bash
# 在服务器上跑：把 /tmp/memes.tgz 解到 /opt/dsh-pet/data，合并 pet.json 的表情包，重启服务。
# 由本机用 scp 传上来执行（保持 LF、无 BOM）。
set -euo pipefail

DATA=/opt/dsh-pet/data
cd /opt/dsh-pet

if [ ! -f /tmp/memes.tgz ]; then
  echo "缺少 /tmp/memes.tgz" >&2
  exit 1
fi

sudo tar -xzf /tmp/memes.tgz -C "$DATA"
echo "解包完成，分类目录："
sudo find "$DATA/memes" -mindepth 1 -maxdepth 1 -type d -printf '  %f\n' | sort | head -40

sudo node merge-memes.mjs --data "$DATA"
sudo chown -R dshpet:dshpet "$DATA"
sudo systemctl restart dsh-pet-bot
sleep 3
echo "服务状态：$(systemctl is-active dsh-pet-bot)"
sudo journalctl -u dsh-pet-bot -n 8 --no-pager | tail -8
