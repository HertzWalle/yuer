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
| 6 | `mingyue` | 溟月 | 赛博蓝鲸、第七机房社畜，抱着印「饭」字的碗讨饭，嘴硬尾巴软，怕被遗忘（来源 `persona-dafeiyu/溟月·DSH.md`） |

### 群聊 / 私聊各用各的人格（还能给每个群单独设）

`cloud/data/pet.json` 里有一行 `surfaces`，把「场景 / 具体群」映射到人格 id：

```json
"surfaces": {
  "private": "xiaolan",
  "group": "niyujie",
  "groups": { "1106592574": "zhixia" }
}
```

- 私聊（`msg.kind === 'private'`）用 `private`；群里先看 `groups[群号]`（这个群单独设过就用它），没有就退到 `group`（所有群的默认）；都没有就回落 `pet.prompt`（`active`）。
- **在 QQ 里换**（只有主人发才生效）：
  - 在私聊里 `/人格 2` → 换私聊档
  - 在某个群里 `/人格 2` → **只换这个群**
  - 在私聊里 `/人格 群 1106592574 2` → 远程给指定群换（不用先进那个群）
  - `/人格 群 1106592574` → 只看那个群现在是谁；`/人格` → 面板列出私聊、群默认、所有单独设置的群
- `identity`（【身份】段：账号昵称 + 头像是我自己 + 「大肥鱼」是爱称）**只拼进私聊档**；群聊档用「你鱼姐」自己的设定，硬塞账号身份会跟人设打架。
- **记忆也分桶**：私聊写 `memory.json` 的 `main.main`，每个群单独一桶 `main["main@group:<群号>"]`。群里刚跟人斗完嘴，私聊不会跟着阴阳怪气。
  - 早期版本把群聊记录也塞进了私聊桶（assistant 回复是「你鱼姐」口吻，会把小蓝带跑偏），已把那些带 `【昵称】` 前缀的历史挪到 `main["main@group:legacy"]`。
- **换人格会切断旧语气（v1.6.1）**：人设切对了但模型照着旧记录学说话（切到小蓝还自称「姐」）——`applyPersona()` 现在会往该会话桶写一条 `mark: 'persona'` 的界碑，之后喂给模型的历史**只从界碑开始**；主动消息、群旁听、说说生成也走同一个入口（`recentForContext()`）。界碑那行不会出现在 `/记忆` 里。
  - 想给历史补一次同样的界碑：再发一次 `/人格 <现在的序号>` 即可（重写配置 + 新界碑）。

### 谁说话算数（指令权限 + 认人）

- 指令**只认主人**：`bridge.config.json` 的 `proactive.ownerIds`（现在只有 `1360153202`）。群里别人发 `/人格`、`/安静`、`/空间 发` 之类，桥直接吞掉——不回复、不改任何配置，只在日志里记一行「忽略非主人指令」。
- 群里每条消息进模型前都会带上说话人：`【昵称】正文`；主人会额外标成 `【昵称·主人】`。所以同一个群里张三李四说话她分得清，也知道哪句是主人在说。
- 记忆按群分桶之后，A 群的人不会在 B 群被「认成」熟人。

### 群里的称呼（叫群昵称，不拿 QQ 号凑数）

群里一堆人，模型得先知道「现在是谁在说话、别人 @ 的是谁」，不然就会出现两种尴尬：把随便哪个群友都叫「主人」、或者复述一串 `@1360153202`。

- **说话人用群名片**：每条群消息先查 `get_group_member_info`（缓存 30 分钟、上限 500 条），拿到群昵称写进 `【半欢】`；取不到才退昵称、最后才用 QQ 号。
- **身份说死**：模型输入前面会插一行——
  - 群友说话：`【群聊】说话的是群友「半欢」，不是主人；主人是群里的「HudsonZephyr」。别把群友叫成主人，也别拿 QQ 号当名字。`
  - 主人说话：`【群聊】这条是主人本人说的（群里叫「HudsonZephyr」）。`
  - 主人有多个号（`proactive.ownerIds`）时，按「谁真的在这个群里」挑名字，都不在群里才退回「主人」。
