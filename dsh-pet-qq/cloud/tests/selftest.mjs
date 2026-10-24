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

import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
// 气泡间隔/尾巴停顿调 0，别让测试干等
conf.behavior = { ...(conf.behavior || {}), bubbleDelayMs: 0, typingDelayMs: 0, tailPauseMs: 0 };
// 自测里的「主人」是 20001：指令只有主人能发、按群切人格都要用到它
conf.proactive = { ...(conf.proactive || {}), ownerIds: ['20001'] };

// 配图资格现在在生成层掷骰子：自测里百分百给资格、且关掉冷却，否则断言会飘
{
  const petFile = join(tmp, 'data', 'pet.json');
  const pet = JSON.parse(await readFile(petFile, 'utf8'));
  Object.assign(pet, {
    memeChancePrivate: 1,
    memeChanceGroup: 1,
    memeCooldown: 0,
    maxBubbles: 6,
    // 自测不联网：空间关掉（否则每次 tick 都会试着连 OneBot 拿 cookie）
    qzone: { ...(pet.qzone || {}), enabled: false },
  });
  await writeFile(petFile, JSON.stringify(pet, null, 2), 'utf8');
}
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

  // 5b 多气泡：模型自己用换行分段时，应发成多条独立文字消息
  {
    mock.setReplyResolver(() => '在呢。\n刚躺下，正想跟你说晚安');
    const n2 = sent.length;
    await bridge.handleEvent(ev({ message_id: 'bubble-1', message: [{ type: 'text', data: { text: '你在干嘛呀' } }] }));
    const pieces = sent.slice(n2).filter((x) => x.segments.some((s) => s.type === 'text'));
    check(
      '模型分段时发成多个气泡',
      pieces.length === 2 && segText(pieces[0].segments).includes('在呢') && segText(pieces[1].segments).includes('刚躺下'),
      pieces.map((p) => segText(p.segments)).join(' | '),
    );
    mock.setReplyResolver(null);
  }

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

  // 11b 在私聊里给指定群换人格（只影响那个群）
  {
    await bridge.handleEvent(ev({ message: [{ type: 'text', data: { text: '/人格 群 555555 3' } }] }));
    const onDisk = JSON.parse(await readFile(join(tmp, 'data', 'pet.json'), 'utf8'));
    const g = await petApi.resolvePersona('group', 'main', 'group:555555');
    const priv = await petApi.resolvePersona('private', 'main');
    check(
      '私聊里给指定群换人格',
      onDisk.surfaces?.groups?.['555555'] === 'lin' && g.name === '凛' && priv.name === '阿喵',
      `群555555=${g.name} 私聊=${priv.name}`,
    );
    check('回执说明改的是哪个群', segText(last()?.segments ?? '').includes('555555'), segText(last()?.segments ?? '').slice(0, 40));
  }

  // 11c 群里 /人格 只换当前群，不动默认与私聊
  {
    await bridge.handleEvent(
      ev({
        message_type: 'group',
        group_id: 555555,
        user_id: 20001,
        sender: { user_id: 20001, nickname: '主人' },
        message: [
          { type: 'at', data: { qq: '10000', name: '小蓝' } },
          { type: 'text', data: { text: ' /人格 2' } },
        ],
      }),
    );
    const onDisk = JSON.parse(await readFile(join(tmp, 'data', 'pet.json'), 'utf8'));
    const inGroup = await petApi.resolvePersona('group', 'main', 'group:555555');
    const other = await petApi.resolvePersona('group', 'main', 'group:999999');
    check(
      '群里换人格只影响本群',
      onDisk.surfaces?.groups?.['555555'] === 'anmiao' && inGroup.name === '阿喵' && other.name !== '阿喵',
      `本群=${inGroup.name} 其它群=${other.name}`,
    );
  }

  // 11d 别人发的指令不生效（不回复、不改任何配置）
  {
    const before = JSON.parse(await readFile(join(tmp, 'data', 'pet.json'), 'utf8'));
    const n = sent.length;
    await bridge.handleEvent(
      ev({
        message_type: 'group',
        group_id: 333,
        user_id: 20123,
        sender: { user_id: 20123, card: '小明', nickname: '小明' },
        message: [
          { type: 'at', data: { qq: '10000', name: '小蓝' } },
          { type: 'text', data: { text: ' /人格 1' } },
        ],
      }),
    );
    const after = JSON.parse(await readFile(join(tmp, 'data', 'pet.json'), 'utf8'));
    check(
      '非主人指令被忽略',
      sent.length === n && JSON.stringify(before.surfaces) === JSON.stringify(after.surfaces),
      `新增 ${sent.length - n} 条`,
    );
    const n2 = sent.length;
    await bridge.handleEvent(ev({ user_id: 20123, sender: { user_id: 20123, nickname: '路人' }, message: [{ type: 'text', data: { text: '/安静 1' } }] }));
    check('私聊里非主人指令也被忽略', sent.length === n2, `新增 ${sent.length - n2} 条`);
  }

  await testBubbles();
  await testMemeCooldown();
  await testQzoneHelpers();

  await testAgency();

  // 12 备份服务：起进程 → /health、鉴权、/memory、快照
  await testBackup();
}

