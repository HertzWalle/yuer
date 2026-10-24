/**
 * QQ 空间：拿 cookie → 算 g_tk → 读动态 / 发说说。
 *
 * 为什么不用 OneBot 标准接口：OneBot v11 里没有空间相关的 action。
 * 但 NapCat 暴露了 `get_cookies`，能拿到 qzone 域下的 `uin / skey / p_skey`，
 * 剩下就是直接打腾讯的旧 CGI（和十年前网页版 qzone 用的是同一批接口）。
 *
 * 三条硬约束（写死在这里，不交给调用方去记得）：
 * 1. 只发**纯文字**，不带图（图片上传接口最容易失效，也最容易触发风控）；
 * 2. 正文一律截断到 maxChars、去掉链接与 @（说说里带链接像营销号）；
 * 3. 任何一步失败都返回 {ok:false, reason}，绝不抛异常打断调度器。
 *
 * 风险提示：这是非官方接口。频率过高/内容敏感会触发验证甚至限制空间功能，
 * 所以调度器那边有「每天最多 1 条 + 连续失败 3 次自动停用」的硬闸。
 */

const QZONE_HOST = 'https://user.qzone.qq.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** 每次操作单独开一条短连接：空间调用一天没几次，犯不上复用一个长连接 */
export function callOneBot({ ws, token, action, params, timeoutMs = 15_000 }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        sock?.close();
      } catch {
        /* ignore */
      }
      resolve(v);
    };
    const echo = `qzone-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), timeoutMs);

    let sock;
    try {
      const url = token ? `${ws}?access_token=${encodeURIComponent(token)}` : ws;
      sock = new WebSocket(url);
    } catch (e) {
      return finish({ ok: false, reason: 'ws-error', message: e?.message });
    }

    sock.addEventListener('open', () => {
      try {
        sock.send(JSON.stringify({ action, params, echo }));
      } catch (e) {
        finish({ ok: false, reason: 'send-error', message: e?.message });
      }
    });
    sock.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg?.echo !== echo) return;
      const ok = msg.status === 'ok' || msg.retcode === 0;
      finish(ok ? { ok: true, data: msg.data } : { ok: false, reason: 'onebot-error', message: msg.message || msg.wording, retcode: msg.retcode });
    });
    sock.addEventListener('error', () => finish({ ok: false, reason: 'ws-error' }));
    sock.addEventListener('close', () => finish({ ok: false, reason: 'ws-closed' }));
  });
}

/** "uin=o0123; skey=@abc; p_skey=xyz" → { uin, skey, p_skey } */
function parseCookieString(raw) {
  const out = {};
  for (const part of String(raw || '').split(';')) {
    const s = part.trim();
    if (!s) continue;
    const i = s.indexOf('=');
    if (i <= 0) continue;
    out[s.slice(0, i).trim()] = s.slice(i + 1).trim();
  }
  return out;
}

/** qzone 的 g_tk：对 skey 做 hash33（网上叫法，算法就是 h += (h<<5) + c） */
export function gTk(skey) {
  const s = String(skey || '').replace(/^@/, '');
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h += (h << 5) + s.charCodeAt(i);
  return h & 0x7fffffff;
}

/** 拿空间 cookie；失败返回 {ok:false, reason} */
export async function qzoneCookie({ ws, token, timeoutMs } = {}) {
  const res = await callOneBot({
    ws,
    token,
    action: 'get_cookies',
    params: { domain: 'qzone.qq.com' },
    timeoutMs,
  });
  if (!res.ok) return res;
  const raw = res.data?.cookies ?? res.data?.cookie ?? '';
  const c = parseCookieString(raw);
  if (!c.uin || !c.skey) return { ok: false, reason: 'no-cookie', message: '没拿到 uin/skey（可能没登录空间）' };
  return { ok: true, cookie: raw, uin: c.uin, skey: c.skey, pSkey: c.p_skey || '' };
}

/** 去掉链接、@、二维码味的东西，截断到 maxChars */
export function cleanMood(text, maxChars = 90) {
  let s = String(text ?? '')
    .replace(/\r/g, '')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/@\S+/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
  if (s.length > maxChars) s = s.slice(0, maxChars).replace(/[，,、；;：:\s]+$/, '');
  return s;
}

/**
 * 发一条纯文字说说。
 * @returns {{ok: boolean, reason?: string, message?: string, text?: string}}
 */
export async function publishMood({ ws, token, text, maxChars = 90, timeoutMs = 20_000 } = {}) {
  const body = cleanMood(text, maxChars);
  if (!body) return { ok: false, reason: 'empty' };

  // 首选 NapCat 自带的 send_qzone_msg（QQNT 自己的发说说通道，比网页 CGI 稳）
  const viaAction = await callOneBot({
    ws,
    token,
    action: 'send_qzone_msg',
    params: { content: body, images: [], ugc_right: 1, target_uins: [] },
    timeoutMs,
  });
  if (viaAction.ok) return { ok: true, text: body, tid: viaAction.data?.tid };

  // 退回网页 CGI（老办法，需要 p_skey 算 g_tk）
  const ck = await qzoneCookie({ ws, token, timeoutMs });
  if (!ck.ok) return { ...ck, text: body, message: viaAction.message };

  const gtk = gTk(ck.pSkey || ck.skey);
  const url = `${QZONE_HOST}/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_publish_v6?g_tk=${gtk}`;
  const form = new URLSearchParams({
    syn_tweet_verson: '1',
    paramstr: '1',
    who: '1',
    con: body,
    feedversion: '1',
    ver: '1',
    ugc_right: '1',
    to_sign: '0',
    hostuin: ck.uin,
    code_version: '1',
    format: 'json',
    qzreferrer: `${QZONE_HOST}/${ck.uin}`,
  });

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: ck.cookie,
        referer: `${QZONE_HOST}/${ck.uin}`,
        'user-agent': UA,
      },
      body: form.toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const txt = (await res.text()).trim();
    // 正常返回是 JSON；被风控/没权限时常常是 HTML 或空串
    if (!txt.startsWith('{')) {
      return { ok: false, reason: 'bad-response', message: txt.slice(0, 120) || `HTTP ${res.status}`, text: body };
    }
    const json = JSON.parse(txt);
    const code = Number(json.code ?? json.ret ?? json.retcode ?? -1);
    if (code === 0) return { ok: true, text: body, raw: json };
    return { ok: false, reason: 'api-error', message: json.message || json.msg || `code=${code}`, code, text: body };
  } catch (e) {
    return { ok: false, reason: 'network', message: e?.message ?? String(e), text: body };
  }
}

/** 读某个人的动态（默认读自己），失败返回 {ok:false} */
export async function readFeed({ ws, token, uin, num = 20, timeoutMs = 20_000 } = {}) {
  const ck = await qzoneCookie({ ws, token, timeoutMs });
  if (!ck.ok) return ck;

  const gtk = gTk(ck.pSkey || ck.skey);
  const who = String(uin || ck.uin).replace(/^o/, '');
  const q = new URLSearchParams({
    uin: who,
    ftype: '0',
    sort: '0',
    pos: '0',
    num: String(Math.max(1, Math.min(40, num))),
    replynum: '0',
    g_tk: String(gtk),
    callback: '',
    code_version: '1',
    format: 'json',
    need_private_comment: '1',
  });
  const url = `${QZONE_HOST}/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6?${q.toString()}`;

  try {
    const res = await fetch(url, {
      headers: { cookie: ck.cookie, referer: `${QZONE_HOST}/${ck.uin}`, 'user-agent': UA },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const txt = (await res.text()).trim();
    const json = JSON.parse(txt.replace(/^callback\(|\)$/g, '') || '{}');
    if (Number(json.code ?? -1) !== 0) {
      return { ok: false, reason: 'api-error', message: json.message || json.msg || `code=${json.code}` };
    }
    const list = Array.isArray(json.msglist) ? json.msglist : [];
    return {
      ok: true,
      items: list.map((m) => ({
        tid: String(m.tid ?? ''),
        at: Number(m.created_time ?? 0) * 1000,
        text: String(m.content ?? '').replace(/\s+/g, ' ').trim(),
        name: String(m.name ?? ''),
        uin: String(m.uin ?? ''),
        comments: Number(m.cmtnum ?? 0),
        likes: Number(m.likenum ?? 0),
      })),
    };
  } catch (e) {
    return { ok: false, reason: 'network', message: e?.message ?? String(e) };
  }
}