- **@ 谁就翻成谁的名字**：正文里的 `@1360153202` 会改写成 `@HudsonZephyr`，模型看到的是名字，不会再把 QQ 号当成人名去「锐评」。
- 私聊不加这一行（一对一没必要）。

### 引用回复（接得上「你刚才说的那句」）

QQ 里长按消息「引用」再发一句，是最常见的接话方式。现在两个方向都支持：

- **进**：消息里带 `reply` 段时，桥用 `get_msg` 把被引用的那句原话取回来（10 分钟内同一条只取一次），拼进模型输入——
  `【小明】（引用了你自己刚才说的话：「你行你上啊」）` + 换行 + 正文。
  引用的是别人的话就显示 `引用了<昵称>的话`。取不到原话（消息被撤回、权限不够）就安静忽略，只当普通消息处理，不会卡住回复。
- **只引用她、不 @ 也算对她说话**：QQ 里引用一条消息再输入内容时通常不会带 @，以前这种消息会被当旁听放过去；现在只要引用的**是她自己说过的话**，就正常回（日志里记一行「引用了她说过的话」）。
- **出**：`behavior.quoteReply` 控制要不要回带引用，默认 `auto`：

  | 值 | 行为 |
  |---|---|
  | `auto`（默认） | 被人引用时一定引用回去；群里对她说话时（@ 或引用她的话）也引用；私聊其余情况不引用（普通聊天不该每条都像个工单） |
  | `always` | 每条都带引用 |
  | `off` | 从不带引用 |

  带引用时只有**第一条气泡**挂 `{type:'reply',data:{id}}`，后面几条接着同一个话头，不会刷出一堆引用框。

线上验证（`cloud/tests/probe-quote.mjs`，服务器副本数据 + 真打一次模型）：

```
群引用 → {"id":"g-quote-1"} | 来啊，谁怕谁            （回的是「你行你上啊」那句）
私聊引用 → {"id":"p-quote-1"} | 当然作数              （回的是「周末要不要出去走走」）
```

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

> **只有主人（`proactive.ownerIds`，当前 `1360153202`）发的指令生效。** 群里或私聊里别人发的 `/人格`、`/安静` 之类会被直接吞掉——不回复、不改配置，只在日志里留一行。

| 指令 | 作用 |
| --- | --- |
| `/帮助` | 指令列表 |
| `/人格` | 面板：私聊档 / 群聊默认 / 每个群单独设置的人格 + 人格列表 |
| `/人格 2`、`/人格 lin` | 换当前场景的人格——私聊里改私聊档，**群里只改这个群** |
| `/人格 群 1106592574 2` | 在私聊里远程给指定群换人格（也能 `/人格 群 1106592574` 只看那个群） |
| `/记忆`、`/记忆 5` | 看最近几轮记忆 |
| `/状态` | 宠物名 / 人格（群里会多一行本群人格）/ 当前气泡 / 统计 |
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
- 群聊主动冒泡见下一节（S2）：不 @ 她也会旁听，攒够了才偶尔插一句。

### 群里的分寸（S2 群注意力）

群里不 @ 她，她也「在场」——但门槛比私聊高一截，宁可不说也不刷存在感：

