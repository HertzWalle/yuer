#!/usr/bin/env bash
# 服务器端：更新代码（不含 data/）+ 导入新的表情包分类 + 重启服务。
# 前置：/tmp/dist.tgz、/tmp/memes.tgz、/tmp/merge-memes.mjs 已 scp 上来。
set -euo pipefail

DATA=/opt/dsh-pet/data
cd /opt/dsh-pet

sudo tar -xzf /tmp/dist.tgz -C /opt/dsh-pet
echo "代码已更新"

sudo cp /tmp/merge-memes.mjs /opt/dsh-pet/merge-memes.mjs
sudo tar -xzf /tmp/memes.tgz -C "$DATA"
echo "表情包分类目录："
sudo find "$DATA/memes" -mindepth 1 -maxdepth 1 -type d -printf '  %f\n' | sort

sudo node /opt/dsh-pet/merge-memes.mjs --data "$DATA"
sudo chown -R dshpet:dshpet /opt/dsh-pet/lib /opt/dsh-pet/*.mjs "$DATA" /opt/dsh-pet/logs
sudo systemctl restart dsh-pet-bot
sleep 4
echo "服务状态：$(systemctl is-active dsh-pet-bot)"
sudo journalctl -u dsh-pet-bot -n 10 --no-pager
