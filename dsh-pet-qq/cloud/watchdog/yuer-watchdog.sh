#!/bin/sh
# yuer-watchdog：OneBot 连不上时自动重启 NapCat（最多 1 次/小时）。
# 适用场景：QQ 登录态还在、只是 NapCat 的 WS 服务卡死 —— 重启后快速登录能自己回来。
# 如果是「QQ 掉登录」，重启只会生成新二维码，用户扫码后自动恢复。
set -u

STATE=/run/yuer-watchdog.state
LOG=/var/log/yuer-watchdog.log
NOW=$(date +%s)

log() { printf '%s %s\n' "$(date '+%F %T')" "$*" >> "$LOG"; }

if ss -ltn 2>/dev/null | grep -q '127\.0\.0\.1:3001'; then
  printf '0 0\n' > "$STATE"
  exit 0
fi

FAILS=0
LAST=0
if [ -f "$STATE" ]; then
  read -r FAILS LAST < "$STATE" 2>/dev/null || true
fi
case "$FAILS" in ''|*[!0-9]*) FAILS=0 ;; esac
case "$LAST" in ''|*[!0-9]*) LAST=0 ;; esac

FAILS=$((FAILS + 1))

if [ "$FAILS" -ge 4 ] && [ $((NOW - LAST)) -ge 3600 ]; then
  log "OneBot 3001 连续 ${FAILS} 次不通，重启 NapCat"
  docker restart napcat >/dev/null 2>&1 || log "重启 NapCat 失败"
  FAILS=0
  LAST=$NOW
  sleep 20
  if ss -ltn 2>/dev/null | grep -q '127\.0\.0\.1:3001'; then
    log "重启后 3001 已恢复"
  else
    log "重启后 3001 仍不通：多半是 QQ 掉登录，需要重新扫码"
  fi
fi

printf '%s %s\n' "$FAILS" "$LAST" > "$STATE"
