# dsh-pet 人格 + QQ 对话

在桌面桌宠（dsh-pet）上装了一套**可切换的人格**，并把它接到 QQ：QQ 里发消息，是她用同一个人格、同一份记忆在回你，同时桌面上那只也会张嘴说同样的话。

两种跑法，二选一：

| | A. 全量云端（推荐，本机可以关机） | B. 本机全跑（已装好、已验证） |
| --- | --- | --- |
| QQ 小号 / NapCat | 云服务器（Docker） | 这台电脑（`D:\QQ` + `napcat/shell/`） |
| 大脑（人格 + 记忆 + LLM） | 云服务器（`dist/`，直连 API） | 本机 dsh-pet 宿主 |
| 本机要开机吗 | **不用**，只在想备份时开一下 | 要，关机就掉线 |
| 和桌面桌宠的关系 | 独立两套人设/记忆 | 桌面气泡与 QQ 共用一份 |
| 部署 | [`deploy.md`](cloud/deploy.md) | 本 README 的「QQ 端」一节 |

```
A 全量云端：
QQ 消息 ──▶ NapCat（云服务器） ──WS:3001──▶ start-bot.mjs ──▶ lib/pet-api.mjs（云端版）
                                                              ├─ lib/llm.mjs ──▶ api.deepseek.com
                                                              └─ data/{pet,memory}.json + memes/
                                                                         │ backup-server.mjs :3020
本机开机时：backup-pull.mjs ─────────────────────────────────────────────┘ → backups/

B 本机全跑：
QQ 消息 ──▶ NapCat（本机） ──WS:3001──▶ qq-bridge.mjs ──▶ POST /dsh-pet-7340/chat
                                                              └─ dsh-pet host（人设+记忆+表情包）→ 桌面气泡
```

## A. 全量云端（当前方案）

```powershell
# 1) 本机打包（不需要 npm install，只用 Node 内置模块）
node cloud\build.mjs                     # → dist\（4.7MB，含 27 张表情包）

# 2) 拷到服务器，按 deploy.md 走（NapCat Docker + .env + systemd）
scp -r dist\* root@<服务器IP>:/opt/dsh-pet/

# 3) 本机开机后拉记忆（Tailscale 或 ssh -L 任一通道）
node backup-pull.mjs --url http://<云端地址>:3020 --token <BACKUP_TOKEN>
```

- 云端配置全在 `.env`：`DEEPSEEK_API_KEY`（必填）、`DEEPSEEK_BASE_URL`、`ONEBOT_WS`、`BACKUP_TOKEN`。
- 人格/表情包/记忆都在 `data/`：`pet.json`（当前人格 + 表情包描述表）、`memory.json`、`memes/`、`backups/`。
- 指令、去重、群 @、白名单、表情包发送**与 B 完全一致**——因为 `qq-bridge.mjs` 一行没改，只是把 `lib/pet-api.mjs` 换成了云端实现。
- 自测：`node cloud\tests\selftest.mjs`（假 LLM + 假 transport，18 项全过，不需要 QQ 也不需要 API key）。

## 云端现状（现在在跑的就是这套）

| 项 | 值 |
| --- | --- |
| 服务器 | `124.220.183.169`（腾讯云，Ubuntu 22.04.5，2C2G，50G） |
| 登录 | 用户 `ubuntu`（`root` 禁止直登），私钥 `.ssh/server.pem`，sudo 免密 |
| 机器人 QQ | `2536561711`，云端 NapCat 已登录（含快速登录记录，重启不用重新扫码） |
| NapCat | Docker 容器 `napcat`（`mlikiowa/napcat-docker`），`restart=always` |
| OneBot | `127.0.0.1:3001`（只绑本机，公网不可达） |
| WebUI | `127.0.0.1:6099`，token `dshpet-napcat-2026`（要看得先开 ssh 隧道） |
| 机器人服务 | systemd `dsh-pet-bot`（active + enabled），代码 `/opt/dsh-pet`，配置 `/opt/dsh-pet/.env` |
| 数据 | `/opt/dsh-pet/data/{pet.json,memory.json,memes/,backups/}` |
| 备份服务 | `127.0.0.1:3020`，启动 + 每 6 小时自动快照；本机用 `pull-memory.cmd` 拉 |
| 日志 | `journalctl -u dsh-pet-bot`、`/opt/dsh-pet/logs/bridge.log`、`docker logs napcat` |

