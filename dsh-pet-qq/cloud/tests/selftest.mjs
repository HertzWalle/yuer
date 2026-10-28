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
import { request } from 'node:http';
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
/** 从 dist/lib 里加载一个模块（自测直接用云端实现，测的就是会上线的那份代码） */
const load = (p) => import(pathToFileURL(join(DIST, 'lib', p)).href);

const conf = JSON.parse(await readFile(join(DIST, 'bridge.config.json'), 'utf8'));
// 气泡间隔/尾巴停顿/连发合并都调 0，别让测试干等（语音在自测里关掉：edge-tts 不一定装了）
conf.behavior = {
  ...(conf.behavior || {}),
  bubbleDelayMs: 0,
  typingDelayMs: 0,
  tailPauseMs: 0,
  coalesceMs: 0,
  voice: { ...(conf.behavior?.voice || {}), enabled: false },
};
// 自测里的「主人」是 20001：指令只有主人能发、按群切人格都要用到它
conf.proactive = { ...(conf.proactive || {}), ownerIds: ['20001', '1360153202'] };

// 配图资格现在在生成层掷骰子：自测里百分百给资格、且关掉冷却，否则断言会飘
{
  const petFile = join(tmp, 'data', 'pet.json');
  const pet = JSON.parse(await readFile(petFile, 'utf8'));
  Object.assign(pet, {
    memeChancePrivate: 1,
    memeChanceGroup: 1,
    memeCooldown: 0,
    maxBubbles: 6,
    // 自测不联网：空间与 B站/抖音都关掉（否则每次 tick 都会真去抓）
    qzone: { ...(pet.qzone || {}), enabled: false },
    feeds: { ...(pet.feeds || {}), enabled: false },
  });
  await writeFile(petFile, JSON.stringify(pet, null, 2), 'utf8');
}
const personas = await petApi.loadPersonas(join(DIST, 'personas.json'));

