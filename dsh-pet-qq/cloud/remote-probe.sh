#!/usr/bin/env bash
set -uo pipefail
echo "== os =="; . /etc/os-release; echo "$PRETTY_NAME $(uname -r)"
echo "== cpu/mem =="; nproc; free -m | sed -n 2p
echo "== net =="
for u in https://registry.npmmirror.com/ https://mirror.ccs.tencentyun.com/v2/ https://registry-1.docker.io/v2/ https://api.deepseek.com/v1/models; do
  code=$(curl -s -o /dev/null -m 8 -w '%{http_code}' "$u" || echo ERR)
  echo "$code  $u"
done
echo "== apt docker =="; apt-cache policy docker.io 2>/dev/null | head -3
