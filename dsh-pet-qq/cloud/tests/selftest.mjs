#!/usr/bin/env node
/**
 * 云端包的离线自测：**不碰 QQ、不碰真实 LLM**。
 *
 *   node cloud/tests/selftest.mjs          # 先 node cloud/build.mjs
 *
 * 做法：把 dist/ 的数据目录指到临时副本，起一个假 LLM，喂合成 OneBot 事件给真桥，
 * 断言「回包/去重/群 @/人格切换/记忆落盘/表情包/状态」全部符合预期，最后再拉一次备份服务。
 * 目的：换机器部署前先在本机确认这套代码本身是通的。
 */

import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startMockLlm } from './mock-llm.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const DIST = join(REPO, 'dist');

if (!existsSync(join(DIST, 'qq-bridge.mjs'))) {
  console.error('找不到 dist/，先跑 node cloud/build.mjs');
  process.exit(2);
}

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' —— ' + detail : ''}`);
};

const tmp = await mkdtemp(join(tmpdir(), 'dsh-pet-cloud-'));
await cp(join(DIST, 'data'), join(tmp, 'data'), { recursive: true });

const mock = await startMockLlm();
process.env.DSH_PET_DATA = join(tmp, 'data');
process.env.DEEPSEEK_API_KEY = 'test-key';
process.env.DEEPSEEK_BASE_URL = mock.baseUrl;
process.env.DEEPSEEK_MODEL = 'mock';
process.env.TZ = process.env.TZ || 'Asia/Shanghai';

const { createBridge } = await import(pathToFileURL(join(DIST, 'qq-bridge.mjs')).href);
const petApi = await import(pathToFileURL(join(DIST, 'lib', 'pet-api.mjs')).href);

const conf = JSON.parse(await readFile(join(DIST, 'bridge.config.json'), 'utf8'));
// 自测里把带图概率固定成 100%，否则 35% 的随机会让断言飘
conf.behavior = { ...(conf.behavior || {}), memeChance: 1 };
const personas = await petApi.loadPersonas(join(DIST, 'personas.json'));

const sent = [];
const transport = {
  async send(msg, segments) {
    sent.push({ to: `${msg.kind}:${msg.groupId ?? msg.senderId}`, segments });
    return { message_id: sent.length };
  },
};
const quiet = { info() {}, warn() {}, error: (m) => console.log('  ! ' + m) };
const bridge = createBridge({ conf, personas, transport, log: quiet });

let seq = 0;
const ev = (over = {}) => ({
  post_type: 'message',
  self_id: 10000,
  message_type: 'private',
  message_id: 'm' + ++seq,
  user_id: 20001,
  sender: { user_id: 20001, nickname: '主人' },
  message: [{ type: 'text', data: { text: '你好' } }],
  ...over,
});
const segText = (segs) =>
  segs.filter((s) => s.type === 'text').map((s) => s.data.text).join('') +
  segs.filter((s) => s.type === 'image').map(() => '[image]').join('');
const last = () => (sent.length ? sent[sent.length - 1] : null);
// 文字与表情包现在是两条独立消息，断言要能分别取到
const lastWith = (type) => [...sent].reverse().find((x) => x.segments.some((s) => s.type === type)) ?? null;

async function main() {
  // 1 私聊
  await bridge.handleEvent(ev());
  check('私聊消息得到回复', last() && last().to === 'private:20001' && segText(last().segments).length > 0, segText(last()?.segments ?? '').slice(0, 50));

  // 2 去重
  const dup = ev({ message_id: 'dup-1' });
  const n0 = sent.length;
  await bridge.handleEvent(dup);
  await bridge.handleEvent(dup);
  check('重复 message_id 只回一次', sent.length - n0 === 1, `新增 ${sent.length - n0} 条`);

  // 3 群未 @
  const n1 = sent.length;
  await bridge.handleEvent(ev({ message_type: 'group', group_id: 333 }));
  check('群消息未 @ 时忽略', sent.length === n1);

  // 4 群 @
  await bridge.handleEvent(
    ev({
      message_type: 'group',
      group_id: 333,
      user_id: 20123,
      sender: { user_id: 20123, card: '小明', nickname: '小明' },
      message: [
        { type: 'at', data: { qq: '10000', name: '小蓝' } },
        { type: 'text', data: { text: ' 今天好累啊' } },
      ],
    }),
  );
  check('群内被 @ 时回复并带昵称', lastWith('text')?.to === 'group:333' && segText(lastWith('text').segments).includes('小明'), segText(lastWith('text')?.segments ?? '').slice(0, 60));

  // 5 表情包（假大脑对含「累」的话会附 [图:…]，应解析成 image 段）
  const imgMsg = lastWith('image');
  check('表情包按 [图:名称] 单独成一条发送', Boolean(imgMsg) && imgMsg.segments.length === 1 && imgMsg.segments[0].type === 'image', imgMsg ? '独立 image 消息' : '没发图');

  // 6 /人格 列表
  await bridge.handleEvent(ev({ message: [{ type: 'text', data: { text: '/人格' } }] }));
  check('/人格 列表面板', segText(last()?.segments ?? '').includes('私聊：') && segText(last()?.segments ?? '').includes('傲娇猫娘'), segText(last()?.segments ?? '').split('\n')[0]);

  // 7 /人格 2 → 云端 pet.json 落盘
  await bridge.handleEvent(ev({ message: [{ type: 'text', data: { text: '/人格 2' } }] }));
  {
    const { pet } = await petApi.getPet('main');
    const active = petApi.identify(personas, await petApi.currentPrompt('main'), pet.name);
    check('切换到阿喵且已落盘', active?.id === 'anmiao', `当前=${active?.label ?? '未知'} 名字=${pet.name}`);
    const onDisk = JSON.parse(await readFile(join(tmp, 'data', 'pet.json'), 'utf8'));
    check('pet.json 里 name/prompt 同步更新', onDisk.pet.name === '阿喵' && onDisk.active === 'anmiao', onDisk.pet.name);
  }

  // 8 切换后聊天
  await bridge.handleEvent(ev({ message: [{ type: 'text', data: { text: '你今天怎么样呀' } }] }));
  check('切换人格后仍能聊天', segText(last()?.segments ?? '').length > 0, segText(last()?.segments ?? '').slice(0, 50));

  // 9 /状态 + /记忆
  await bridge.handleEvent(ev({ message: [{ type: 'text', data: { text: '/状态' } }] }));
  check('/状态 返回宠物信息', segText(last()?.segments ?? '').includes('宠物：'), segText(last().segments).split('\n')[0]);
  await bridge.handleEvent(ev({ message: [{ type: 'text', data: { text: '/记忆 3' } }] }));
  check('/记忆 能回放', /你：|她：/.test(segText(last()?.segments ?? '')), segText(last()?.segments ?? '').slice(0, 40));

  // 10 记忆落盘（user+assistant 成对 & 结构兼容桌面端）
  {
    const mem = JSON.parse(await readFile(join(tmp, 'data', 'memory.json'), 'utf8'));
    const list = mem?.main?.main?.messages ?? [];
    const hasPair = list.some((m) => m.role === 'user') && list.some((m) => m.role === 'assistant');
    check('memory.json 结构兼容桌面端', hasPair && typeof list[0].ts === 'number', `${list.length} 条`);
  }

  // 11 /ping
  await bridge.handleEvent(ev({ message: [{ type: 'text', data: { text: '/ping' } }] }));
  check('/ping → pong', segText(last()?.segments ?? '') === 'pong');

  await testAgency();

  // 12 备份服务：起进程 → /health、鉴权、/memory、快照
  await testBackup();
}

/* ----------------------------- 主动性（P1a）自测 ---------------------------- */

async function testAgency() {
  const load = (p) => import(pathToFileURL(join(DIST, 'lib', p)).href);
  const agencyMod = await load('agency.mjs');
  const cmtMod = await load('commitments.mjs');
  const { createScheduler } = await load('scheduler.mjs');

  // 假大脑按提示词分辨三类请求：抽取承诺 / 主动开口 / 兑现承诺
  const tomorrow9 = new Date(Date.now() + 24 * 3_600_000);
  tomorrow9.setHours(9, 0, 0, 0);
  let extractCalls = 0;
  mock.setReplyResolver(({ messages }) => {
    const sys = String(messages.find((m) => m.role === 'system')?.content ?? '');
    const all = messages.map((m) => String(m.content ?? '')).join('\n');
    if (sys.includes('信息抽取器')) {
      // 只让第一轮抽出承诺，第二轮返回空数组（验证「不重复记账」）
      return ++extractCalls === 1 ? JSON.stringify([{ what: '问主人面试结果', when: tomorrow9.toISOString() }]) : '[]';
    }
    if (all.includes('现在没有人在跟你说话')) return JSON.stringify({ think: '他好久没说话了，有点想他', say: '在忙吗？我有点想你了。' });
    if (all.includes('现在到点了，去兑现')) return JSON.stringify({ think: '到点了，该问他面试', say: '面试怎么样呀？我一直记着呢。' });
    return null;
  });

  // 12.2 调度器（注入假时钟，避免依赖真实时间）——必须先接上桥，抽取才发生在 onExchange 里
  let fakeNow = new Date('2026-10-24T21:00:00+08:00');
  const schedConf = {
    ...conf,
    proactive: { ...(conf.proactive || {}), ownerIds: ['20001'], tickSec: 99_999, dryRun: false },
  };
  const scheduler = createScheduler({ conf: schedConf, log: quiet, now: () => fakeNow });
  scheduler.attachSender((conv, payload) => bridge.sendProactive(conv, payload));
  bridge.attachScheduler(scheduler);

  // 12.1 承诺抽取：一句带时间的对话后，commitments.json 里应出现一条 pending
  await bridge.handleEvent(ev({ message: [{ type: 'text', data: { text: '我明天九点面试，你记得问我结果' } }] }));
  await bridge.handleEvent(ev({ message: [{ type: 'text', data: { text: '好呀，明天九点我提醒你，面试加油' } }] }));
  {
    let db = await cmtMod.loadCommitments();
    for (let i = 0; i < 30 && !db.items.length; i++) {
      await new Promise((r) => setTimeout(r, 100));
      db = await cmtMod.loadCommitments();
    }
    const it = db.items[0];
    check('承诺被抽取并落盘', db.items.length >= 1 && /面试/.test(it?.what ?? ''), it ? `${it.what} @ ${it.dueAt}` : '没有抽取到');
    check('承诺时间是明天 9 点', it ? Math.abs(Date.parse(it.dueAt) - tomorrow9.getTime()) < 60_000 : false, it?.dueAt ?? '');
  }

  const setMood = async (patch) => {
    const ag = await agencyMod.loadAgency(fakeNow);
    Object.assign(ag.impulse, { owner: 0 });
    Object.assign(ag, {
      lastTickAt: fakeNow.getTime(),
      lastInboundAt: 0,
      lastProactiveAt: 0,
      awaiting: null,
      pausedUntil: 0,
      misses: 0,
    });
    ag.counters = { day: '2026-10-24', ownerSent: 0 };
    Object.assign(ag.impulse, patch.impulse ?? {});
    await agencyMod.saveAgency(ag);
    return ag;
  };

  // 12.3 首个 tick 只观察（boot-warmup），第二个 tick 才可能发
  await setMood({ impulse: { owner: 100 } });
  let n = sent.length;
  await scheduler.tick();
  check('启动后第一个 tick 不发送（warmup）', sent.length === n);

  await setMood({ impulse: { owner: 100 } });
  n = sent.length;
  await scheduler.tick();
  const proactive = sent[sent.length - 1];
  check(
    '冲动够高时主动私聊开口',
    sent.length === n + 1 && proactive.to === 'private:20001' && segText(proactive.segments).includes('想你'),
    segText(proactive?.segments ?? ''),
  );
  {
    const ag = await agencyMod.loadAgency(fakeNow);
    check('发出后扣冲动、计次、留回应窗口', ag.impulse.owner < 100 && ag.counters.ownerSent === 1 && !!ag.awaiting, `冲动=${Math.round(ag.impulse.owner)}`);
  }

  // 12.4 静默时段不发
  fakeNow = new Date('2026-10-25T02:00:00+08:00');
  await setMood({ impulse: { owner: 100 } });
  n = sent.length;
  await scheduler.tick();
  check('静默时段（23:30–07:30）不主动', sent.length === n);

  // 12.5 承诺到点兑现（优先级高于冲动，冲动为 0 也要发）
  fakeNow = new Date('2026-10-25T21:00:00+08:00');
  await setMood({ impulse: { owner: 0 } });
  const cmt = await cmtMod.addCommitment({
    what: '问主人面试结果',
    dueAt: new Date(fakeNow.getTime() + 5 * 60_000).toISOString(),
    conv: 'private:20001',
  });
  n = sent.length;
  await scheduler.tick();
  const reminder = sent[sent.length - 1];
  check(
    '承诺到点自动兑现（不占冲动）',
    sent.length === n + 1 && segText(reminder.segments).includes('面试'),
    segText(reminder?.segments ?? ''),
  );
  {
    const db = await cmtMod.loadCommitments();
    const after = db.items.find((x) => x.id === cmt.id);
    check('兑现后标 done', after?.status === 'done', after?.status ?? '?');
  }

  // 12.6 /安静 之后即使冲动爆表也不发；/说话 恢复
  await bridge.handleEvent(ev({ message: [{ type: 'text', data: { text: '/安静 1' } }] }));
  check('/安静 返回确认', segText(last()?.segments ?? '').includes('安静'));
  fakeNow = new Date('2026-10-25T21:30:00+08:00');
  {
    const ag = await agencyMod.loadAgency(fakeNow);
    ag.impulse.owner = 110;
    ag.lastTickAt = fakeNow.getTime();
    ag.lastProactiveAt = 0;
    ag.lastInboundAt = 0;
    ag.counters = { day: '2026-10-25', ownerSent: 0 };
    await agencyMod.saveAgency(ag);
  }
  n = sent.length;
  await scheduler.tick();
  check('暂停期间不发主动消息', sent.length === n);

  await bridge.handleEvent(ev({ message: [{ type: 'text', data: { text: '/说话' } }] }));
  check('/说话 解除暂停', segText(last()?.segments ?? '').includes('可以主动'));

  // 12.7 /心思 与 /承诺 面板
  await bridge.handleEvent(ev({ message: [{ type: 'text', data: { text: '/心思' } }] }));
  check('/心思 面板可读', segText(last()?.segments ?? '').includes('冲动：'), segText(last()?.segments ?? '').split('\n')[1] ?? '');
  await bridge.handleEvent(ev({ message: [{ type: 'text', data: { text: '/承诺' } }] }));
  check('/承诺 面板可读', segText(last()?.segments ?? '').length > 0, segText(last()?.segments ?? '').slice(0, 40));

  // 12.8 冷落计数：主动消息 2 小时没人回 → misses+1
  fakeNow = new Date('2026-10-25T23:40:00+08:00');
  {
    const ag = await agencyMod.loadAgency(fakeNow);
    ag.awaiting = { at: fakeNow.getTime() - 3 * 3_600_000, conv: 'private:20001', text: '在忙吗' };
    ag.misses = 0;
    await agencyMod.saveAgency(ag);
  }
  await scheduler.tick();
  {
    const ag = await agencyMod.loadAgency(fakeNow);
    check('主动消息无人回应记一次冷落', ag.misses === 1 && ag.awaiting === null, `misses=${ag.misses}`);
  }
}

async function testBackup() {
  const port = 3020 + Math.floor(Math.random() * 200);
  const token = 'selftest-token';
  const child = await import('node:child_process').then((m) =>
    m.spawn(process.execPath, [join(DIST, 'backup-server.mjs')], {
      env: { ...process.env, BACKUP_PORT: String(port), BACKUP_TOKEN: token, BACKUP_HOST: '127.0.0.1' },
      stdio: 'ignore',
    }),
  );
  const base = `http://127.0.0.1:${port}`;
  const wait = async (fn, ms = 8000) => {
    const t0 = Date.now();
    for (;;) {
      try {
        return await fn();
      } catch (e) {
        if (Date.now() - t0 > ms) throw e;
        await new Promise((r) => setTimeout(r, 150));
      }
    }
  };
  try {
    const health = await wait(async () => (await fetch(base + '/health')).json());
    check('备份服务 /health 免鉴权', health.ok === true);

    const noAuth = await fetch(base + '/memory');
    check('备份服务未授权返回 401', noAuth.status === 401);

    const mem = await fetch(base + '/memory', { headers: { 'x-backup-token': token } });
    check('带 token 能拉到记忆', mem.ok && (await mem.text()).includes('messages'));

    const snap = await fetch(base + '/snapshot', { method: 'POST', headers: { 'x-backup-token': token } }).then((r) => r.json());
    check('打快照成功', snap.ok === true && /^memory-\d{8}-\d{6}\.json$/.test(snap.name ?? ''), snap.name);

    const list = await fetch(base + '/backups', { headers: { 'x-backup-token': token } }).then((r) => r.json());
    check('快照清单可读', Array.isArray(list.backups) && list.backups.length >= 1, `${list.backups?.length ?? 0} 份`);
  } finally {
    child.kill();
  }
}

try {
  await main();
} finally {
  await mock.close().catch(() => {});
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} 通过`);
if (passed !== results.length) process.exitCode = 1;