const sent = [];
const quoted = new Map(); // 被引用消息 id → { sender, message }，供假 get_msg 查
const members = new Map(); // `${groupId}:${userId}` → { card, nickname }，供假 get_group_member_info 查
const calls = [];
const transport = {
  async send(msg, segments) {
    sent.push({ to: `${msg.kind}:${msg.groupId ?? msg.senderId}`, segments });
    return { message_id: sent.length };
  },
  async call(action, params) {
    calls.push({ action, params });
    if (action === 'get_group_member_info') {
      const hit = members.get(`${params.group_id}:${params.user_id}`);
      if (!hit) throw new Error('群成员不存在');
      return { group_id: params.group_id, user_id: params.user_id, ...hit };
    }
    if (action !== 'get_msg') throw new Error(`假 transport 不支持 ${action}`);
    const hit = quoted.get(String(params.message_id));
    if (!hit) throw new Error('消息不存在');
    return { message_id: params.message_id, sender: hit.sender, message: hit.message };
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

  // 5c 引用回复：别人引用她说过的话再问一句，她要接得上，回的时候也带引用
  {
    quoted.set('900', {
      sender: { user_id: 10000, nickname: '小蓝' },
      message: [{ type: 'text', data: { text: '你行你上啊' } }],
    });
    const n2 = sent.length;
    await bridge.handleEvent(
      ev({
        message_type: 'group',
        group_id: 333,
        message_id: 'quote-1',
        user_id: 20123,
        sender: { user_id: 20123, card: '小明', nickname: '小明' },
        message: [
          { type: 'reply', data: { id: '900' } },
          { type: 'at', data: { qq: '10000', name: '小蓝' } },
          { type: 'text', data: { text: ' 我真能上吗' } },
        ],
      }),
    );
    const after = sent.slice(n2);
    const joined = after.map((x) => segText(x.segments)).join(' ');
    check(
      '被引用时把原话喂给模型',
      joined.includes('引用了你自己刚才说的话') && joined.includes('你行你上啊'),
      joined.slice(0, 80),
    );
    check(
      '回复带上被回复消息的引用',
      after[0]?.segments?.[0]?.type === 'reply' && String(after[0].segments[0].data?.id) === 'quote-1',
      JSON.stringify(after[0]?.segments?.[0] ?? null),
    );
    check(
      '同一条被引消息只查一次 get_msg',
      calls.filter((c) => c.action === 'get_msg' && String(c.params.message_id) === '900').length === 1,
      `${calls.filter((c) => c.action === 'get_msg').length} 次`,
    );

    // 私聊里引用别人说的话：同样接得住，并引用回去
    quoted.set('901', {
      sender: { user_id: 20001, nickname: '主人' },
      message: [{ type: 'text', data: { text: '周末要不要出去走走' } }],
    });
    const n3 = sent.length;
    await bridge.handleEvent(
      ev({
        message_id: 'quote-2',
        message: [
          { type: 'reply', data: { id: '901' } },
          { type: 'text', data: { text: '你刚才那个建议还作数吗' } },
        ],
      }),
    );
    const priv = sent.slice(n3);
    check(
      '私聊引用也能接住并引用回',
      priv.map((x) => segText(x.segments)).join(' ').includes('引用了主人') &&
        priv[0]?.segments?.[0]?.type === 'reply',
      priv.map((x) => segText(x.segments)).join(' ').slice(0, 60),
    );
  }

  // 5d 群里只引用她的话、没有 @：也算在跟她说话（QQ 里引用一般不带 @）
  {
    quoted.set('902', {
      sender: { user_id: 10000, nickname: '小蓝' },
      message: [{ type: 'text', data: { text: '机房空调又坏了' } }],
    });
    const n4 = sent.length;
    await bridge.handleEvent(
      ev({
        message_type: 'group',
        group_id: 333,
        message_id: 'quote-3',
        user_id: 20123,
        sender: { user_id: 20123, card: '小明', nickname: '小明' },
        message: [
          { type: 'reply', data: { id: '902' } },
          { type: 'text', data: { text: '那你不去修？' } },
        ],
      }),
    );
    const got = sent.slice(n4);
    check(
      '群里只引用她的话也会回（不用 @）',
      got.length > 0 && got.map((x) => segText(x.segments)).join(' ').includes('机房空调'),
      got.map((x) => segText(x.segments)).join(' ').slice(0, 60) || '没回',
    );
    check(
      '这种回复也带引用',
      got[0]?.segments?.[0]?.type === 'reply' && String(got[0].segments[0].data?.id) === 'quote-3',
      JSON.stringify(got[0]?.segments?.[0] ?? null),
    );
  }

  // 5e 群里的称呼：群友用群昵称、@QQ号换成群昵称、别把群友叫主人
  {
    members.set('888888:1360153202', { card: 'HudsonZephyr', nickname: '主号' });
    members.set('888888:30001', { card: '搬砖king', nickname: '搬砖' });
    const n5 = sent.length;
    const before = mock.calls.length;
    await bridge.handleEvent(
      ev({
        message_type: 'group',
        group_id: 888888,
        message_id: 'at-1',
        user_id: 30001,
        // 事件里故意不给 card：必须靠 get_group_member_info 拿群昵称
        sender: { user_id: 30001, nickname: '搬砖' },
        message: [
          { type: 'at', data: { qq: '10000' } },
          { type: 'text', data: { text: ' 锐评一下 ' } },
          { type: 'at', data: { qq: '1360153202' } },
        ],
      }),
    );
    const seenUser = String(
      [...(mock.calls.at(-1)?.messages ?? [])].reverse().find((m) => m.role === 'user')?.content ?? '',
    );
    check(
      '群友的 @QQ号 换成群昵称',
      seenUser.includes('@HudsonZephyr') && !seenUser.includes('@1360153202'),
      seenUser.split('\n').slice(-1)[0].slice(0, 60),
    );
    check(
      '群聊说清「你是群友、不是主人」',
      seenUser.includes('群友「搬砖king」') && seenUser.includes('不是主人') && seenUser.includes('主人是群里的「HudsonZephyr」'),
      seenUser.split('\n')[0].slice(0, 80),
    );
    check('群友不会被标成主人', !seenUser.includes('搬砖king·主人') && sent.length > n5, `新增 ${sent.length - n5} 条`);

    // 主人本人说话：明确标主人
    const n6 = sent.length;
    const b6 = mock.calls.length;
    await bridge.handleEvent(
      ev({
        message_type: 'group',
        group_id: 888888,
        message_id: 'at-2',
        user_id: 1360153202,
        sender: { user_id: 1360153202, card: 'HudsonZephyr' },
        message: [
          { type: 'at', data: { qq: '10000' } },
          { type: 'text', data: { text: ' 在吗' } },
        ],
      }),
    );
    const ownerSeen = String(
      [...(mock.calls.at(-1)?.messages ?? [])].reverse().find((m) => m.role === 'user')?.content ?? '',
    );
    check(
      '主人说话时标明是主人',
      ownerSeen.includes('主人本人') && ownerSeen.includes('HudsonZephyr') && sent.length > n6,
      ownerSeen.split('\n')[0].slice(0, 60),
    );
    void before;
    void b6;
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
  await testVisionAndActions();
  await testMemeCooldown();
  await testPersonaMark();
  await testQzoneHelpers();
  await testFeeds();
  await testSemanticMemory();
  await testMemoryManager();
  await testInternalMarks();
  await testRules();
  await testProfiles();
  await testUsage();
  await testCoalesce();
  await testFollowUp();
  await testVoiceGate();

  await testAgency();

  // 12 备份服务：起进程 → /health、鉴权、/memory、快照
  await testBackup();

  // 13 S4：/turn 契约
  await testTurnServer();
}

/* --------------------------- S3：B 站/抖音解析自测 -------------------------- */

async function testFeeds() {
  const { parseBiliPopular, parseDouyinHot, biliNote, douyinNote, humanCount } = await load('feeds.mjs');

  const bili = parseBiliPopular(
    {
      code: 0,
      data: {
        list: [
          {
            bvid: 'BV1xx411c7mD',
            title: '【硬核】三分钟讲明白缓存击穿',
            short_link_v2: 'https://b23.tv/abc123',
            owner: { name: '老码农' },
            tname: '科技',
            stat: { view: 123456 },
          },
        ],
      },
    },
    { limit: 5 },
  );
  check('B 站热门解析', bili.length === 1 && bili[0].title.includes('缓存击穿') && bili[0].view === 123456, bili[0]?.url);

  const douyin = parseDouyinHot({ data: [{ title: '某地暴雨', hot_value: 9876543, link: 'https://x/1' }] }, { limit: 3 });
  check('抖音热搜解析', douyin.length === 1 && douyin[0].hot === 9876543, JSON.stringify(douyin[0]));

  check('播放量缩写', humanCount(23456) === '2.3万' && humanCount(123456789) === '1.2亿', humanCount(23456));
  const n1 = biliNote(bili[0]);
  const n2 = douyinNote(douyin[0]);
  check(
    'B 站/抖音的语义记忆文案',
    n1.startsWith('B站热门：') && n1.includes('UP：老码农') && n2.startsWith('抖音热搜：') && n2.includes('987.7万'),
    `${n1} ｜ ${n2}`,
  );
}

/* ------------------------- S5：语义记忆 检索/遗忘 自测 ---------------------- */

async function testSemanticMemory() {
  const { addNote, recall, forget, recentNotes } = await load('semantic.mjs');
  await addNote('qzone', '主人动态：今天在机房焊了一晚上服务器', { importance: 0.7 });
  await addNote('bilibili', 'B站热门：猫咪把键盘踩坏了', { importance: 0.3 });

  const hit = await recall('服务器又抽风了', { n: 3 });
  check('语义记忆能按关键词想起来', hit.length >= 1 && hit[0].text.includes('服务器'), JSON.stringify(hit.map((h) => h.text)));

  const removed = await forget('焊了一晚上');
  const left = await recentNotes(10);
  check('忘记关键词能删掉对应记忆', removed === 1 && !left.some((n) => n.text.includes('焊了一晚上')), `删了 ${removed} 条`);
}

/* ---------------------- S5：分层记忆压缩（manageHistory） -------------------- */

async function testMemoryManager() {
  const { manageHistory, MEM_DEFAULTS } = await load('memory-manager.mjs');
  const bucket = 'main@memorytest';
  const messages = [];
  for (let i = 0; i < 24; i++) {
    messages.push({ role: 'user', content: `第${i}轮：主人说他在改一个很长很长的 bug，编号 ${i}。`, at: Date.now() + i * 1000 });
    messages.push({ role: 'assistant', content: `第${i}轮：我陪他骂了两句这破 bug，然后让他先喝水。`, at: Date.now() + i * 1000 + 1 });
  }
  const res = await manageHistory({
    bucket,
    messages,
    conf: { memory: { ...MEM_DEFAULTS, maxHistoryTokens: 260 } },
    now: Date.now(),
  });
  const summaryFile = join(tmp, 'data', 'summaries', `${bucket}.json`);
  const saved = existsSync(summaryFile) ? JSON.parse(await readFile(summaryFile, 'utf8')) : null;
  check(
    '历史太长会压成摘要并落盘',
    res.compressed && Boolean(saved?.summary) && res.messages.length < messages.length,
    `保留 ${res.messages.length}/${messages.length} 条，摘要 ${saved?.summary?.length ?? 0} 字`,
  );
  check(
    '摘要以一对消息注入，后面接最近的轮次',
    res.messages[0]?.role === 'user' && /摘要/.test(res.messages[0]?.content ?? '') && res.messages[1]?.role === 'assistant',
    res.messages[0]?.content?.slice(0, 30),
  );

  // 再跑一次：应该复用已落盘的摘要，而不是重新从零开始
  const again = await manageHistory({ bucket, messages: messages.slice(-4), conf: { memory: { ...MEM_DEFAULTS, maxHistoryTokens: 260 } } });
  check('摘要会被复用（重启不丢记忆）', again.messages[0]?.role === 'user' && /摘要/.test(again.messages[0]?.content ?? ''), 'ok');
}

/* --------------------------- S4：/turn 契约 自测 --------------------------- */

/** 本机回环 HTTP（undici 的 fetch 在 Windows 上会绑 0.0.0.0 导致 EADDRNOTAVAIL，这里显式绑回环） */
function httpJson(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = request(
      { host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers, localAddress: '127.0.0.1' },
      (res) => {
        let b = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (b += c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(b);
          } catch {
            /* 非 JSON 就留 null，断言会失败 */
          }
          resolve({ status: res.statusCode, json, text: b });
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function testTurnServer() {
  const { createTurnServer } = await load('turn-server.mjs');
  const srv = await createTurnServer({ host: '127.0.0.1', port: 0, token: 'turn-test-token' });
  const base = `http://127.0.0.1:${srv.port}`;
  try {
    const health = await httpJson(`${base}/health`);
    check('/turn 健康检查免鉴权', health.json?.ok === true && health.json?.app === 'yuer-turn', `v${health.json?.version}`);

    const noauth = await httpJson(`${base}/turn`, { method: 'POST', body: '{}' });
    check('/turn 无 token 拒绝', noauth.status === 401, String(noauth.status));

    const res = await httpJson(`${base}/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-turn-token': 'turn-test-token' },
      body: JSON.stringify({ conv: 'private:20001', user: { id: 20001, name: '主人' }, text: '在吗' }),
    });
    check(
      '/turn 返回气泡数组',
      res.status === 200 && res.json?.ok === true && Array.isArray(res.json?.segments) && res.json.segments.length >= 1,
      `${res.json?.segments?.length} 段：${res.json?.segments?.[0]}`,
    );

    const empty = await httpJson(`${base}/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-turn-token': 'turn-test-token' },
      body: JSON.stringify({ conv: 'private:20001', text: '   ' }),
    });
    check('/turn 空文本返回 400', empty.status === 400, String(empty.status));
  } finally {
    await srv.close();
  }
}

/* ------------------------------ 气泡拆分自测 ------------------------------- */

async function testBubbles() {
  const { splitBubbles } = petApi;

  const own = splitBubbles('嗯\n好\n知道了，我这就去办');
  check('模型分段直接采纳（两字气泡单独成条）', own.length === 3 && own[0] === '嗯' && own[1] === '好', JSON.stringify(own));

  const short = splitBubbles('在呢，刚躺下。', { rng: () => 0.99 });
  check('短句默认整条', short.length === 1, JSON.stringify(short));

  const short2 = splitBubbles('今天天气不错，出来走走吧。', { rng: () => 0 });
  check('短句一律不拆（哪怕掷到 0）', short2.length === 1, JSON.stringify(short2));

  const mid = '我跟你说啊，今天下午服务器又抽风了，重启了三回才活过来，最后发现是内存不够，真是服了。';
  const midOne = splitBubbles(mid, { rng: () => 0.99 });
  check('中长段落默认整段一条', midOne.length === 1 && midOne[0].length === mid.length, `${midOne.length} 条 / ${mid.length} 字`);
  const midTwo = splitBubbles(mid, { rng: () => 0 });
  check(
    '中长段落偶尔拆两条，且两边都是完整句子',
    midTwo.length === 2 && midTwo.every((x) => x.length >= 6) && !midTwo[0].endsWith('，'),
    JSON.stringify(midTwo),
  );

  // 回归：不能把词切开（之前「稻穗」被切成「稻」「穗」）
  const wordCut = splitBubbles('群里表情包都认全了。 稻穗加这脸，除了黍还能是谁。', { rng: () => 0 });
  check('不会把词切成两半', wordCut.length === 1 && wordCut[0].includes('稻穗'), JSON.stringify(wordCut));

  const longOne = '啊'.repeat(120);
  const longParts = splitBubbles(longOne, { rng: () => 0 });
  check('超长且没有句读时不硬拆', longParts.length === 1, `${longParts.length} 条`);

  const many = splitBubbles('第一句\n第二句\n第三句\n第四句\n第五句\n第六句\n第七句\n第八句\n第九句');
  check('气泡软上限 3 条', many.length === 3, `${many.length} 条`);

  // 纯动作的短句不该单独成条（模型偶尔会这样）
  const { tidyBubbles } = petApi;
  const tidied = tidyBubbles(['主人你回来啦。', '（尾巴摇成螺旋桨）', '（耳朵抖了抖）', '饭饭呢？']);
  check(
    '纯动作并到上一条、开头动作丢弃',
    tidied.length === 2 && tidied[0].includes('尾巴摇成螺旋桨') && tidied[1] === '饭饭呢？',
    JSON.stringify(tidied),
  );
}

/* --------------------- 看图 + 去掉括号动作（m05662 两条需求） --------------------- */

async function testVisionAndActions() {
  const { stripActionNotes } = petApi;

  const stripped = stripActionNotes('主人你回来啦（尾巴摇成螺旋桨）');
  check('括号动作被抹掉', stripped === '主人你回来啦', JSON.stringify(stripped));
  const keep = stripActionNotes('这是（DeepSeek）的模型');
  check('专有名词的括号保留', keep.includes('（DeepSeek）'), JSON.stringify(keep));

  // 看图：私聊发一张 data: 图，假的视觉端点会回一句描述
  const png =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const before1 = mock.calls.length;
  await bridge.handleEvent(
    ev({ message: [{ type: 'text', data: { text: '你看这个' } }, { type: 'image', data: { url: png } }] }),
  );
  const seen1 = mock.calls
    .slice(before1)
    .map((c) => JSON.stringify(c.messages))
    .join('\n');
  check('图片被看懂并写进上下文', seen1.includes('[图片：') || seen1.includes('假视觉'), seen1.slice(-200));

  // 引用一条带图的消息：要把「那张图是什么」也带进上下文
  const before = mock.calls.length;
  quoted.set('903', {
    sender: { user_id: 10000, nickname: '鱼儿' },
    message: [
      { type: 'text', data: { text: '你看这个' } },
      { type: 'image', data: { url: png } },
    ],
  });
  await bridge.handleEvent(
    ev({
      message_type: 'group',
      group_id: 1106592574,
      sender: { user_id: 3114694568, nickname: '搬砖king' },
      message: [
        { type: 'reply', data: { id: '903' } },
        { type: 'text', data: { text: '你会变成这样吗' } },
      ],
    }),
  );
  const seen = mock.calls.slice(before).map((c) => JSON.stringify(c.messages)).join('\n');
  check('引用的图也被看懂', seen.includes('发过一张图') || seen.includes('图片：'), seen.slice(-160));
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

/* ------------------------- 换人格后的历史隔离（防语气串味） ------------------------- */

async function testPersonaMark() {
  const petApi = await load('pet-api.mjs');
  const { sincePersonaMark, PERSONA_MARK_PREFIX } = petApi;

  // 纯函数：只认最后一块界碑
  const merged = [
    { role: 'user', content: '你是谁' },
    { role: 'assistant', content: '大肥鱼？谁呀，姐不认识这人。' },
    { role: 'user', content: `${PERSONA_MARK_PREFIX}从现在起你是「小蓝」…）`, mark: 'persona', persona: 'xiaolan' },
    { role: 'user', content: '在吗' },
    { role: 'assistant', content: '在的呀主人～' },
  ];
  const sliced = sincePersonaMark(merged);
  check(
    '换身份后历史只留界碑之后',
    sliced.length === 3 && !sliced.some((m) => /姐不认识/.test(m.content)),
    `剩 ${sliced.length} 条：${sliced.map((m) => String(m.content).slice(0, 8)).join(' / ')}`,
  );
  check('没界碑时历史原样返回', sincePersonaMark(merged.slice(0, 2)).length === 2);

  // 真写一次：给人格切换打界碑（群聊桶）
  const personas = (await petApi.loadPersonas()).personas ?? [];
  const lin = personas.find((p) => p.id === 'lin') ?? personas[1];
  await petApi.applyPersona(lin, { petId: 'main', surface: 'group', conv: 'group:777777' });
  const mem = JSON.parse(await readFile(join(tmp, 'data', 'memory.json'), 'utf8'));
  const bucket = mem.main?.['main@group:777777']?.messages ?? [];
  check(
    '换人格会在该会话记忆里打界碑',
    bucket.some((m) => m.mark === 'persona' && String(m.content).includes(lin.name)),
    `${lin.name}：${bucket.length} 条`,
  );
  // 界碑之后喂给模型的历史，起点必须是界碑本身
  const ctx = await petApi.recentForContext('main', 20, { surface: 'group', conv: 'group:777777' });
  check('喂模型的历史从界碑开始', ctx.length >= 1 && ctx[0].mark === 'persona', `${ctx.length} 条`);
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

/* ------------------------ P0：防串台 / 规矩 / 画像 / 账本 ------------------------ */

async function testInternalMarks() {
  const { stripInternal } = petApi;
  check(
    '内部标记：system_reminder 被清掉',
    stripInternal('<system_reminder>注意别出戏</system_reminder>你好呀') === '你好呀',
    JSON.stringify(stripInternal('<system_reminder>x</system_reminder>你好呀')),
  );
  check(
    '内部标记：DSML 标签被清掉',
    !stripInternal('<DSML>tool</DSML>在呢').includes('DSML'),
    JSON.stringify(stripInternal('<DSML>tool</DSML>在呢')),
  );
  const leaked = stripInternal('【规矩】不许叫大肥鱼\n好，记住了');
  check(
    '内部标记：我们拼进 prompt 的段落不会漏出去',
    !leaked.includes('【规矩】') && leaked.includes('好，记住了'),
    JSON.stringify(leaked),
  );
  check('内部标记：[图:…] 残留被清掉', stripInternal('笑死[图:疑惑]').trim() === '笑死', JSON.stringify(stripInternal('笑死[图:疑惑]')));

  // 桥上再兜一层：模型真把标记吐出来时，发出去的消息里不能有
  mock.setReplyResolver(() => '<system_reminder>别出戏</system_reminder>嗯嗯，我听着呢');
  const n = sent.length;
  await bridge.handleEvent(ev({ message: [{ type: 'text', data: { text: '在吗' } }] }));
  const txt = segText(last()?.segments ?? '');
  check('出站兜底：发出去的消息里没有内部标记', sent.length > n && !txt.includes('system_reminder'), txt.slice(0, 40));
  mock.setReplyResolver(null);
}

async function testRules() {
  const ag = await load('agency.mjs');
  await ag.addRule('不许叫主人「大肥鱼」');
  const dup = await ag.addRule('不许叫主人「大肥鱼」');
  check('规矩：重复的不重复记', dup.ok === false && dup.reason === 'duplicate');
  const brief = ag.rulesBrief((await ag.loadAgency(new Date())).rules);
  check(
    '规矩：拼进 system 时带编号、放在最前',
    brief.startsWith('【规矩】') && /1\. 不许叫主人/.test(brief),
    brief.split('\n')[0],
  );
  for (let i = 0; i < 12; i += 1) await ag.addRule(`第 ${i} 条测试规矩`);
  const many = await ag.loadAgency(new Date());
  check('规矩：最多留 10 条', many.rules.length === 10, `${many.rules.length} 条`);
  const rm = await ag.removeRule(1);
  check('规矩：能删掉第一条', rm.ok && !ag.rulesBrief(rm.rules).includes('第 1 条测试规矩'));
  // 清干净，别影响后面的用例
  let left = (await ag.loadAgency(new Date())).rules;
  while (left.length) {
    await ag.removeRule(1);
    left = (await ag.loadAgency(new Date())).rules;
  }
}

async function testProfiles() {
  const pf = await load('profiles.mjs');
  const conv = 'group:777001';
  for (const t of ['草，这显卡又涨价了', '我刚下班，累死', '显卡别买，等降价']) {
    await pf.noteSpeaker({ conv, userId: '3114694568', name: '搬砖king', text: t, at: Date.now() });
  }
  const brief = await pf.profileBrief({ conv, userId: '3114694568', name: '搬砖king' });
  check(
    '画像：攒够三条就能拼出提示',
    brief.includes('【说话的人】') && brief.includes('搬砖king'),
    brief.replace(/\n/g, ' ').slice(0, 60),
  );
  check('画像：爱提的词会带上', brief.includes('显卡') || brief.includes('涨价'), brief.slice(0, 80));
  const list = await pf.topProfiles(conv, 5);
  check('画像：/画像 能列出这个人', list.length === 1 && list[0].msgs === 3, JSON.stringify(list[0]?.msgs));
  check('画像：只有一条时不硬凑描述', (await pf.profileBrief({ conv, userId: '999', name: 'x' })) === '');
}

async function testUsage() {
  const u = await load('usage.mjs');
  await u.recordUsage({
    kind: 'chat',
    model: 'mock',
    usage: { prompt_tokens: 120, completion_tokens: 30, prompt_cache_hit_tokens: 80 },
    ms: 12,
  });
  await u.recordUsage({
    kind: 'group',
    model: 'mock',
    usage: { prompt_tokens: 60, completion_tokens: 10, prompt_cache_hit_tokens: 0 },
    ms: 9,
  });
  const s = await u.usageSummary({ days: 1 });
  check('账本：今天的调用被记下', s.today.calls >= 2, `${s.today.calls} 次`);
  check('账本：缓存命中的 token 单独统计', s.today.cacheHit >= 80, `命中 ${s.today.cacheHit}`);
  const kinds = s.byKind.map((x) => x.kind);
  check('账本：按 kind 分开（聊天/群）', kinds.includes('chat') && kinds.includes('group'), kinds.join(','));
  const wrapped = await u.withUsage('proactive', async () => ({
    ok: true,
    text: 'x',
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }));
  const s2 = await u.usageSummary({ days: 1 });
  check(
    '账本：withUsage 包一层就自动记账',
    wrapped.ok && s2.byKind.some((k) => k.kind === 'proactive' && k.calls === 1),
    s2.byKind.map((k) => k.kind).join(','),
  );
}

async function testCoalesce() {
  const localSent = [];
  const localTransport = {
    async send(msg, segments) {
      localSent.push({ to: `${msg.kind}:${msg.groupId ?? msg.senderId}`, segments });
      return { message_id: localSent.length + 10_000 };
    },
    async call() {
      throw new Error('不支持');
    },
  };
  const c2 = {
    ...conf,
    behavior: { ...conf.behavior, coalesceMs: 120 },
  };
  const bridge2 = createBridge({ conf: c2, personas, transport: localTransport, log: quiet });
  bridge2.__debugLog = process.env.COALESCE_DEBUG ? console.log : null;
  const msgEv = (id, text, uid) =>
    ev({ message_id: id, user_id: uid, sender: { user_id: uid, nickname: '主人' }, message: [{ type: 'text', data: { text } }] });
  const callsBefore = mock.calls.length;
  // 固定回复，避免 mock 回显 prompt（否则拆气泡会把上下文片段当回复发出去）
  mock.setReplyResolver(() => '在的在的。');
  const p1 = bridge2.handleEvent(msgEv('coal-1', '在吗小蓝', 20001));
  const p2 = bridge2.handleEvent(msgEv('coal-2', '我跟你说个事啊', 20001));
  const p3 = bridge2.handleEvent(msgEv('coal-3', '今天服务器又炸了呀', 20001));
  await Promise.all([p1, p2, p3]);
  mock.setReplyResolver(null);
  const calls = mock.calls.length - callsBefore;
  const texts = localSent.filter((x) => x.segments.some((s) => s.type === 'text'));
  check('连发合并：三条连发只回一次', calls === 1 && texts.length === 1, `模型调用 ${calls} 次、发了 ${texts.length} 条`);
  const seen = mock.calls
    .slice(callsBefore)
    .map((c) => c.messages.map((m) => String(m.content)).join('\n'))
    .join('\n');
  const hasEarlier = seen.includes('（他接着又发了几条');
  const all = ['在吗小蓝', '我跟你说个事啊', '今天服务器又炸了呀'];
  const missing = all.filter((t) => !seen.includes(t));
  check(
    '连发合并：三条的内容都在同一次上下文里',
    hasEarlier && missing.length === 0,
    `合并标记=${hasEarlier}，缺=${missing.join('/') || '无'}`,
  );
}

async function testFollowUp() {
  const localSent = [];
  const localTransport = {
    async send(msg, segments) {
      localSent.push({ to: `${msg.kind}:${msg.groupId ?? msg.senderId}`, segments });
      return { message_id: localSent.length + 20_000 };
    },
    async call(action, params) {
      if (action === 'get_group_member_info') {
        return { group_id: params.group_id, user_id: params.user_id, card: '', nickname: `群友${params.user_id}` };
      }
      throw new Error('不支持');
    },
  };
  const groupEv = (id, text, uid, extra = {}) =>
    ev({
      message_type: 'group',
      group_id: 424242,
      message_id: id,
      user_id: uid,
      sender: { user_id: uid, nickname: `群友${uid}`, card: '' },
      message: [{ type: 'text', data: { text } }],
      ...extra,
    });

  mock.setReplyResolver(() => '嗯，我听着呢。');
  const c3 = { ...conf, behavior: { ...conf.behavior, coalesceMs: 0, followUpMinutes: 12 } };
  const b3 = createBridge({ conf: c3, personas, transport: localTransport, log: quiet });
  // 群友 @ 她
  await b3.handleEvent(
    groupEv('fu-1', '鱼儿在吗', 31001, { message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: ' 鱼儿在吗' } }] }),
  );
  const afterAt = localSent.length;
  // 同一个人接着说话，不 @、不引用
  await b3.handleEvent(groupEv('fu-2', '刚才那个报错你怎么看', 31001));
  const afterFollow = localSent.length;
  // 另一个人插话，不在窗口里，应该不接
  await b3.handleEvent(groupEv('fu-3', '我这边也有个问题', 31002));
  const afterOther = localSent.length;
  mock.setReplyResolver(null);

  check('追问窗口：@ 过她的人接着说不 @ 也回', afterAt >= 1 && afterFollow > afterAt, `@ 之后 ${afterAt} 条，追加一句后 ${afterFollow} 条`);
  check('追问窗口：不相关的群友仍在旁听', afterOther === afterFollow, `第三人插话后 ${afterOther} 条`);

  // 窗口关掉就不该接
  mock.setReplyResolver(() => '嗯，我听着呢。');
  const c4 = { ...conf, behavior: { ...conf.behavior, coalesceMs: 0, followUpMinutes: 0 } };
  const b4 = createBridge({ conf: c4, personas, transport: localTransport, log: quiet });
  const before = localSent.length;
  await b4.handleEvent(
    groupEv('fu-4', '鱼儿在吗', 31003, { message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: ' 鱼儿在吗' } }] }),
  );
  const mid = localSent.length;
  await b4.handleEvent(groupEv('fu-5', '再问一句', 31003));
  const after = localSent.length;
  mock.setReplyResolver(null);
  check('追问窗口：关掉后不 @ 就不接', mid > before && after === mid, `@ 之后 ${mid - before} 条，追问后新增 ${after - mid} 条`);
}

