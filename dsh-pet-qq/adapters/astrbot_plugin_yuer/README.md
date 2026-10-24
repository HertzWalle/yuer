# AstrBot 接入适配器：yuer

把「yuer 大脑」接进 [AstrBot](https://github.com/AstrBotDevs/AstrBot)，**只做传输层**。

AstrBot 负责：QQ/其它平台的连接、消息收发、多平台路由。
yuer 仍负责：人设（私聊/群聊/按群）、记忆（情节 + 摘要 + 语义）、主动性（承诺、冲动、群旁听）、
空间、表情包、引用回复。

```
QQ ── NapCat ── AstrBot ──(POST /turn)──> yuer 大脑（本机或 Tailscale 对端）
                                 <── { segments:[…], image }
```

## 为什么要这一层

AstrBot 很擅长「连很多平台、装插件」；我们这套的价值在「她是同一个人」——人格、记忆、主动性
都在自己手里。适配器只做一件事：把 AstrBot 收到的一句话转成 `/turn` 请求，把返回的气泡逐条
发出去。这样换接入层不换脑子。

## 安装

1. 在跑 yuer 的机器上开启 `/turn`（`.env` 里加 `TURN_TOKEN=...`，默认 `127.0.0.1:3030`）。
2. 把本目录拷到 AstrBot 的 `data/plugins/astrbot_plugin_yuer/`。
3. AstrBot WebUI → 插件配置，填 `turn_url` 与 `turn_token`。
4. 重启 AstrBot（或热重载插件）。

## 配置项

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `turn_url` | `http://127.0.0.1:3030/turn` | yuer 的 `/turn` 地址；跨机请走 Tailscale/SSH 隧道 |
| `turn_token` | 空 | 与 yuer `.env` 的 `TURN_TOKEN` 一致 |
| `timeout_sec` | 120 | 单轮超时（模型慢时别太短） |
| `ignore_prefixes` | `["/"]` | 这些前缀的消息不转发（AstrBot 自己的指令） |

## 已知限制

- **主动性不在这一层**：承诺兑现、私聊主动开口、群旁听仍然由 yuer 自己的进程管；AstrBot 只
  转发「别人说的话」。要让主动消息也走 AstrBot，得再给 yuer 加一个「出站适配器」（未做）。
- `/turn` 不认识 yuer 自己的指令（`/人格`、`/心思` 等）——这些由 yuer 的 OneBot 接入处理。
  用 AstrBot 时要么保留原 OneBot 接入，要么后续把指令也搬进 `/turn`。
- 群聊里 AstrBot 的事件可能包含 at 段；适配器会把正文原样送过去，`【昵称】` 前缀由 yuer 自己加。
