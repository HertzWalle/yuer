# dsh-pet · 会聊天的小蓝

给 `dsh-pet`（DeepSeek Harness 的桌宠插件）加上**人格**，再通过 **QQ** 跟她聊天：
桌面气泡、私聊、群聊共用同一套人设与记忆；云端可以独立跑，本机关机也不影响。

> 当前版本 **v1.12.0**（`VERSION`） · 变更记录 `CHANGELOG.md` · 后续计划 `docs/ROADMAP.md`

## 她现在能做什么

| 能力 | 说明 |
|---|---|
| 人格切换 | 6 个人格（小蓝 / 阿喵 / 凛 / 知夏 / 你鱼姐 / 溟月），QQ 里 `/人格` 一句就能换 |
| 群私分档 | 私聊是小蓝（温柔女仆），群聊是你鱼姐（蓝发大鲸鱼老资历），各用各的记忆 |
| 表情包 | 27 个分类、54 个名字，按语境挑一张，单独成条发，不像刷屏 |
| 主动开口 | 每 5 分钟算一次「想说话的冲动」，攒够了才开口；承诺过的事到点会主动兑现 |
| 记忆 | 与桌面桌宠同一份 `memory.json`，云端每小时快照，可拉回本机 |
| 记忆分层 | 情节 / 摘要 / 语义 / 自我模型四层，超预算自动压缩落盘，30 天没用的旧记忆归档 |
| 自己的输入 | 每天刷两次 B 站热门与抖音热搜，写进语义记忆，聊天时自然提起 |
| 可换接入层 | `POST /turn` 契约 + AstrBot 参考适配器，换框架不换脑子 |
| 云端常驻 | 腾讯云 2C2G 上跑 NapCat + 大脑，本机可关机 |

## 目录

```
.
├── dsh-pet-qq/          # QQ 机器人主体（桥、云端大脑、部署脚本、文档）
│   ├── qq-bridge.mjs    # OneBot v11 正向 WS 客户端（零依赖）
│   ├── persona.mjs      # 桌面端人格切换 CLI
│   ├── personas.json    # 人格库
│   ├── cloud/           # 云端全量运行时（大脑 + 调度 + 备份 + 部署）
│   ├── napcat/          # NapCat 启动脚本（shell 目录不入库）
│   └── docs/            # 云端架构与迁移说明
├── persona-dafeiyu/     # DSH 人格卡（可导入 dsh-persona-dafeiyu）+ 提示词分析
├── docs/ROADMAP.md      # S0–S5 版本规划
├── scripts/git-push.mjs # 提交/打标签/推送（isomorphic-git，走 github.com）
├── scripts/push-api.mjs # 同上，但走 api.github.com（github.com 抽风时用）
├── CHANGELOG.md
└── VERSION
```

## 快速开始

### A. 只在本机玩（桌面桌宠 + QQ）

```bash
cd dsh-pet-qq
node persona.mjs list          # 看看有哪些人格
node persona.mjs use 小蓝       # 换人格（改的是 dsh-pet 的 whisperPrompt）
node test-bridge.mjs           # 自测 9 项
```

QQ 侧需要 NapCat（或任意 OneBot v11 实现）：
`napcat\start-napcat.bat` 提权启动 → 扫码登录 → `node qq-bridge.mjs`。

### B. 云端全量（推荐，本机可关机）

```bash
cd dsh-pet-qq
node cloud/build.mjs                     # 组装 dist/
cp cloud/.env.example cloud/bot.env      # 填 DEEPSEEK_API_KEY / BACKUP_TOKEN
# 按 cloud/deploy.md 传到服务器，systemd 拉起
```

回到本机拉记忆：`pull-memory.cmd`（SSH 隧道 + 备份服务，不暴露公网）。

## 安全约定

- **密钥不入库**：`cloud/bot.env`、`*.pem`、`.ssh/` 全在 `.gitignore` 里；仓库里只有 `.env.example`。
- 备份服务只绑 `127.0.0.1:3020`，靠 SSH 隧道访问，带 `x-backup-token`。
- 机器人**只读**外部平台内容，不代发、不点赞、不评论。

## 版本管理

- `CHANGELOG.md` 按 `vX.Y.Z` 记录；根目录 `VERSION` 是唯一真源。
- 每个版本打一个 `vX.Y.Z` 标签，提交信息用 `type(scope): 摘要`（feat/fix/docs/chore/refactor）。
- 这台机器没有 git 二进制，提交/标签/推送走 `node scripts/git-push.mjs`（isomorphic-git）。
- github.com 的 smart HTTP 抽风（`Request timed out`）时改用 `node scripts/push-api.mjs "提交说明" --tag`：走 `api.github.com` 的 Git Data API，只传差异 blob，标签已存在会自动挪到新提交。

## 致谢

- [dsh-pet](https://github.com/PC2005-cloud/dsh-pet)：桌面桌宠本体
- [NapCat](https://github.com/NapNeko/NapCatQQ)：QQ 协议实现
- [dsh-persona-dafeiyu](https://github.com/huaizhuanghub/dsh-persona-dafeiyu)：人格卡插件与格式
- [astrbot-deepseek-meme-pack](https://github.com/shirachino/astrbot-deepseek-meme-pack)：表情包素材（CC0）

