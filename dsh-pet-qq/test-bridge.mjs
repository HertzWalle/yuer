#!/usr/bin/env node
/**
 * 桥接逻辑的离线验证：用假 transport 直接喂 OneBot 事件，不依赖 QQ 框架。
 *   node test-bridge.mjs
 * 会真实调用 dsh-pet（走当前配置的人格与模型），因此每条消息要 1~3 秒。
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createBridge } from './qq-bridge.mjs';
import { loadPersonas, getPet, currentPrompt, identify } from './lib/pet-api.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const conf = JSON.parse(await readFile(join(here, 'bridge.config.json'), 'utf8'));
const personas = await loadPersonas(join(here, 'personas.json'));

const sent = [];
const transport = {
  async send(msg, segments) {
    sent.push({ to: `${msg.kind}:${msg.groupId ?? msg.senderId}`, segments });
    return { message_id: sent.length };
  },
};
const quiet = { info() {}, warn() {}, error: (m) => console.log('  ! ' + m) };
const bridge = createBridge({ conf, personas, transport, log: quiet });

const ev = (over = {}) => ({
  post_type: 'message',
  self_id: 10000,
  message_type: 'private',
  message_id: String(Math.floor(Math.random() * 1e9)),
  user_id: 20001,
  sender: { user_id: 20001, nickname: '主人' },
  message: [{ type: 'text', data: { text: '你好' } }],
  ...over,
});

const segText = (segs) =>
  segs.filter((s) => s.type === 'text').map((s) => s.data.text).join('') +
  segs.filter((s) => s.type === 'image').map(() => '[image]').join('');

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' —— ' + detail : ''}`);
};

const last = () => (sent.length ? sent[sent.length - 1] : null);

async function main() {
  // 1) 私聊普通聊天
  await bridge.handleEvent(ev());
  {
    const t = last() ? segText(last().segments) : '';
    check('私聊消息得到回复', !!t && last().to === 'private:20001', t.slice(0, 60));
  }

  // 2) 同一 message_id 重放 → 去重
  const dup = ev({ message_id: 'dup-1' });
  const n0 = sent.length;
  await bridge.handleEvent(dup);
  await bridge.handleEvent(dup);
  check('重复消息只回一次', sent.length - n0 === 1, `新增 ${sent.length - n0} 条`);

  // 3) 群里没 @ → 不回
  const n1 = sent.length;
  await bridge.handleEvent(ev({ message_type: 'group', group_id: 333, message_id: 'g1' }));
  check('群消息未被 @ 时忽略', sent.length === n1);

  // 4) 群里 @ → 回，且带上发送人昵称
  await bridge.handleEvent(
    ev({
      message_type: 'group',
      group_id: 333,
      message_id: 'g2',
      user_id: 20123,
      sender: { user_id: 20123, card: '小明', nickname: '小明' },
      message: [
        { type: 'at', data: { qq: '10000', name: '小蓝' } },
        { type: 'text', data: { text: ' 今天好热啊' } },
      ],
    }),
  );
  {
    const t = last() ? segText(last().segments) : '';
    check('群内被 @ 时回复', !!t && last().to === 'group:333', t.slice(0, 60));
  }

  // 5) /人格 列表
  await bridge.handleEvent(ev({ message_id: 'c1', message: [{ type: 'text', data: { text: '/人格' } }] }));
  {
    const t = last() ? segText(last().segments) : '';
    check('/人格 列出人格包', t.includes('我现在是') && t.includes('傲娇猫娘'), t.split('\n')[0]);
  }

  // 6) 切人格（傲娇）
  await bridge.handleEvent(ev({ message_id: 'c2', message: [{ type: 'text', data: { text: '/人格 2' } }] }));
  {
    const { pet } = await getPet('main');
    const active = identify(personas, await currentPrompt('main'), pet.name);
    check('切换到阿喵后配置生效', active?.id === 'anmiao', `当前=${active?.label ?? '未知'} / 名字=${pet.name}`);
  }

  // 7) 新人格聊天，语气应该变了（只验证有回复 + 记录内容供人看）
  await bridge.handleEvent(
    ev({ message_id: 'c3', message: [{ type: 'text', data: { text: '你今天怎么样呀' } }] }),
  );
  check('切换后仍能聊天', !!last() && segText(last().segments).length > 0, segText(last().segments).slice(0, 60));

  // 8) /状态
  await bridge.handleEvent(ev({ message_id: 'c4', message: [{ type: 'text', data: { text: '/状态' } }] }));
  check('/状态 返回宠物信息', (segText(last().segments) ?? '').includes('宠物：'));

  // 9) 切回小蓝，让桌面停在"新增人格"上
  await bridge.handleEvent(ev({ message_id: 'c5', message: [{ type: 'text', data: { text: '/人格 1' } }] }));
  {
    const { pet } = await getPet('main');
    check('切回小蓝', pet.name === '小蓝', `名字=${pet.name}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => {
  console.error('测试异常：' + (e?.stack ?? e));
  process.exitCode = 1;
});