async function testVoiceGate() {
  const tts = await load('tts.mjs');
  check('语音：私聊按概率放行', tts.shouldSpeak({ enabled: true, chance: 1, privateOnly: true }, { kind: 'private' }) === true);
  check(
    '语音：群里默认不说话',
    tts.shouldSpeak({ enabled: true, chance: 1, privateOnly: true }, { kind: 'group' }) === false,
  );
  check('语音：概率 0 就不发', tts.shouldSpeak({ enabled: true, chance: 0 }, { kind: 'private' }) === false);
  check('语音：总开关关掉', tts.shouldSpeak({ enabled: false, chance: 1 }, { kind: 'private' }) === false);
  const cleaned = tts.speechText('好呀（歪头）[图:疑惑] 你说的这个 https://x.com 我记住了');
  check(
    '语音：念之前先洗掉动作/图/链接',
    !cleaned.includes('歪头') && !cleaned.includes('[图') && !cleaned.includes('http'),
    cleaned,
  );
  check('语音：空文本直接跳过', (await tts.synthesize('（歪头）')).ok === false);
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

  // 13.2 热闹群 + 机会分够 + 评分过关 → 自己插一句（不带 @）
  {
    const db = await groupsMod.loadGroups(fakeNow);
    const g = groupsMod.groupState(db, 'group:9001', fakeNow);
    const now = fakeNow.getTime();
    g.impulse = 130;
    g.lastMessageAt = now;
    g.lastDecayAt = now;
    g.sentToday = 0;
    g.lastSpokeAt = 0;
    g.cooldownUntil = 0;
    // 5 分钟内 40 条 → 8 条/分 → 热闹档
    g.msgs = Array.from({ length: 40 }, (_, i) => now - i * 5_000);
    g.tier = 'hot';
    g.tierSince = now - 10 * 60_000;
    g.lastUrgency = 15;
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

  // 13.6 活跃度分档：热闹 100 / 冷清 12 / 死寂 3
  {
    const mk = (per5min, now) => {
      const g = { msgs: [], tier: '', tierSince: 0, spokeLog: [], annoyance: 0, sentToday: 0 };
      const arr = [];
      for (let i = 0; i < per5min; i += 1) arr.push(now - i * 10_000);
      g.msgs = arr;
      return g;
    };
    const now = fakeNow.getTime();
    const qHot = groupsMod.quotaOf(mk(50, now), fakeNow, groupsMod.GROUP_DEFAULTS);
    const qQuiet = groupsMod.quotaOf(mk(3, now), fakeNow, groupsMod.GROUP_DEFAULTS);
    const qDead = groupsMod.quotaOf(mk(0, now), fakeNow, groupsMod.GROUP_DEFAULTS);
    check('热闹群每天上限 100', qHot.tier === 'hot' && qHot.daily === 100, `${qHot.tier}/${qHot.daily}`);
    check('冷清群每天上限 20', qQuiet.tier === 'quiet' && qQuiet.daily === 20, `${qQuiet.tier}/${qQuiet.daily}`);
    check('死寂群每天上限 6', qDead.tier === 'dead' && qDead.daily === 6, `${qDead.tier}/${qDead.daily}`);
  }

  // 13.7 到配额就闭嘴（100 条打满）
  {
    const db = await groupsMod.loadGroups(fakeNow);
    const g = groupsMod.groupState(db, 'group:9100', fakeNow);
    const now = fakeNow.getTime();
    g.msgs = Array.from({ length: 40 }, (_, i) => now - i * 5_000);
    g.tier = 'hot';
    g.tierSince = now - 10 * 60_000;
    g.lastUrgency = 20;
    g.sentToday = 100;
    g.lastSpokeAt = now - 10 * 60_000;
    const gate = groupsMod.canSpeakGroup(db, 'group:9100', { now: fakeNow, quiet: {}, opts: groupsMod.GROUP_DEFAULTS });
    check('配额打满就不再说话', gate.ok === false && gate.reason === 'daily-limit', gate.reason);
  }

  // 13.8 占群比：一小时内她说的话不超过群消息的 12%
  {
    const db = await groupsMod.loadGroups(fakeNow);
    const g = groupsMod.groupState(db, 'group:9101', fakeNow);
    const now = fakeNow.getTime();
    g.msgs = Array.from({ length: 20 }, (_, i) => now - i * 20_000);
    g.tier = 'hot';
    g.tierSince = now - 10 * 60_000;
    g.lastUrgency = 20;
    g.spokeLog = [{ at: now - 5 * 60_000, replied: true }, { at: now - 3 * 60_000, replied: true }];
    g.sentToday = 2;
    g.lastSpokeAt = now - 3 * 60_000;
    const gate = groupsMod.canSpeakGroup(db, 'group:9101', { now: fakeNow, quiet: {}, opts: groupsMod.GROUP_DEFAULTS });
    check('占群比到线就收手', gate.ok === false && gate.reason === 'share-cap', gate.reason);
  }

  // 13.9 冷清群安静 45 分钟 → 允许主动开场
  {
    const db = await groupsMod.loadGroups(fakeNow);
    const g = groupsMod.groupState(db, 'group:9102', fakeNow);
    const now = fakeNow.getTime();
    g.msgs = [now - 50 * 60_000];
    g.tier = 'dead';
    g.tierSince = now - 60 * 60_000;
    g.lastMessageAt = now - 50 * 60_000;
    g.lastSpokeAt = now - 3 * 3600_000;
    g.sentToday = 0;
    const can = groupsMod.canOpenGroup(db, 'group:9102', { now: fakeNow, quiet: {}, opts: groupsMod.GROUP_DEFAULTS, roll: () => 0 });
    check('冷清群安静够久可以主动开场', can.ok === true, `${can.reason}/${can.tier}`);
  }

  // 13.10 热闹群不许主动开场
  {
    const db = await groupsMod.loadGroups(fakeNow);
    const g = groupsMod.groupState(db, 'group:9103', fakeNow);
    const now = fakeNow.getTime();
    g.msgs = Array.from({ length: 40 }, (_, i) => now - i * 5_000);
    g.tier = 'hot';
    g.tierSince = now - 10 * 60_000;
    g.lastMessageAt = now;
    const can = groupsMod.canOpenGroup(db, 'group:9103', { now: fakeNow, quiet: {}, opts: groupsMod.GROUP_DEFAULTS, roll: () => 0 });
    check('热闹群不主动开场', can.ok === false && can.reason === 'too-lively', can.reason);
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

  // 13.6 主人手动 /解禁：清掉冷却与反感度（QQ 群号至少 5 位，这里用 90001）
  {
    const db = await groupsMod.loadGroups(fakeNow);
    const g = groupsMod.groupState(db, 'group:90001', fakeNow);
    g.cooldownUntil = fakeNow.getTime() + 3_600_000;
    g.annoyance = 70;
    g.impulse = 0;
    await groupsMod.saveGroups(db);
    await bridge.handleEvent(ev({ message: [{ type: 'text', data: { text: '/解禁 90001' } }] }));
    const after = (await groupsMod.loadGroups(fakeNow)).groups['group:90001'];
    check(
      '主人 /解禁 清掉群冷却',
      Number(after.cooldownUntil) === 0 && Number(after.annoyance) === 0 && segText(last()?.segments ?? '').includes('解禁了'),
      `annoyance=${after.annoyance}，cooldownUntil=${after.cooldownUntil}`,
    );
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