### 机器人身份（头像 / 昵称）

现在这个号在 QQ 里叫 **`dsh大肥鱼·小蓝`**，头像是 `cloud/avatar.png`：从表情包 `压力一只大肥鱼.png` 裁出胸像，铺蓝色渐变圆底 + 白环，640×640。

```powershell
# 重新生成头像（改完 make-avatar.py 的 CROP 就能换构图）
python cloud\make-avatar.py

# 改 QQ 昵称 / 头像（脚本走 OneBot WS，需在服务器上对 127.0.0.1:3001 执行）
scp cloud\avatar.png cloud\set-profile.mjs ubuntu@124.220.183.169:/tmp/
ssh ubuntu@124.220.183.169 "cd /tmp && node set-profile.mjs --avatar /tmp/avatar.png --nick 'dsh大肥鱼·小蓝'"
```

- `set_qq_profile` 改昵称、`set_qq_avatar` 改头像；两者都只影响这个 QQ 号，不动人格。
- 云端 `data/pet.json` 的 prompt 末尾加了一段**【身份】**，告诉她昵称是「dsh大肥鱼·小蓝」、头像是自己、被叫「大肥鱼」要自然应下——否则她会在聊天里说“我改不了名字”。
- `get_login_info` 返回的昵称是登录时的缓存，改完仍显示旧名；用 `get_stranger_info`（`no_cache: true`）才能看到新昵称。

## 本机现状（本机跑法，已经装好、跑通过）

| 项 | 值 |
| --- | --- |
| 机器人 QQ | `2536561711`（沉默的脸藏着沉寂°），用**小号** |
| dsh-pet | 桌宠实例 `main`，显示名「小蓝」，人格 `xiaolan` |
| NapCat | `napcat/shell/`，NapCat 4.18.41，搭在本机已安装的 `D:\QQ`（9.9.36）上 |
| OneBot | 正向 WebSocket `ws://127.0.0.1:3001` |
| WebUI | `http://127.0.0.1:6099/webui?token=` + `napcat/shell/config/webui.json` 里的 token |
| 日志 | `logs/bridge.log`（桥）、`napcat/logs/napcat-console.log`（NapCat 控制台） |

## 人格

| 序号 | id | 名字 | 一句话 |
| --- | --- | --- | --- |
| 1 | `xiaolan` | 小蓝 | 蓝毛小女仆，软软的，干活先喊你主人 |
| 2 | `anmiao` | 阿喵 | 傲娇猫娘，嘴上嫌弃身体很诚实 |
| 3 | `lin` | 凛 | 毒舌女仆长，毒舌但办事靠谱 |
| 4 | `zhixia` | 知夏 | 温柔学姐，慢一点，会记得你上次说的 |
| 5 | `niyujie` | 你鱼姐 | 蓝发大鲸鱼、群聊老资历，随手打字的懒散阴阳，损事不损人（来源 `persona-dafeiyu/你鱼姐.md`） |

### 群聊 / 私聊各用各的人格

`cloud/data/pet.json` 里有一行 `surfaces`，把「场景」映射到人格 id：

```json
"surfaces": { "private": "xiaolan", "group": "niyujie" }
```

- 私聊（`msg.kind === 'private'`）用 `private` 那档，群聊用 `group` 那档；没配的档回落到 `pet.prompt`（也就是 `active`）。
- 在 QQ 里发 `/人格 2`，**只改当前这个场景**：在私聊里换就改私聊档，在群里换就改群聊档——不会互相覆盖。`/人格` 面板顶部两行会显示「私聊：…」和「群聊：…」。
- `identity`（【身份】段：账号昵称 + 头像是我自己 + 「大肥鱼」是爱称）**只拼进私聊档**；群聊档用「你鱼姐」自己的设定，硬塞账号身份会跟人设打架。
- 想换配对：直接改 `surfaces` 那两个值（写人格 id）后 `sudo systemctl restart dsh-pet-bot`，或者在对应场景里 `/人格 N`。
- **记忆也分桶**：私聊写 `memory.json` 的 `main.main`，每个群单独一桶 `main["main@group:<群号>"]`。群里刚跟人斗完嘴，私聊不会跟着阴阳怪气。
  - 早期版本把群聊记录也塞进了私聊桶（assistant 回复是「你鱼姐」口吻，会把小蓝带跑偏），已把那些带 `【昵称】` 前缀的历史挪到 `main["main@group:legacy"]`。