- **旁听**：群里每条消息都会进旁听缓冲（`data/groups.json`），普通消息 +2 冲动、被 @ +20、聊到她记得的事 +15、气氛好（哈哈哈/厉害/谢谢）+5。冲动**只在群里有人说话时**才涨，安静一个小时会慢慢回落。
- **开口门槛**：冲动 ≥ **120**（私聊是 70）；开口一次扣 **120**；**每个群每天最多 1 次**；同群两次之间至少 **6 小时**；23:30–07:30 全体静默。
- **先打分再说话**：过了门槛还要模型当旁观者打分（0~10，现在插话自不自然），低于 **7** 就不说，并把冲动扣 30（下次别马上又问一遍）。打分理由会带进起草提示词。
- **反感度是硬开关**：有人明确制止（「别说话」「闭嘴」「消停点」）+30（对着她说 +40）、抱怨/嫌吵 +20、她说完 3 分钟内群里又冒出两句却没人接 +10，每小时自然回落 2。到 60 立刻冷却 12 小时、到 100 冷却 7 天，冷却期冲动清零。**不是写进提示词劝它，而是直接把欲望归零。**
- **插话不带 @**：模型不 @ 任何人（被点名回答时才是正常回复），所以看起来像群里随口接一句。
- 想关掉群旁听：`bridge.config.json` 的 `behavior.observeGroups: false`（或 `proactive.group.enabled: false` 只关插话、保留观察）。
- 被冷却了想立刻解禁：`/解禁 群号`（不带群号 = 当前群 / 列出各群状态）——清掉反感度、冷却、冲动和「说完没人接」的记账，只认主人。
- 想看每个群的账：`/心思` 末尾会列出各群「冲动/120、反感、冷却、今天几次」。翻账：`sudo tail -f /opt/dsh-pet/logs/trace.jsonl`（`group-gate` / `group-skip` / `group-proactive` / `group-cooldown`）。
- 调参都在 `bridge.config.json` 的 `proactive.group`：`threshold`、`dailyPerGroup`、`minGapHours`、`scoreMin`、`bufferMin`、`perMessage`、`mentionBonus`、`topicBonus`。

### QQ 空间（A 档读动态 / B 档发说说）

> 需求来源见 `docs/ROADMAP.md` 的 S3；用户定的档位是「#3 做到 B 档」。**默认 `dryRun: true`**，只生成不发布。

- **A 档 · 看**：每天 `readHour`（默认 21 点）通过 OneBot `get_cookies` 拿 qzone cookie，用 `p_skey` 算 `g_tk`，走 `emotion_cgi_msglist_v6` 读主人和她自己的动态；只收 `freshDays`（30 天）内的，每条压成一句写进 **语义记忆** `data/semantic.json`（同文 7 天去重、最多留 60 条）。私聊的 system prompt 会带上最近 5 条（`【你最近看到的】…别刻意汇报`），所以她会「记得你发过什么」，但不会背课文。
- **B 档 · 发**：每天最多 **1 条纯文字**说说，只在冲动 ≥ `impulseThreshold`（默认 85）且当天没发过时才考虑；先让模型写一句（≤90 字、不要话题标签/链接/@、不要营销腔），`cleanMood()` 清洗后再发。
- 发布优先走 NapCat 原生 action **`send_qzone_msg`**（`{content, images: [], ugc_right: 1, target_uins: []}` → `{tid}`）；不可用时退回网页 CGI `emotion_cgi_publish_v6`。发成功后 QQ 客户端里那套「发布了动态 / 已发布」卡片是它自己渲染的，不需要伪造。
- 安全阀：`dryRun` 时只在 trace 写一条 `qzone-dry`；连续失败 `maxFails`（3）次自动停用并写 `qzone-disabled`；`/空间 关` 一刀切。
- 指令：
  - `/空间` —— 面板：启停、看动态时间、今天读没读、发说说配额、今天发没发、连败次数
  - `/空间 发 <文字>` —— 立刻手动发一条（仅主人；会跳过 dryRun）
  - `/空间 读` —— 立刻读一次动态并写进语义记忆
  - `/空间 关` / `/空间 开` —— 停用 / 恢复（恢复时清掉连败计数）
- 配置在 `cloud/data/pet.json` 的 `qzone` 段：`enabled`、`readHour`、`readNum`、`freshDays`、`publishEnabled`、`dailyLimit`、`impulseThreshold`、`impulseCost`、`maxChars`、`dryRun`、`maxFails`。
- 已知边界：`g_tk` 必须用 **p_skey**、域名必须是 `taotao.qq.com`（`taotao.qzone.qq.com` 会返回 `code=-10000 使用人数过多`）；skey 会过期，过期后读/发都会失败并计一次 fails；非官方接口，频率高了有风控风险——所以日上限写死 1 条、默认 dryRun。
### 她自己的生活（B 站 / 抖音，S3）

`cloud/lib/feeds.mjs` + 调度器每天在 `feeds.hours`（默认 10 点、20 点）各刷一次，只读、不登录、不点赞：

