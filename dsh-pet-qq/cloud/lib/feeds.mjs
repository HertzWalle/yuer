/**
 * 她自己的「输入」：B 站热门 / 榜单、抖音热搜。
 *
 * 红线（ROADMAP 里定死的）：只读。不发弹幕、不点赞、不评论、不登录客户端。
 * 解析函数（parseBiliPopular / parseBiliRanking / parseDouyinHot）是纯函数，
 * 自测直接喂固定 payload，不联网；fetchSeen() 才真的走网络。
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const BILI_HEADERS = { 'user-agent': UA, referer: 'https://www.bilibili.com/' };

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** 324 万 → 「324.0万」；一万以下原样 */
export function humanCount(n) {
  const v = num(n);
  if (v >= 1e8) return `${(v / 1e8).toFixed(1)}亿`;
  if (v >= 1e4) return `${(v / 1e4).toFixed(1)}万`;
  return String(v);
}

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/* --------------------------------- B 站 --------------------------------- */

export function parseBiliPopular(json, { limit = 8 } = {}) {
  const list = json?.data?.list;
  if (!Array.isArray(list)) return [];
  return list
    .slice(0, limit)
    .map((v) => ({
      platform: 'bilibili',
      title: clip(v?.title, 60),
      up: clip(v?.owner?.name, 20),
      url: v?.short_link_v2 || (v?.bvid ? `https://www.bilibili.com/video/${v.bvid}` : ''),
      tag: clip(v?.tname, 12),
      view: num(v?.stat?.view),
      desc: clip(v?.desc, 80),
    }))
    .filter((x) => x.title);
}

export function parseBiliRanking(json, { limit = 8 } = {}) {
  const list = json?.data?.list;
  if (!Array.isArray(list)) return [];
  return list
    .slice(0, limit)
    .map((v) => ({
      platform: 'bilibili',
      title: clip(v?.title, 60),
      up: clip(v?.owner?.name, 20),
      url: v?.short_link_v2 || (v?.bvid ? `https://www.bilibili.com/video/${v.bvid}` : ''),
      tag: clip(v?.tname, 12),
      view: num(v?.stat?.view),
      desc: clip(v?.desc, 80),
    }))
    .filter((x) => x.title);
}

/* -------------------------------- 抖音热搜 -------------------------------- */

export function parseDouyinHot(json, { limit = 8 } = {}) {
  const list = json?.data;
  if (!Array.isArray(list)) return [];
  return list
    .slice(0, limit)
    .map((v, i) => ({
      platform: 'douyin',
      rank: i + 1,
      title: clip(v?.title, 60),
      hot: num(v?.hot_value),
      url: clip(v?.link, 200),
    }))
    .filter((x) => x.title);
}

/* --------------------------------- 抓取 --------------------------------- */

async function getJson(url, { headers = {}, timeoutMs = 15_000 } = {}) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (!text.trim().startsWith('{')) throw new Error('返回的不是 JSON');
  return JSON.parse(text);
}

export async function fetchBili({ limit = 8, timeoutMs } = {}) {
  try {
    const json = await getJson('https://api.bilibili.com/x/web-interface/popular?ps=20&pn=1', {
      headers: BILI_HEADERS,
      timeoutMs,
    });
    const items = parseBiliPopular(json, { limit });
    if (items.length) return { ok: true, items };
    return { ok: false, reason: 'empty' };
  } catch (e) {
    return { ok: false, reason: 'fetch-error', message: String(e?.message ?? e) };
  }
}

export async function fetchDouyin({ limit = 8, timeoutMs } = {}) {
  try {
    const json = await getJson('https://60s.viki.moe/v2/douyin', { timeoutMs });
    const items = parseDouyinHot(json, { limit });
    if (items.length) return { ok: true, items };
    return { ok: false, reason: 'empty' };
  } catch (e) {
    return { ok: false, reason: 'fetch-error', message: String(e?.message ?? e) };
  }
}

/** 一次把两个平台都拉一遍；任一失败不影响另一个 */
export async function fetchSeen({ biliLimit = 8, douyinLimit = 8, timeoutMs } = {}) {
  const [bili, douyin] = await Promise.all([
    fetchBili({ limit: biliLimit, timeoutMs }),
    fetchDouyin({ limit: douyinLimit, timeoutMs }),
  ]);
  return { bili, douyin };
}

/** 一条 B 站视频 → 语义记忆里的一句话 */
export function biliNote(item) {
  const bits = [item.title];
  if (item.up) bits.push(`UP：${item.up}`);
  if (item.tag) bits.push(item.tag);
  if (item.view) bits.push(`${humanCount(item.view)}播放`);
  return `B站热门：${bits.join('｜')}`;
}

/** 一条抖音热搜 → 语义记忆里的一句话 */
export function douyinNote(item) {
  const hot = item.hot ? `（${humanCount(item.hot)}热度）` : '';
  return `抖音热搜：${item.title}${hot}`;
}
