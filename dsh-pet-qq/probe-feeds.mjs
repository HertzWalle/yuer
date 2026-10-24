const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const dz = await (await fetch('https://60s.viki.moe/v2/douyin', { headers: { 'user-agent': UA } })).json();
console.log('douyin keys', Object.keys(dz), 'len', dz.data?.length);
console.log('item0', JSON.stringify(dz.data?.[0]).slice(0, 300));
const bl = await (await fetch('https://api.bilibili.com/x/web-interface/popular?ps=3&pn=1', { headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' } })).json();
const v = bl.data.list[0];
console.log('bili item', JSON.stringify({ title: v.title, owner: v.owner?.name, bvid: v.bvid, desc: String(v.desc).slice(0, 40), tname: v.tname, stat: { view: v.stat?.view, like: v.stat?.like }, short_link: v.short_link_v2 }));