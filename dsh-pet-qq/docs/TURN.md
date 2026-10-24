# `/turn` 契约（S4：接入层与大脑解耦）

一句话：**接入层负责「怎么收到消息、怎么发出去」，大脑负责「她是谁、记着什么、想说什么」。**

我们自己的 OneBot 桥（`qq-bridge.mjs`）把两者写在一起，因为它已经跑通、改它的风险最低；
`/turn` 是给**别的接入层**（AstrBot / LangBot / 以后别的平台）准备的最小接口。

```
接入层（AstrBot / LangBot / 自写）            大脑（yuer）
  收到一条消息 ──POST /turn {conv,user,text}──►  取人设 → 语义记忆检索 → 历史压缩 →
                                                生成回复 → 拆气泡 → 记记忆
  逐条发出去   ◄──── { segments:[…], image }──
```

## 启动

`.env` 里配上 token 即自动启动（和机器人同一个 systemd 单元）：

```dotenv
TURN_TOKEN=<openssl rand -hex 24>
TURN_HOST=127.0.0.1
TURN_PORT=3030
```

**默认只监听回环**。跨机请用 Tailscale 或 SSH 隧道；不要把 3030 暴露到公网——这台机器上还有
能执行命令的 DSH 面板。

## 接口

### `POST /turn`

请求：

```http
POST /turn HTTP/1.1
content-type: application/json
x-turn-token: <TURN_TOKEN>

{
  "conv": "private:1360153202",     // 或 "group:1106592574"
  "user": { "id": "1360153202", "name": "HudsonZephyr" },
  "text": "在吗小蓝"
}
```

响应（200）：

```json
{
  "ok": true,
  "conv": "private:1360153202",
  "surface": "private",
  "text": "在的呀主人。 刚还在想你咋突然没声了。",
  "segments": ["在的呀主人。", "刚还在想你咋突然没声了。"],
  "image": "睡觉",
  "persona": { "id": "xiaolan", "name": "小蓝" }
}
```

- `segments`：要发的**气泡**，按顺序逐条发出去；`text` 是它们拼起来的一份（存记忆用）。
- `image`：表情包**名字**（不带扩展名）。接入层自己去取图（云端 `data/memes/<名字>/` 里随机一张），
  取不到就只发文字——不要因此丢掉整条回复。
- `conv` 决定三件事：私聊/群聊人设档、按群覆盖的人格（`group:<群号>`）、记忆分桶。
- 群聊想让她知道「谁在说话」，`user.name` 必填；正文里的 `【昵称】` 前缀由大脑加，接入层别重复加。

错误：

| 状态 | 含义 |
| --- | --- |
| 400 | `text` 为空 / JSON 解析失败 |
| 401 | token 不对或没带 |
| 413 | 请求体超过 64 KB |
| 502 | 模型侧失败（`reason` 里是原因） |
| 503 | 服务端没配 `TURN_TOKEN`（拒绝一切请求） |

### `GET /health`

免鉴权，给探活用：

```json
{ "ok": true, "app": "yuer-turn", "version": "1.6.0", "uptimeMs": 12345 }
```

### `GET /personas`

带 token 才可读，返回当前 `active` 与 `surfaces`（私聊/群聊默认/按群覆盖），
方便接入层的管理页展示。

## curl 试一下

```bash
curl -s http://127.0.0.1:3030/health
curl -s http://127.0.0.1:3030/turn \
  -H 'content-type: application/json' \
  -H "x-turn-token: $TURN_TOKEN" \
  -d '{"conv":"private:1360153202","user":{"id":"1360153202","name":"主人"},"text":"在吗"}'
```

## 接入层还缺什么（诚实说明）

`/turn` 只解决「一轮对话」。下面这些仍然只在 `qq-bridge.mjs` 里有：

- **主动性**：承诺兑现、私聊冲动开口、群旁听——它们和「什么时候该说话」的时间语义绑在一起；
- **指令**：`/人格`、`/心思`、`/空间`、`/忘记` 等；
- **入站增强**：引用回复（取 `get_msg`）、群旁听计数、去重、白名单；
- **出站增强**：引用段、表情包图片段、多气泡之间的打字延迟。

所以现在有两种组合方式：

1. **A 方案（推荐，现状）**：OneBot 桥直连大脑，全部能力都在；
2. **C 方案**：AstrBot 当接入层，只转发消息到 `/turn`（`adapters/astrbot_plugin_yuer/`），
   此时 AstrBot 的平台上能用她的人设和记忆，但**没有主动消息、没有指令、没有引用回复**。

要把 C 补全，下一步是给大脑加「出站适配器」：调度器把主动消息 POST 到 AstrBot 的
`send_message` 接口（或 AstrBot 侧轮询），再把指令也搬进 `/turn`。这是 S4 的剩余工作，
不影响现在的 A 方案。
