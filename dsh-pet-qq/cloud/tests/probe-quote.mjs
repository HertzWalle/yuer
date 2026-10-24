/**
 * 线上探针：验证「引用回复」在服务器上真的通。
 * 用假 transport（带 call → get_msg）+ 真实云端大脑（真打一次 DeepSeek），
 * 数据目录指向副本，不污染生产记忆。
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.DSH_PET_DATA = await mkdtemp(join(tmpdir(), 'qzprobe-'));
const APP = '/opt/dsh-pet';
const { createBridge } = await import(pathToFileURL(join(APP, 'qq-bridge.mjs')).href);
const petApi = await import(pathToFileURL(join(APP, 'lib/pet-api.mjs')).href);

const conf = {
  pet: { id: 'main' },
  behavior: { groupReply: 'at', privateReply: true, typingDelayMs: 0, bubbleDelayMs: 0, tailPauseMs: 0, quoteReply: 'auto', memeEnabled: false },
  proactive: { ownerIds: ['1360153202'] },
};
const personas = await petApi.loadPersonas(join(APP, 'personas.json'));

const sent = [];
const quoted = {
  777: { sender: { user_id: 2536561711, nickname: 'dsh大肥鱼·小蓝' }, message: [{ type: 'text', data: { text: '你行你上啊' } }] },
  779: { sender: { user_id: 2536561711, nickname: 'dsh大肥鱼·小蓝' }, message: [{ type: 'text', data: { text: '机房空调又坏了' } }] },  778: { sender: { user_id: 1360153202, nickname: 'HudsonZephyr' }, message: [{ type: 'text', data: { text: '周末要不要出去走走' } }] },
};
const transport = {
  async send(msg, segments) {
    sent.push({ to: `${msg.kind}:${msg.groupId ?? msg.senderId}`, segments });
    return { message_id: sent.length };
  },
  async call(action, params) {
    if (action !== 'get_msg') throw new Error('不支持 ' + action);
    const hit = quoted[String(params.message_id)];
    if (!hit) throw new Error('消息不存在');
    return { message_id: params.message_id, ...hit };
  },
};
const log = { info() {}, warn: (m) => console.log('WARN', m), error: (m) => console.log('ERR', m) };
const bridge = createBridge({ conf, personas, transport, log });

const text = (segs) => segs.filter((s) => s.type === 'text').map((s) => s.data.text).join(' / ');

const base = {
  post_type: 'message',
  self_id: 2536561711,
  message_type: 'group',
  group_id: 1106592574,
  user_id: 1360153202,
  sender: { user_id: 1360153202, card: 'HudsonZephyr', nickname: 'HudsonZephyr' },
};

// 1) 群里引用她自己说过的话 + @ 她
const n1 = sent.length;
await bridge.handleEvent({
  ...base,
  message_id: 'g-quote-1',
  message: [
    { type: 'reply', data: { id: '777' } },
    { type: 'at', data: { qq: '2536561711', name: '小蓝' } },
    { type: 'text', data: { text: ' 那我真上了啊' } },
  ],
});
const g = sent.slice(n1)[0];
console.log('群引用 →', JSON.stringify(g.segments[0]?.data), '|', text(g.segments).slice(0, 120), '| 共', sent.length - n1, '条');

// 2) 私聊引用主人的话
const n2 = sent.length;
await bridge.handleEvent({
  post_type: 'message',
  self_id: 2536561711,
  message_type: 'private',
  message_id: 'p-quote-1',
  user_id: 1360153202,
  sender: { user_id: 1360153202, nickname: 'HudsonZephyr' },
  message: [
    { type: 'reply', data: { id: '778' } },
    { type: 'text', data: { text: '这话还作数吗' } },
  ],
});
const p = sent.slice(n2)[0];
console.log('私聊引用 →', JSON.stringify(p.segments[0]?.data), '|', text(p.segments).slice(0, 120), '| 共', sent.length - n2, '条');

const okGroup = g.segments[0]?.type === 'reply' && String(g.segments[0].data.id) === 'g-quote-1';
const okPriv = p.segments[0]?.type === 'reply' && String(p.segments[0].data.id) === 'p-quote-1';
// 3) 群里只引用她的话、没有 @：也算在跟她说话
const n3 = sent.length;
await bridge.handleEvent({
  ...base,
  message_id: 'g-quote-2',
  message: [
    { type: 'reply', data: { id: '779' } },
    { type: 'text', data: { text: '那你不去修？' } },
  ],
});
const g2 = sent.slice(n3)[0];
console.log('群引用无 @ →', g2 ? JSON.stringify(g2.segments[0]?.data) + ' | ' + text(g2.segments).slice(0, 100) : '没回');
const okNoAt = Boolean(g2) && g2.segments[0]?.type === 'reply' && String(g2.segments[0].data.id) === 'g-quote-2';
console.log(okGroup && okPriv && okNoAt ? 'PROBE_OK 引用段都带上了（含无 @ 场景）' : 'PROBE_FAIL');
