/**
 * 测试用的假 LLM：实现 OpenAI 兼容的 POST /v1/chat/completions。
 *
 * 存在的意义：没有真实 API key 时也能把「桥 → 人格 → 记忆 → 表情包 → OneBot 回包」
 * 整条链路跑通；有 key 时把 DEEPSEEK_BASE_URL 指回真端点即可。
 *
 * 行为：把最后一条 user 消息回显成「（假大脑）我听见了：…」，若含「累」字则附一张表情包标记，
 * 用来验证 [图:名称] 的解析与图片发送。
 *
 * 另外支持 `mock.setReplyResolver(fn)`：主动开口/承诺抽取这类「要求输出 JSON」的调用，
 * 由测试自己决定回什么（fn 收到 messages，返回字符串或 null 表示走默认回显）。
 */

import { createServer } from 'node:http';

export function startMockLlm({ port = 0 } = {}) {
  let resolveCustom = null;
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || !/\/chat\/completions$/.test(req.url || '')) {
      res.writeHead(404).end();
      return;
    }
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {}
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const user = [...messages].reverse().find((m) => m?.role === 'user');
      const text = String(user?.content ?? '');
      // 去掉配图指令，只回显用户原话
      const clean = text.split('\n\n[配图]')[0].trim();
      let reply = `（假大脑）我听见了：${clean.slice(0, 40)}`;
      if (clean.includes('累')) reply += '\n[图:吃白饭的大肥鱼]';
      if (typeof resolveCustom === 'function') {
        const custom = resolveCustom({ messages, user: text });
        if (typeof custom === 'string' && custom) reply = custom;
      }
      const payload = {
        id: 'mock-' + Date.now(),
        object: 'chat.completion',
        model: body.model || 'mock',
        choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
      const buf = Buffer.from(JSON.stringify(payload));
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': buf.length }).end(buf);
    });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        port: addr.port,
        baseUrl: `http://127.0.0.1:${addr.port}/v1`,
        setReplyResolver: (fn) => {
          resolveCustom = fn;
        },
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1].replace(/\\/g, '/')).href) {
  const s = await startMockLlm({ port: Number(process.env.MOCK_PORT || 9999) });
  console.log(`mock LLM 监听 ${s.baseUrl}`);
}