- **B 站**：`api.bilibili.com/x/web-interface/popular`（热门，需 UA + `referer: https://www.bilibili.com/`），压成一行 `B站热门：<标题>｜UP：<up>｜<分区>｜<2.3万播放>`。
- **抖音**：走第三方聚合 `https://60s.viki.moe/v2/douyin`（榜单本身是公开的，不碰抖音客户端、不做自动化登录），压成 `抖音热搜：<标题>（<热度>）`。
- 每条按 `importance 0.35` 写进语义记忆（比「主人发的说说」低：热搜是背景噪音，不是关系）；同小时只刷一次，`agency.feeds.days` 只留 7 天。
- 聊天时不会报流水账：私聊 system prompt 里的 `【你最近看到的】` 只列最近 6 条，并要求「最多顺口提一条、别汇报、别列清单」；与其当前这句话相关的旧事会被 `recall()` 单独挑出来。
- 关注 UP 的更新需要登录 cookie，这版没做（我们没有 B 站账号）。
- 配置在 `cloud/data/pet.json` 的 `feeds` 段：`enabled`、`hours`、`biliLimit`、`douyinLimit`。

### 记忆分层（S5）

| 层 | 存在哪 | 谁在用 | 说明 |
| --- | --- | --- | --- |
| L1 情节记忆 | `data/memory.json` | 每轮对话 | 原文全存、按会话分桶（私聊 `main`、群聊 `main@group:<群号>`） |
| L2 压缩摘要 | `data/summaries/<bucket>.json` | 每轮注入 | 超过 `maxHistoryTokens`（900）的 82% 时，把更早的轮次压成一段摘要（≤700 字）；摘要太长再做「摘要的摘要」；模型不可用时按轮截断兜底 |
| L3 语义记忆 | `data/semantic.json` | 聊天时 `recall` / `/看到` | 每条带 `importance`、`lastUsedAt`；每天衰减 0.02，30 天没用且 <0.15 的归档到 `data/archive/`（不删） |
| 自我模型 | `data/self.json` | 每轮注入（私聊） | ≤220 字「我是谁 / 我在意什么」；一天最多更新一次，与旧文本重合度 <0.35 判漂移直接拒绝 |

- `/记忆 [n]` 顶部会显示压缩摘要，下面是最新一轮原文；`/看到 [n]` 是她最近刷到的；`/忘记 <词>` 只删语义记忆（对话原文不动）；`/我是谁` 看自我模型。- 参考了 AstrBot 的 `compressor.py`（阈值 0.82、保留最近 15%、摘要拼成 user/assistant 一对注入），我们额外做了摘要**落盘**、摘要的摘要、以及自我模型的双闸。

### 换接入层（`/turn`，S4）

大脑和传输解耦：任何接入层对着 `POST /turn` 发一句话，就能拿到「按人设生成的若干条气泡 + 表情包名字」。

```dotenv
# .env 里配上就自动启动（默认只听回环，别暴露公网）
TURN_TOKEN=<openssl rand -hex 24>
TURN_HOST=127.0.0.1
TURN_PORT=3030
```

```bash
curl -s http://127.0.0.1:3030/turn \
  -H 'content-type: application/json' -H "x-turn-token: $TURN_TOKEN" \
  -d '{"conv":"private:1360153202","user":{"id":"1360153202","name":"主人"},"text":"在吗"}'
# → {"ok":true,"segments":["在的呀主人。","刚还在想你咋突然没声了。"],"image":"睡觉",...}
```

- 契约、错误码、curl 示例：`dsh-pet-qq/docs/TURN.md`；参考适配器：`dsh-pet-qq/adapters/astrbot_plugin_yuer/`。
- **只解耦「一轮对话」**：主动性、指令、引用回复、表情包出站仍在 OneBot 桥里（A 方案才是全功能；C 方案是「AstrBot 当传输层」）。

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
- **不是每条都带图，而且「有没有配图资格」在生成前就定了**：`cloud/lib/pet-api.mjs` 的 `memeGate()` 先掷骰子——私聊 `pet.json` 的 `memeChancePrivate`（默认 `0.18`）、群聊 `memeChanceGroup`（默认 `0.06`）。没资格时**整份表情包清单都不塞给模型**（省下约 1.3k token/轮），只让它正常说话；模型万一还是写了 `[图:…]`，`stripMemeTag()` 会兜底剥掉。
- 会话级冷却：`memeCooldown`（默认 `5`）条之内带过图就强制没资格，避免连着甩图；`memeEnabled: false` 可一键关掉。`/状态` 会显示最近 20 条里实际带图的比例（`noteChatter()` 记在 `data/chatter.json`，只记有没有图、不记正文）。
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

