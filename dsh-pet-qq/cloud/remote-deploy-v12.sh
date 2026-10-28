#!/usr/bin/env bash
# v1.14.0 部署：解包代码 → 合并语音开关 → 重启 → 自检（含一次真合成）
set -euo pipefail

APP=/opt/dsh-pet
PKG=/tmp/dist.tgz
[ -f "$PKG" ] || { echo "找不到 $PKG"; exit 1; }

echo "== 1. 解包代码（保留 data/ 与 logs/）"
tar -xzf "$PKG" -C "$APP"

echo "== 2. 合并配置"
node - <<'NODE'
const fs = require('node:fs');
const bp = '/opt/dsh-pet/bridge.config.json';
const b = JSON.parse(fs.readFileSync(bp, 'utf8'));
b.behavior = b.behavior || {};
b.behavior.voice = {
  enabled: true,
  chance: 0.15,
  privateOnly: true,
  voice: 'zh-CN-XiaoyiNeural',
  maxChars: 60,
  ...(b.behavior.voice || {}),
};
if (b.behavior.voiceDelayMs == null) b.behavior.voiceDelayMs = 400;
fs.writeFileSync(bp, JSON.stringify(b, null, 2));
console.log('voice =', JSON.stringify(b.behavior.voice));
NODE

echo "== 3. 权限与重启"
chown -R dshpet:dshpet "$APP/lib" "$APP"/*.mjs "$APP/personas.json" "$APP/data" 2>/dev/null || true
systemctl restart dsh-pet-bot
sleep 3

echo "== 4. 自检"
echo -n "服务状态："; systemctl is-active dsh-pet-bot
echo -n "版本："; cat "$APP/VERSION" 2>/dev/null || echo （无）
echo -n "语音优先接线："; grep -c 'voiceSent' "$APP/qq-bridge.mjs" || true
echo -n "要语音识别："; grep -c 'wantsVoice' "$APP/lib/pet-api.mjs" || true
echo -n "edge-tts："; command -v edge-tts || echo 缺
echo "--- 最近日志 ---"
journalctl -u dsh-pet-bot -n 6 --no-pager || true

echo "== 5. /turn 健康检查"
PORT=$(grep -E '^TURN_PORT=' "$APP/.env" 2>/dev/null | cut -d= -f2 | tr -d '\r')
PORT=${PORT:-3030}
curl -s --max-time 3 "http://127.0.0.1:${PORT}/health" || echo "（/turn 未启动或未配 token）"
echo