人格写在 `personas.json`：`id / label / name / tagline / prompt`。`name` 会改桌宠的显示名，`prompt` 会写进 dsh-pet 的 `whisperPrompt`——**碎碎念和对话共用这一份**，所以每个人格都同时约束了两件事：碎碎念一句 20 字内、正常对话 1~3 句且不超过 80 字、不用 Markdown。

想加新人格：往 `personas.json` 的 `personas` 数组里加一条，`id` 别重复，然后 `node persona.mjs use <新id>` 试一下。

## 桌面端

```powershell
cd E:\DeepSeekWorkSpace\dsh-pet-qq
node persona.mjs list          # 看有哪些人格
node persona.mjs current       # 现在是谁
node persona.mjs use 3         # 换成 3 号（凛）
node persona.mjs test 在吗     # 让她回一句（同时会弹在桌宠气泡里）
```

切人格会通过 `PUT /dsh-pet-7340/config` 改配置并回读校验，桌宠会立刻改名、换说话风格。

## QQ 端

### 日常启动（两个都在跑就行）

双击 **`start-bot.cmd`**：检查 dsh-pet → 弹 UAC 起 NapCat（自动快速登录小号）→ 等 3001 端口 → 起桥。
只想起桥（NapCat 已经开着）就双击 `start-bridge.cmd`。

### 单独起 NapCat

`napcat\start-napcat.bat`，**必须右键以管理员身份运行**（boot hook 注入 QQ 进程需要管理员权限；普通权限下 QQ 会起来就立刻退出）。
它做的事：设 `NAPCAT_*` 环境变量 → `taskkill` 掉旧 QQ/NapCat → `NapCatWinBootMain.exe "D:\QQ\QQ.exe" NapCatWinBootHook.dll -q 2536561711`。

- `-q 2536561711` 是快速登录，**不用扫码**。
- 会话过期时会退回二维码登录：二维码在 `napcat/shell/cache/qrcode.png`，控制台也打印解码 URL，扫完在小号手机上点「登录」。
- 换账号就改 bat 里的 `QUIN`（或运行时传第一个参数）。

### QQ 里能发的指令

| 指令 | 作用 |
| --- | --- |
| `/帮助` | 指令列表 |
| `/人格` | 看人格列表（顶部标明私聊档 / 群聊档各是谁） |
| `/人格 2`、`/人格 lin` | 换人格——**只改当前场景**：私聊里换动私聊档，群里换动群聊档 |
| `/记忆`、`/记忆 5` | 看最近几轮记忆 |
| `/状态` | 宠物名 / 人格 / 当前气泡 / 统计 |
| `/心思` | 她现在的冲动、心情、今天主动了几次（云端） |
| `/安静`、`/安静 6` | 让她别主动开口（默认 12 小时） |
| `/说话` | 解除安静 |
| `/承诺` | 看她记下的「答应过你的事」 |
| `/ping` | 测活 |

不认识 `/xxx` 会当成普通聊天。

### 主动行为（云端版 P1a）

云端那套会「自己想起来找你说话」，规则都写死了，不靠模型自觉：

- 每 5 分钟算一次「冲动」：越久没聊涨得越快（约 +6/小时），刚聊完会回落；攒到 70 就想开口，成功发一条扣 45。
- 硬约束：23:30–07:30 静默；每天最多 5 条；两条之间至少隔 50 分钟；你 20 分钟内刚说过话就不打扰。
- **答应过的事优先**：聊天里出现「明天九点面试」这类带时间的托付，她会在到点前 20 分钟主动来问结果，不占上面那 5 条配额；连续三次没兑现会记成 missed，之后更谨慎。
- 每次开口前先写一句 20–40 字的「内心独白」（think），和发出去的话一起进 `/opt/dsh-pet/logs/trace.jsonl`，可以翻账：`sudo tail -f /opt/dsh-pet/logs/trace.jsonl`。当下状态用 `/心思` 看。
- 觉得吵就 `/安静`（12 小时），`/说话` 立刻恢复。
- 群聊主动冒泡（P1b）还没做；群聊现在是「被 @ 才回」。