### 掉线自愈与告警（watchdog）

QQ 的登录态不是永久的：小号被手机端踢、或者隔几天 token 过期，NapCat 就只能重新扫码。之前这种掉线
是「安静的」——桥每分钟重连一次、日志刷屏，人却不知道。

- **桥侧**：重连日志前 5 次逐条记、之后每 10 次一条，并带上「已断开 N 分钟」；
  第 20 次、第 60 次（≈1 小时）各打一条 `ERROR` 提示「需要重新扫码」；恢复时打印「断了约 N 分钟」。
- **主机侧**：`cloud/watchdog/yuer-watchdog.sh` + systemd timer，每 5 分钟检查 `127.0.0.1:3001`；
  连续 4 次不通就 `docker restart napcat`（最多 1 次/小时），日志在 `/var/log/yuer-watchdog.log`。
  登录态还在时它能自己救回来；掉登录时它会生成新二维码，人扫码后桥自动接上。
- **人工恢复**：本地跑 `refresh-qr.ps1` 拿新码扫码即可，不用动服务器。
### 看图（图片不再只是「[图片]」）

她真的会看图：消息里的图片会先被视觉模型读成一句中文，再进上下文。

- **实现**：`cloud/lib/vision.mjs` 的 `describeImage(url)`——下载图片（单张 ≤4MB、15s 超时）→ base64 塞进
  `image_url` → 一句话描述；按 URL 的 sha1 缓存 7 天（`data/vision-cache.json`，最多 300 条），同一张图只花一次钱。
- **三种入口**：①这条消息带的图 → 正文里写成 `[图片：…]`；②被引用的消息带图 → 连同「那张图是什么」一起给模型；
  ③每个会话记最近 3 张图（20 分钟），回话时附一段「这个会话里刚发过的图」，解决「这样」「这个」指向不明。
- **省钱**：旁听（没 @ 她）的群消息不识别，等真要接话时才按需看图。
- **降级**：看图失败（链接过期、超时、格式不认）就退回 `[图片]`，绝不因为看图失败而不回消息。
- **不再写舞台指示**：`stripActionNotes()` 会抹掉「（歪头）」「（尾巴摇了一下）」这类括号动作，
  情绪靠语气词和句子本身（「本鲸尾巴都翘起来了」）；「（DeepSeek）」这种专有名词的括号保留。
### 对话节奏（像真人那样连发几条）

一条回复可以是一整段、也可以是 **2~6 个气泡**，条数由内容决定，不再写死：

