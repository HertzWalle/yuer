#!/usr/bin/env bash
# v1.6.0 部署（S3 / S4 / S5）：解包代码 → 合并 pet.json 配置 → 可选写入 TURN_TOKEN → 重启 → 自检
# 用法：scp dist.tgz 到 /tmp/dist.tgz 后  sudo bash /tmp/remote-deploy-v8.sh
set -euo pipefail

APP=/opt/dsh-pet
PKG=/tmp/dist.tgz
[ -f "$PKG" ] || { echo "找不到 $PKG"; exit 1; }

echo "== 1. 解包代码（保留 data/ 与 logs/）"
tar -xzf "$PKG" -C "$APP"

echo "== 2. 合并 pet.json 的 feeds / memory 配置（保留已调的其它值）"
node - <<'NODE'
const fs = require('node:fs');
const p = '/opt/dsh-pet/data/pet.json';
const c = JSON.parse(fs.readFileSync(p, 'utf8'));
c.feeds = { enabled: true, hours: [10, 20], biliLimit: 5, douyinLimit: 5, ...(c.feeds || {}) };
c.memory = { maxHistoryTokens: 900, compressAt: 0.82, keepRecentRatio: 0.15, summaryMaxChars: 700, ...(c.memory || {}) };
fs.writeFileSync(p, JSON.stringify(c, null, 2));
console.log('feeds =', JSON.stringify(c.feeds));
console.log('memory =', JSON.stringify(c.memory));
NODE

echo "== 3. 可选：写入 TURN_TOKEN（有 /tmp/turn.token 就配，否则不动 .env）"
if [ -f /tmp/turn.token ]; then
  TOKEN=$(tr -d '\r\n' < /tmp/turn.token)
  if [ -n "$TOKEN" ]; then
    if grep -q '^TURN_TOKEN=' "$APP/.env" 2>/dev/null; then
      sed -i "s|^TURN_TOKEN=.*|TURN_TOKEN=$TOKEN|" "$APP/.env"
    else
      printf '\nTURN_TOKEN=%s\nTURN_HOST=127.0.0.1\nTURN_PORT=3030\n' "$TOKEN" >> "$APP/.env"
    fi
    echo "TURN_TOKEN 已写入（${#TOKEN} 字符）"
  fi
else
  echo "没有 /tmp/turn.token，/turn 契约保持不启动"
fi

echo "== 4. 权限与重启"
chown -R dshpet:dshpet "$APP/lib" "$APP"/*.mjs "$APP/personas.json" "$APP/data" 2>/dev/null || true
systemctl restart dsh-pet-bot
sleep 3

echo "== 5. 自检"
echo -n "服务状态："; systemctl is-active dsh-pet-bot
echo -n "feeds 接线："; grep -c 'runFeeds' "$APP/lib/scheduler.mjs" || true
echo -n "记忆管理接线："; grep -c 'manageHistory' "$APP/lib/pet-api.mjs" || true
echo -n "turn 模块："; grep -c 'createTurnServer' "$APP/start-bot.mjs" || true
echo "--- 最近日志 ---"
journalctl -u dsh-pet-bot -n 8 --no-pager || true

echo "== 6. /turn 健康检查（若已启用）"
PORT=$(grep -E '^TURN_PORT=' "$APP/.env" 2>/dev/null | cut -d= -f2 | tr -d '\r')
PORT=${PORT:-3030}
curl -s --max-time 3 "http://127.0.0.1:${PORT}/health" || echo "（/turn 未启动或未配 token）"
echo
