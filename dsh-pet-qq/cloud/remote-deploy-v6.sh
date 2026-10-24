#!/bin/bash
set -e
cd /tmp
tar -xzf /tmp/dist.tgz -C /opt/dsh-pet
node - <<'NODE'
const fs = require('fs');
const f = '/opt/dsh-pet/data/pet.json';
const p = JSON.parse(fs.readFileSync(f, 'utf8'));
p.surfaces = p.surfaces || {};
p.surfaces.groups = p.surfaces.groups || {};
if (!p.surfaces.private) p.surfaces.private = p.active || null;
if (!p.surfaces.group) p.surfaces.group = 'niyujie';
fs.writeFileSync(f, JSON.stringify(p, null, 2));
console.log('surfaces =', JSON.stringify(p.surfaces));
NODE
chown -R dshpet:dshpet /opt/dsh-pet/lib /opt/dsh-pet/*.mjs /opt/dsh-pet/personas.json /opt/dsh-pet/data
systemctl restart dsh-pet-bot
sleep 2
systemctl is-active dsh-pet-bot
grep -c 'surfaces.groups' /opt/dsh-pet/lib/pet-api.mjs
grep -c 'ownerIds' /opt/dsh-pet/qq-bridge.mjs
journalctl -u dsh-pet-bot -n 6 --no-pager