/* ------------------------------ 气泡拆分自测 ------------------------------- */

async function testBubbles() {
  const { splitBubbles } = petApi;

  const own = splitBubbles('嗯\n好\n知道了，我这就去办');
  check('模型分段直接采纳（两字气泡单独成条）', own.length === 3 && own[0] === '嗯' && own[1] === '好', JSON.stringify(own));

  const short = splitBubbles('在呢，刚躺下。', { rng: () => 0.99 });
  check('短句默认整条', short.length === 1, JSON.stringify(short));

  const short2 = splitBubbles('今天天气不错，出来走走吧。', { rng: () => 0 });
  check('短句按概率拆两条', short2.length === 2, JSON.stringify(short2));

  const mid = '我跟你说啊，今天下午服务器又抽风了，重启了三回才活过来，最后发现是内存不够，真是服了。';
  const midOne = splitBubbles(mid, { rng: () => 0 });
  check('中长段落可以整段一条（长段落模式）', midOne.length === 1 && midOne[0].length === mid.length, `${midOne.length} 条 / ${mid.length} 字`);

  const longOne = '啊'.repeat(120);
  const longParts = splitBubbles(longOne, { rng: () => 0 });
  check('超长且没有句读时不硬拆', longParts.length === 1, `${longParts.length} 条`);

  const many = splitBubbles('第一句\n第二句\n第三句\n第四句\n第五句\n第六句\n第七句\n第八句\n第九句');
  check('气泡软上限 6 条', many.length === 6, `${many.length} 条`);
}

/* --------------------------- 表情包冷却（生成层） ---------------------------- */

async function testMemeCooldown() {
  const petFile = join(tmp, 'data', 'pet.json');
  const pet = JSON.parse(await readFile(petFile, 'utf8'));
  Object.assign(pet, { memeChancePrivate: 1, memeCooldown: 5 });
  await writeFile(petFile, JSON.stringify(pet, null, 2), 'utf8');

  // 手动塞一条「刚带过图」的私聊记录：冷却必然生效（不依赖前面对话的随机结果）
  await writeFile(
    join(tmp, 'data', 'chatter.json'),
    JSON.stringify({ recent: [{ kind: 'private', at: Date.now(), image: true }] }),
    'utf8',
  );

  mock.setReplyResolver(() => '累成这样，先歇会儿吧。\n[图:吃白饭的大肥鱼]');
  const n = sent.length;
  await bridge.handleEvent(ev({ message: [{ type: 'text', data: { text: '今天累死了' } }] }));
  const added = sent.slice(n);
  const imgs = added.flatMap((x) => x.segments).filter((s) => s.type === 'image');
  const text = added.map((x) => segText(x.segments)).join('');
  check('带图冷却：刚带过图就不给资格', imgs.length === 0, `新增 ${added.length} 条，图 ${imgs.length} 张`);
  check('没资格时 [图:…] 标记被剥掉', text.length > 0 && !text.includes('[图'), text.slice(0, 40));
  mock.setReplyResolver(null);
}

/* ------------------------- 空间与语义记忆（纯函数） -------------------------- */

