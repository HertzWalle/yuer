#!/usr/bin/env bash
set -uo pipefail
echo "== pet.json =="
/usr/local/bin/node - <<'NODE'
const p = require('/opt/dsh-pet/data/pet.json');
console.log(JSON.stringify({
  surfaces: p.surfaces,
  active: p.active,
  name: p.pet.name,
  memeCooldown: p.memeCooldown,
  memeChancePrivate: p.memeChancePrivate,
  maxBubbles: p.maxBubbles,
  identity: (p.identity || '').slice(0, 30),
  promptHead: (p.pet.prompt || '').slice(0, 60),
}, null, 1));
NODE
echo "== data 目录 =="
ls -la /opt/dsh-pet/data | head -20
echo "== chatter.json =="
cat /opt/dsh-pet/data/chatter.json 2>/dev/null | head -c 400 || echo '(还没有)'
echo
echo "== 私聊人格解析 =="
cd /opt/dsh-pet
sudo -u dshpet env DSH_PET_DATA=/opt/dsh-pet/data TZ=Asia/Shanghai /usr/local/bin/node - <<'NODE'
const api = await import('/opt/dsh-pet/lib/pet-api.mjs');
for (const s of ['private', 'group', 'any']) {
  const p = await api.resolvePersona(s, 'main');
  console.log(s, '→', p.id, p.name, (p.prompt || '').length + ' 字');
}
const m = await api.memeStats('private');
console.log('memeStats private:', JSON.stringify(m));
NODE