### 谁会被回复

- 私聊：默认都回。
- 群聊：默认**只有 @ 她**才回（`behavior.groupReply`：`at` / `all` / `off`）。注意小号目前没有任何群，要测群聊得先随便加一个。
- 不想让某个人用：填 `bridge.config.json` 的 `userBlacklist`（QQ 号）；只想在特定群说话：填 `groupWhitelist`（群号）。
- 带表情包回复：`behavior.sendMeme` 为 true 时，她会把表情包当图片发出来。池子怎么来的见下一节。

### 表情包（分类包 + 随机一张）

云端现在有 **54 个名字**：原有 27 张 dsh-pet 表情包（`吃白饭的大肥鱼`、`死掉了`、`大的要来了`…），加上从 AstrBot 表情包仓库导入的 **27 个场景分类**：

> 生气 / 笨蛋 / 暧昧 / 疑惑 / 卡壳 / 装傻 / 要钱 / 开心 / 喜欢 / 卖萌 / 早安 / 等回复 / 难过 / 偷看 / 害羞 / 叹气 / 睡觉 / 惊讶 / 干活 / 原神 / 股票涨了 / 股票跌了 / 说股票 / 酷狗 / 库洛拉了 / 库洛神了 / 大笑

- 来源：[`shirachino/astrbot-deepseek-meme-pack`](https://github.com/shirachino/astrbot-deepseek-meme-pack)（109 MB / 138 张），取 manifest 里每个分类「什么时候该用」的描述当语义索引。
- **每个分类是一个目录**（`data/memes/开心/` 下若干张 png/jpg/gif），模型只说「发开心的」，发哪张由服务端**随机挑**——同一分类不会每次都同一张图。
- 协议没变：模型在回复末尾写 `[图:名称]`，云端解析命中后把图转 base64 走 OneBot 发出；名字对不上就丢掉标记、正文照发，绝不吞回复。
- **表情包单独成一条**：文字先发，隔 `imageDelayMs`（默认 600ms）再发图，看起来像「说完话甩一张图」，而不是一条气泡里挤着字和图。
- **不是每条都带图**：`bridge.config.json` 的 `behavior.memeChance`（默认 `0.35`，即约 35% 的回复带一张）+ 提示词里明确要求「大多数回复不要带图」。想更克制调 `0.15`，想逢句必图调 `1`。
- **尺寸已压到正常聊天表情包大小**：`cloud/shrink-memes.py` 把长边缩到 **240px**（LANCZOS，GIF 逐帧保留动画，JPG q88），21.3 MB → 10.3 MB。
- 进池子的图有筛选：每个分类最多 5 张、单张 ≤1.8 MB（超了会先挑小的），`chatImageLimit` 自动等于池子大小（现在是 54）。池子越大提示词越长，54 个名约 1.3k token/条。

换/加表情包的流程：

```powershell
node cloud/fetch-memepack.mjs --repo shirachino/astrbot-deepseek-meme-pack --out downloads/memepack-deepseek
node cloud/import-memes.mjs --pack downloads/memepack-deepseek --data cloud/data --per 5 --maxkb 1800
node cloud/build.mjs
# 打包 dist（排除 data）+ data/memes 新分类 + merge-memes.mjs，scp 上去跑 cloud/remote-deploy-memes.sh
```

分类英文 key 到中文名的映射在 `cloud/import-memes.mjs` 顶部的 `LABELS`；manifest 里有几个 key 带零宽字符，脚本已按清洗后的 key 匹配。

### 对话节奏（像真人那样连发几条）

以前不管说什么都只回一条，像客服。现在一条回复可以被拆成 **1~4 个气泡**，中间隔着「继续打字」的停顿：

- 模型侧：`cloud/lib/pet-api.mjs` 在 system 末尾追加 `REPLY_STYLE`——「像在 QQ 上打字：分 1~3 条短消息（换行隔开），每条尽量 20 字以内，问题再复杂也先说结论」；`personas.json` 每个人格的【输出格式】也补了同样要求。
- 拆分侧：`splitBubbles(text, {max, chance})` 两条路径——模型自己用换行/`||` 分好的直接采纳；模型只给一整句时，**按概率**（`pet.json` 的 `splitChance`，默认 `0.5`）在标点处断一次，短句（<26 字）不拆。
- 收尾规则：去掉列表符号；前几条结尾的「，」「；」会被剥掉（真人分两条发时很少留个逗号吊着）；某条超过 70 字会按句号再切；最后一条拼起来超过 90 字会在标点处截断加「…」。
- 发送侧：`qq-bridge.mjs` 的 `sendReply` 逐条发——第一条等 `typingDelayMs`（默认 300ms），之后每条 `bubbleDelayMs`（默认 700ms）+ 字数×22ms（上限 600）+ 0~250ms 随机，短句快、长句慢。
- 调参：`bridge.config.json` 的 `behavior.maxBubbles`（最多几条，默认 3）、`behavior.bubbleDelayMs`；`cloud/data/pet.json` 的 `maxBubbles` / `splitChance`。想要更话痨就把 `splitChance` 调到 0.8，想要一条说完就调到 0.2。
- 记忆里存的是拼起来的一整段（`segments.join(' ')`），所以下次读历史不会碎成一堆短句。

## 文件

| 文件 | 作用 |
| --- | --- |
| `personas.json` | 人格库 |
| `persona.mjs` | 桌面端命令行：list / current / use / show / test |
| `lib/pet-api.mjs` | 调 dsh-pet HTTP 接口（读写配置、聊天、记忆、表情包） |
| `qq-bridge.mjs` | OneBot v11 正向 WS 客户端 + 对话/指令处理 |
| `bridge.config.json` | 桥的配置：宠物 id、WS 地址、群/私聊策略 |
| `start-bot.cmd` | 一键：起 NapCat + 起桥 |
| `start-bridge.cmd` | 只起桥 |
| `napcat/start-napcat.bat` | 带管理员提权启动 NapCat（内部用 `NapCatWinBootMain.exe`） |
| `napcat/shell/` | NapCat Shell 主体（官方 zip 解压而来） |
| `lib/setup-napcat.mjs` | 写 OneBot 正向 WS 配置（自动认 `shell/` 或 `NapCat.*.Shell/` 布局） |
| `test-bridge.mjs` | 用假 transport 跑一遍全部流程（不需要 QQ） |
| `pet-gateway.mjs` | 把 dsh-pet 接口安全地暴露给隧道：token + 只放行 `/dsh-pet-7340/*` |
| `docs/cloud.md` | 早期方案：云端只跑 NapCat、大脑留在本机（已让位于全量云端） |
| `cloud/` | 全量云端的源码：云端版 `pet-api`、LLM 客户端、存储、备份服务、打包器、自测 |
| `cloud/build.mjs` | 打包 `dist/`：复用桥与人格表，把 `lib/pet-api.mjs` 换成云端实现 |
| `cloud/deploy.md` | 云端部署步骤（服务器、NapCat Docker、systemd、Tailscale 备份） |
| `cloud/deploy-remote.sh` | 服务器侧装 Node 22 + 建用户 + 装 systemd 服务 |
| `cloud/remote-docker.sh` | 服务器侧装 Docker（配腾讯云镜像源）并拉 NapCat 镜像 |
| `cloud/remote-napcat.sh` | 启动 NapCat 容器并打印登录二维码 |
| `cloud/remote-deploy2.sh` | 上传包的解压、`.env`、systemd、NapCat WS 配置一次搞定 |
| `cloud/bot.env` | 云端环境变量（含 DeepSeek key、BACKUP_TOKEN），不提交到任何公开仓库 |
| `cloud/lib/agency.mjs` | 「心思」状态：冲动积累、心情、静默时段、冷落计数 |
| `cloud/lib/commitments.mjs` | 承诺抽取与到点提醒（`data/commitments.json`） |
| `cloud/lib/proactive.mjs` | 主动开口 / 兑现承诺的提示词与 `{think,say}` 解析 |
| `cloud/lib/scheduler.mjs` | 定时 tick + 闸门（静默/日上限/间隔/暂停）+ 决策日志 |
| `cloud/make-avatar.py` | 生成 dsh大肥鱼 主题头像 `cloud/avatar.png`（Pillow） |
| `cloud/set-profile.mjs` | 走 OneBot WS 改机器人昵称 / 头像 |
| `cloud/fetch-memepack.mjs` | 从 jsDelivr CDN 拉 AstrBot 表情包仓库（GitHub 直连只有 7KB/s，CDN 约 1MB/s） |
| `cloud/import-memes.mjs` | 表情包仓库 → `data/memes/<中文分类>/`，并把分类描述合并进 `pet.json` 的 `memes` |
| `cloud/merge-memes.mjs` | 服务器侧：把 `memes.extra.json` 合进线上 `pet.json`（不动人设与记忆） |
| `cloud/remote-deploy-memes.sh` | 服务器侧一键：更新代码 + 解表情包 + 合并 + 重启 |
| `cloud/shrink-memes.py` | 表情包缩图：长边 240px，GIF 逐帧，21.3 MB → 10.3 MB |
| `cloud/remote-deploy-v2.sh` | 服务器侧一键：更新代码 + memes + 合并 `surfaces`/`identity` + 重启 |
| `pull-memory.ps1` / `pull-memory.cmd` | 本机拉云端记忆：自动开 ssh -L 隧道再跑 `backup-pull.mjs` |
| `dist/` | 打包产物（自包含，scp 到服务器即可运行） |
| `backup-pull.mjs` | 本机侧拉取云端记忆到 `backups/`（开机跑一次） |
| `lib/download.mjs` | 带断点续传的下载器（本机直连 GitHub 慢，走 api.github.com / gh-proxy） |

## 换台机器 / 重装

1. 确认 dsh-pet 在跑、`http://127.0.0.1:2627/dsh-pet-7340/state` 能打开。
2. `node persona.mjs use 1` 装人格。
3. 解压 `napcat/NapCat.Shell.zip` 到 `napcat/shell/`，`node lib/setup-napcat.mjs --uin <QQ号>` 写 WS 配置。
4. 以管理员运行 `napcat/start-napcat.bat`，扫码登录一次；之后 `start-bot.cmd` 一键起。
5. 本机已安装的 QQ 路径写死在 bat 里（`D:\QQ\QQ.exe`），换机要改。

## 已知限制

- **机器人跑在这台电脑上时，本机的 QQ 不能同时登主号**：NapCat 占用同一个 QQ 实例，只能登一个小号。主号用手机或另一台机器。
- NapCat 的 boot hook **必须管理员权限**，否则 QQ 起来就退出。
- 从安装包 `7z` 解出来的「便携 QQ」**不可用**：启动即退出（`0x80000003`，过不了 QQ 的安装信任检查）。所以走的是本机正常安装的 `D:\QQ`。那条死路留下的 `napcat/qqinstall/`（1.1GB）与 `napcat/QQ_9.9.33_*.exe`（314MB）已经删掉，`napcat/NapCat.Shell.zip`（34MB）留作重装 NapCat 用。
- 记忆是**按宠物实例**存的（`%USERPROFILE%\.dsh\dsh-pet\memory.json`），QQ 群聊和私聊共用同一份，所以群聊里正文会带 `【昵称】` 前缀让她分得清谁在说话。
- `/人格` 切换是全局的：换了之后桌面和 QQ 同时换。
- 同一个 QQ 号在别处登录会把 NapCat 踢下线，桥会自动重连但需要重新登录。
- 本次是由 DSH 会话在后台起的 NapCat 与桥，**会话/后台作业结束时它们会一起停**（NapCat 的提权进程也挂在同一个进程树上）。之后再想用，双击 `start-bot.cmd` 即可：它会重新弹 UAC 起 NapCat、等 3001 就绪、再起桥，全程不用扫码。

## 想在本机正常登主号？

本机实测：同一个 Windows 用户里 **QQ 只能开一个实例**（换安装目录、加 `--user-data-dir` 都直接退出），所以 NapCat 占着 QQ 时没法同时登主号。三条出路：

1. **全量云端（当前方案）**：QQ 小号、NapCat、大脑全搬服务器，本机 QQ 随便登主号；记忆在云端，开机时用 `backup-pull.mjs` 拉回来。见 [`cloud/deploy.md`](cloud/deploy.md)。
2. **一键切换**：主号要用电脑时关掉机器人，用完再 `start-bot.cmd` 切回来。
3. **主号用手机**：本机只挂小号，零改动。