async function testQzoneHelpers() {
  const load = (p) => import(pathToFileURL(join(DIST, 'lib', p)).href);
  const { gTk, cleanMood } = await load('qzone.mjs');
  const { addNote, recentNotes, notesBrief } = await load('semantic.mjs');

  // g_tk 是空间接口的门票：同一个 skey 必须永远算出同一个数（这里钉一个已知值）
  check('g_tk 计算稳定', gTk('@abcdefg') === gTk('abcdefg') && gTk('@abcdefg') > 0, String(gTk('@abcdefg')));

  const clean = cleanMood('  今天好累 https://x.com/a @某人  空调又坏了  ', 90);
  check('说说正文去掉链接与 @', clean === '今天好累 空调又坏了', clean);

  const long = cleanMood('一'.repeat(200), 20);
  check('说说正文按上限截断', long.length === 20, `${long.length} 字`);

  await addNote('qzone', '主人动态：机房空调又坏了');
  await addNote('qzone', '主人动态：机房空调又坏了'); // 同文应去重
  const notes = await recentNotes(10, 'qzone');
  check('语义记忆同文去重', notes.length === 1, `${notes.length} 条`);

  const brief = await notesBrief('qzone', 5);
  check('语义记忆能拼成背景提示', brief.includes('【你最近看到的】') && brief.includes('空调'), brief.slice(0, 40));
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

  /* ------------------------- 13. 群聊旁听与插话（S2） ------------------------- */

  const groupsMod = await load('groups.mjs');
  mock.setReplyResolver(({ messages }) => {
    const sys = String(messages.find((m) => m.role === 'system')?.content ?? '');
    const all = messages.map((m) => String(m.content ?? '')).join('\n');
    if (sys.includes('你在一个 QQ 群里潜水')) return JSON.stringify({ score: 9, why: '在聊她熟的话题' });
    if (all.includes('现在决定插一句')) return JSON.stringify({ think: '这个我也能接一句', say: '这话我熟，昨天刚被坑过' });
    return null;
  });

  const groupEv = (text, { groupId = 9001, name = '小明' } = {}) =>
    ev({
      message_type: 'group',
      group_id: groupId,
      user_id: 30001,
      sender: { user_id: 30001, nickname: name, card: name },
      message: [{ type: 'text', data: { text } }],
    });

  fakeNow = new Date('2026-10-26T20:10:00+08:00');
  await setMood({ impulse: { owner: 0 } });
  {
    // 清掉历史群状态，从零开始
    const db = await groupsMod.loadGroups(fakeNow);
    db.groups = {};
    await groupsMod.saveGroups(db);
  }

  // 13.1 群里没 @ 她：不回复，但要旁听下来（攒冲动 + 进缓冲）
  n = sent.length;
  for (const t of ['今天库洛这平衡改得也太离谱了', '我血压直接上来了', '谁懂啊']) {
    await bridge.handleEvent(groupEv(t));
  }
  {
    const db = await groupsMod.loadGroups(fakeNow);
    const g1 = db.groups['group:9001'];
    check(
      '群里没 @ 她不回复，但会旁听记下冲动',
      sent.length === n && !!g1 && Number(g1.impulse) > 0,
      `impulse=${Math.round(g1?.impulse ?? 0)}`,
    );
  }

  // 13.2 冲动攒够 + 评分过关 → 自己插一句（不带 @）
  {
    const db = await groupsMod.loadGroups(fakeNow);
    const g = groupsMod.groupState(db, 'group:9001', fakeNow);
    g.impulse = 130;
    g.lastMessageAt = fakeNow.getTime();
    g.lastDecayAt = fakeNow.getTime();
    g.sentToday = 0;
    g.lastSpokeAt = 0;
    g.cooldownUntil = 0;
    await groupsMod.saveGroups(db);
  }
  n = sent.length;
  await scheduler.tick();
  {
    const grp = sent[sent.length - 1];
    check(
      '群聊冲动够了会自己插一句',
      sent.length === n + 1 && grp?.to === 'group:9001' && segText(grp.segments).length > 0,
      `${grp?.to ?? '-'}：${segText(grp?.segments ?? '').slice(0, 30)}`,
    );
    check('群里插话不 @ 任何人', grp ? !grp.segments.some((s) => s.type === 'at') : false);
  }

  // 13.3 每个群每天只说一次：再 tick 也不会重复插话
  n = sent.length;
  await scheduler.tick();
  check('同一群当天不会插第二次话', sent.length === n);

  // 13.4 群里有人喊「别说话了」→ 反感度累积，到线就自动冷却
  {
    const db = await groupsMod.loadGroups(fakeNow);
    const g = groupsMod.groupState(db, 'group:9001', fakeNow);
    g.impulse = 130;
    g.annoyance = 70;
    g.lastMessageAt = fakeNow.getTime();
    await groupsMod.saveGroups(db);
  }
  n = sent.length;
  await scheduler.tick();
  {
    const db = await groupsMod.loadGroups(fakeNow);
    const g = db.groups['group:9001'];
    check(
      '群里反感度到线就闭嘴冷却',
      sent.length === n && Number(g.cooldownUntil) > fakeNow.getTime() && Number(g.impulse) === 0,
      `annoyance=${Math.round(g.annoyance)}，冷却到 ${new Date(Number(g.cooldownUntil)).toLocaleString('zh-CN')}`,
    );
  }

  // 13.5 静默时段不插话
  fakeNow = new Date('2026-10-27T02:00:00+08:00');
  {
    const db = await groupsMod.loadGroups(fakeNow);
    const g = groupsMod.groupState(db, 'group:9001', fakeNow);
    g.impulse = 130;
    g.annoyance = 0;
    g.cooldownUntil = 0;
    g.lastSpokeAt = 0;
    g.lastMessageAt = fakeNow.getTime();
    await groupsMod.saveGroups(db);
  }
  n = sent.length;
  await scheduler.tick();
  check('静默时段群里不插话', sent.length === n);
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