- 模型侧：`REPLY_STYLE` 让它自己选——「想连发就分成 2~4 条短句（每条约 20 字）；想一口气说完就整段一条，别为了拆而拆」。
- 拆分侧：`splitBubbles(text, { max, bias })` 先看模型有没有自己分段（换行/`||`）；只给一段时按字数决定形态——≤30 字多数整条（30% 概率断成两条）、30~90 字有 40% 保持整段一条（长段落模式）否则切 2~3 条、>90 字**默认整段一条**，只有句读 ≥2 才按句子切、最多 4 条（没标点的长文绝不硬拆）。
- 软上限：`maxBubbles`（`pet.json`，默认 6、上限 8）；超了不做「全塞最后一条」，而是**反复合并最短的相邻一对**，保住说话的节奏。允许「嗯」「好」这种两字气泡单独成条。
- 想到一句再补：最后一条如果 ≤12 字，发送侧会多等 `behavior.tailPauseMs`（默认 800ms）——像打完一句又想起半句。
- 发送侧：第一条等 `typingDelayMs`（默认 300ms），之后每条 `bubbleDelayMs`（700ms）+ 字数×22ms（≤600）+ 0~250ms 随机，短句快、长句慢。
- 调参：`behavior.maxBubbles` / `tailPauseMs` / `bubbleDelayMs`；`cloud/data/pet.json` 的 `maxBubbles` / `splitChance`（0.5 基准，调大更容易拆、调小更容易整段）。
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
| `cloud/lib/groups.mjs` | 群聊冲动 / 反感度 / 冷却（`data/groups.json`），全部是硬阈值 |
| `cloud/lib/group-chat.mjs` | 群聊两步走：旁听打分（0~10）+ 起草一条短句 |
| `cloud/make-avatar.py` | 生成 dsh大肥鱼 主题头像 `cloud/avatar.png`（Pillow） |
| `cloud/set-profile.mjs` | 走 OneBot WS 改机器人昵称 / 头像 |
| `cloud/fetch-memepack.mjs` | 从 jsDelivr CDN 拉 AstrBot 表情包仓库（GitHub 直连只有 7KB/s，CDN 约 1MB/s） |
| `cloud/import-memes.mjs` | 表情包仓库 → `data/memes/<中文分类>/`，并把分类描述合并进 `pet.json` 的 `memes` |
| `cloud/merge-memes.mjs` | 服务器侧：把 `memes.extra.json` 合进线上 `pet.json`（不动人设与记忆） |
| `cloud/remote-deploy-memes.sh` | 服务器侧一键：更新代码 + 解表情包 + 合并 + 重启 |
| `cloud/shrink-memes.py` | 表情包缩图：长边 240px，GIF 逐帧，21.3 MB → 10.3 MB |
| `cloud/lib/qzone.mjs` | QQ 空间：`get_cookies` → `g_tk`(p_skey) → `send_qzone_msg` / `emotion_cgi_publish_v6` 发说说，`emotion_cgi_msglist_v6` 读动态 |
| `cloud/lib/semantic.mjs` | 语义记忆 `data/semantic.json`：importance / 关键词 `recall` / 衰减归档 / `forget` |
| `cloud/remote-deploy-v2.sh` | 服务器侧一键：更新代码 + memes + 合并 `surfaces`/`identity` + 重启 |
| `cloud/remote-deploy-v4.sh` | 服务器侧一键：v1.3 表情包资格/气泡参数合并 + 重启 |
| `cloud/remote-deploy-v5.sh` | 服务器侧一键：v1.3 全量参数（含 `qzone` 段）+ 重启 |
| `cloud/remote-deploy-v6.sh` | 服务器侧一键：v1.4 按群人格（`surfaces.groups`）+ 重启 |
| `cloud/remote-deploy-v7.sh` | 服务器侧一键：v1.5 引用回复（补 `behavior.quoteReply`）+ 重启 |
| `cloud/lib/feeds.mjs` | B 站热门 + 抖音热搜聚合：抓取、解析、压成一行语义记忆 |
| `cloud/lib/vision.mjs` | 看图：图片 → 一句中文描述（按 URL 缓存 7 天） |
| `cloud/watchdog/` | systemd timer：3001 不通就重启 NapCat（最多 1 次/小时） |
| `cloud/lib/memory-manager.mjs` | L2 压缩摘要（落盘 `data/summaries/`）+ 自我模型（`data/self.json`，24h/drift 双闸） |
| `cloud/lib/turn-server.mjs` | S4 的 `POST /turn` 契约（token 鉴权、默认只听回环） |
| `cloud/lib/version.mjs` | 读 `VERSION` 给 `/health` 用 |
| `cloud/remote-deploy-v8.sh` | 服务器侧一键：v1.6 部署（代码 + `feeds`/`memory` 配置 + 可选 `TURN_TOKEN`） |
| `docs/TURN.md` | `/turn` 契约文档：请求/响应/错误码/curl/接入层还缺什么 |
| `adapters/astrbot_plugin_yuer/` | AstrBot 参考适配器（只做传输，逐条 yield 成气泡） |
| `cloud/tests/probe-quote.mjs` | 线上探针：假 transport 带 `call`，验证进出两个方向的引用 |
| `cloud/remote-verify-v4.sh` | 服务器侧干净副本验证：拷贝 data/personas/lib → 真打模型 → 打印气泡与带图比例 |
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
