#!/usr/bin/env bash
# 线上验证 v1.3.0：气泡条数不再固定、配图在生成层掷骰子
set -euo pipefail
sudo rm -rf /tmp/t13
mkdir -p /tmp/t13/lib
cp -r /opt/dsh-pet/data /tmp/t13/data
cp /opt/dsh-pet/personas.json /tmp/t13/personas.json
cp /opt/dsh-pet/lib/*.mjs /tmp/t13/lib/
# 清空记忆/冷却，只看「新会话」下的形态（否则旧历史里的人格会带偏语气）
echo '{}' > /tmp/t13/data/memory.json
rm -f /tmp/t13/data/chatter.json
cat > /tmp/t13/probe.mjs <<'NODE'
import { pathToFileURL } from 'node:url';
const api = await import(pathToFileURL('/tmp/t13/lib/pet-api.mjs').href);
const inputs = ['在吗', '今天累死了，加班到十点', '你说我今天该不该早点睡', '晚安'];
for (const t of inputs) {
  const r = await api.chat(t, { petId: 'main', surface: 'private', conv: 'private:1' });
  console.log(`${t} → ${r.ok ? r.segments.length + ' 条 | ' + r.segments.map((s) => s.length).join('+') : 'FAIL ' + r.reason}${r.image ? ' [图:' + r.image + ']' : ''}`);
  if (r.ok) for (const s of r.segments) console.log('   · ' + s);
}
let img = 0;
for (let i = 0; i < 10; i += 1) {
  const r = await api.chat('嗯' + i, { petId: 'main', surface: 'private', conv: 'private:1' });
  if (r.ok && r.image) img += 1;
}
console.log('带图：再 10 条里 ' + img + ' 条');
NODE
sudo chown -R dshpet:dshpet /tmp/t13
cd /tmp/t13
sudo -u dshpet env DSH_PET_DATA=/tmp/t13/data TZ=Asia/Shanghai \
  DEEPSEEK_API_KEY="$(sudo grep '^DEEPSEEK_API_KEY=' /opt/dsh-pet/.env | cut -d= -f2-)" \
  DEEPSEEK_BASE_URL="$(sudo grep '^DEEPSEEK_BASE_URL=' /opt/dsh-pet/.env | cut -d= -f2-)" \
  DEEPSEEK_MODEL="$(sudo grep '^DEEPSEEK_MODEL=' /opt/dsh-pet/.env | cut -d= -f2-)" \
  /usr/local/bin/node /tmp/t13/probe.mjs
sudo rm -rf /tmp/t13
