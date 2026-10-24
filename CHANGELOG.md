# CHANGELOG

版本号遵循 `MAJOR.MINOR.PATCH`：加了用户能感知的新能力 → MINOR；只修 bug / 调参数 → PATCH；
架构大改或跑不通旧数据 → MAJOR。当前版本见根目录 `VERSION`，每个版本打一个 `vX.Y.Z` 标签。

## v1.3.0 — 2026-10-24

更像真人、也更省 token：表情包改成「先决定要不要配图」，气泡条数改由内容决定，并给她加上 QQ 空间（看动态 + 每天最多一条说说）。

- `feat(memes)`: 配图资格前移到**生成层**——`cloud/lib/pet-api.mjs` 的 `memeGate()` 每轮先掷骰子（私聊 `memeChancePrivate` 0.18 / 群聊 `memeChanceGroup` 0.06 / `memeCooldown` 5 条内带过图就锁），没资格时**整份表情包清单都不进 prompt**（省约 1.3k token/轮）；模型硬写 `[图:…]` 时 `stripMemeTag()` 兜底剥掉。
- `feat(memes)`: 新增 `data/chatter.json`（`noteChatter` / `chatterStats`，只记有没有图不记正文），`/状态` 显示最近 20 条实际带图比例；`behavior.memeChance` 从发送层删除（挑完图再扔掉是白花 token）。
- `feat(chat)`: `splitBubbles()` 重写为按内容决定形态——≤30 字多数整条、30~90 字 40% 保持整段否则切 2~3 条、>90 字默认整段（句读 ≥2 才切、最多 4 条）；`maxBubbles` 默认 6（上限 8），超限改成「反复合并最短的相邻一对」；允许两字气泡；最后一条 ≤12 字时多等 `behavior.tailPauseMs`（800ms）。
- `feat(qzone)`: 新增 `cloud/lib/qzone.mjs`——`callOneBot()` 一次性 WS 调 `get_cookies`，`gTk()` 用 **p_skey** 算 `g_tk`；发布优先走 NapCat 原生 `send_qzone_msg`，退回网页 `emotion_cgi_publish_v6`；只用 `emotion_cgi_msglist_v6` 读动态（NapCat 没有可用的读列表 action）。
- `feat(semantic)`: 新增 `cloud/lib/semantic.mjs` + `data/semantic.json`——看到的事压成一句（同文 7 天去重、最多 60 条），私聊 system 拼 `notesBrief()`（群里不注入）。
- `feat(qzone)`: `cloud/lib/scheduler.mjs` 加 `runQzone()`——到 `readHour`（21 点）读一次动态写语义记忆；`publishEnabled` + 冲动 ≥85 + 当天未发才发一条 ≤90 字纯文字说说；`dryRun` 默认 true 只写 `qzone-dry`；连败 3 次自动停用（`qzone-disabled`）。指令 `/空间`、`/空间 发 <文字>`、`/空间 读`、`/空间 关`、`/空间 开`。
- `feat(proactive)`: 新增 `generateMood()`——写说说用的提示词（一句话、不要标签/链接/@、不要营销腔、没话说 SKIP）。
- `fix(scheduler)`: 空间配置原本读 `bridge.config.json` 拿不到（配置在 `pet.json` 的 `qzone` 段，表现为 `runQzone` 直接 return）→ 改成 `qzConfig()` 懒加载 pet.json。
- `fix(build)`: `dist/` 会带上本机自测写的 `logs/trace.jsonl`，部署时把线上决策日志冲掉 → build 结束删 `dist/logs`，打包再加 `--exclude logs`。
- `test`: 自测 52/52（新增 6 项气泡形态、1 项配图冷却、5 项空间助手函数）。


## v1.2.0 — 2026-10-24

S2 群注意力：群里不 @ 她也会「旁听」，攒够了才决定要不要自己插一句。

- `feat(groups)`: 新增 `cloud/lib/groups.mjs`——每群一套 `impulse / annoyance / lastSpokeAt / sentToday /
  cooldownUntil`，存 `data/groups.json`；冲动来源 = 每条消息 +2、被 @ +20、话题命中她记得的事 +15、
  气氛正向 +5；阈值 120、开口一次扣 120、每群每天 1 次、同群间隔 ≥6 小时。
- `feat(groups)`: 反感度（`annoyance`）按信号累加——显式制止 +30（对着她说 +40）、抱怨/嫌吵 +20、
  说完 3 分钟内群里冒出 2 句以上却没人接 +10；自然衰减 −2/小时；≥60 立刻冷却 12 小时、≥100 冷却 7 天，
  冷却期间冲动清零。**反感直接改行为，而不是只写进提示词。**
- `feat(group-chat)`: 新增 `cloud/lib/group-chat.mjs`——两步走：先让模型当旁观者给「现在插话自不自然」
  打 0~10 分（低于 `scoreMin=7` 直接放弃并扣 30 冲动），过了再起草 1~2 条短句，支持 `[图:名称]` 与 SKIP。
- `feat(bridge)`: 群里没 @ 的消息不再直接丢弃——`normalizeMessage(ev, behavior, { observeGroups })`
  把它们标成 `observeOnly` 交给 `scheduler.onGroupMessage()` 旁听，不回复、不刷日志正文；
  被 @ 的消息同样喂给旁听（算 +20 冲动）。
- `feat(scheduler)`: `tick()` 里群聊独立结算（私聊暂停/静默不影响群，反之亦然）；`/心思` 末尾多出
  每个群的冲动 / 反感 / 冷却 / 今日次数。
- `feat(config)`: `bridge.config.json` 的 `proactive.group` 一节（阈值、配额、间隔、评分线、加成），
  `behavior.observeGroups`（默认 true）可整开关掉群旁听。
- `fix(store)`: `saveGroups()` 里再包一层 `withLock` 会和 `writeJson` 自锁死（自测挂住 5 分钟才发现）——
  改成直接调 `writeJson`。
- `chore(build)`: `dist/` 不再携带 `logs/`（上次部署把本机自测的 `trace.jsonl` 带到了线上）。
- 自测 39/39（新增 6 项：旁听记冲动、冲动够了插话、插话不带 @、同群当天不插第二次、反感冷却、静默不插话）。
## v1.1.0 — 2026-10-24

对话节奏：一条回复可以拆成 1~4 个气泡连发，不再永远「一句一气泡」。

- `feat(pet-api)`: 新增 `splitBubbles()`——模型用换行/`||` 自己分段时直接采纳；只给一整句时按
  `splitChance`（默认 0.5）在标点处断一次，短句（<26 字）不拆；剥掉前几条结尾的逗号/分号；
  单条 >70 字按句号再切；末尾拼接超过 90 字在标点处截断加「…」。
- `feat(pet-api)`: system 末尾追加 `REPLY_STYLE` 打字约束（1~3 条、每条约 20 字、先说结论），
  `personas.json` 五个人格的【输出格式】同步补充。
- `feat(bridge)`: `sendReply` 逐条发气泡，第一条等 `typingDelayMs`，之后每条
  `bubbleDelayMs` + 字数×22ms(≤600) + 0~250ms 随机；`behavior.maxBubbles`（默认 3）、
  `behavior.bubbleDelayMs`（默认 700）可调。
- `feat(data)`: `cloud/data/pet.json` 增加 `maxBubbles` / `splitChance`。
- `fix(bridge)`: `/记忆` 命令引用了不在作用域内的 `conv`（`ReferenceError: conv is not defined`），
  群里/私聊发 `/记忆` 都会直接回「脑袋卡住了」——现在在 `handleCommand` 内部自己算 `conv`。
- `chore(scripts)`: 新增 `scripts/push-api.mjs`——走 `api.github.com` 的 Git Data API 提交（比对工作区与
  远端树，只传差异 blob），绕开 github.com 的 smart HTTP；push 一直 `Request timed out` 时用它。
  用法：`node scripts/push-api.mjs "提交说明" [--tag] [--dry]`。
- 自测 33/33（新增「模型分段时发成多个气泡」用例；测试里把 `bubbleDelayMs`/`typingDelayMs` 置 0 免得跑得慢）。
## v1.0.1 — 2026-10-24

- ix(scripts): scripts/git-push.mjs 推送时补上 isomorphic-git 的 Node http 客户端（否则报
  The function requires a "http" parameter）。
- 首次推送时远端由一个 Initial commit 占位，本地三条提交通过重排父指针接到它后面（保留远端历史，
  且为 fast-forward），1.0.0 标签随之重指。
## v1.0.0 — 2026-10-24（首个公开快照）

把四个阶段的工作收进仓库，作为后续 S0–S5 的基线。

### 桌面端 / 本机阶段
- `persona.mjs` + `personas.json`：4+1 个人格（小蓝 / 阿喵 / 凛 / 知夏 / 你鱼姐），
  通过改写 dsh-pet 的 `whisperPrompt` 生效，改完回读校验。
- `qq-bridge.mjs`：OneBot v11 正向 WS 客户端（零第三方依赖），含消息拍平、
  message_id 去重、按会话串行队列、群白名单 / 用户黑名单、指令集。
- `test-bridge.mjs`：假 transport + 合成事件的自测，9 项全过。

### 云端全量阶段
- `cloud/`：独立「大脑」实现——`lib/pet-api.mjs` 与桌面端同名同签名，
  `lib/{prompt,memes,store,llm}.mjs` 复刻 dsh-pet 的 system prompt 拼装与表情包协议。
- `cloud/backup-server.mjs` + `backup-pull.mjs` + `pull-memory.ps1`：
  记忆与快照的拉取通道（本机可关机，云端独立跑）。
- `cloud/deploy.md` + `cloud/remote-*.sh`：腾讯云 2C2G 上的部署脚本（NapCat Docker + systemd）。

### 人格与素材
- `personas.json` 第 5 个人格「你鱼姐」，并支持 **群聊 / 私聊分档人格**
  （`pet.json` 的 `surfaces:{private,group}`，`/人格 N` 只改当前场景）。
- 表情包：从 `shirachino/astrbot-deepseek-meme-pack` 导入 27 个分类、54 个名字，
  随机取图、240px 缩图（21.3MB → 10.3MB）、`memeChance` 概率带图、
  **表情包单独成条**发送 + 带图失败自动降级纯文字。
- `persona-dafeiyu/`：DSH 人格卡（`大肥鱼·DSH.md`、`你鱼姐·DSH.md`）+ AstrBot 提示词分析。

### 主动性 P1a
- `cloud/lib/agency.mjs`：心情三维（valence/arousal/clingy）、冲动累积（上限 120）、
  静默时段、暂停、冷落计数。
- `cloud/lib/commitments.mjs`：承诺抽取（CUE 粗筛 + LLM 精抽）、到期前 20 分钟兑现、missed 记账。
- `cloud/lib/proactive.mjs`：主动开口与兑现承诺的提示词（含 `{"think","say"}` 结构化输出与 SKIP）。
- `cloud/lib/scheduler.mjs`：5 分钟 tick 的状态机（阈值 70 / 消耗 45 / 日上限 5 / 间隔 50min），
  决策写 `logs/trace.jsonl`；指令 `/心思` `/安静` `/说话` `/承诺`。
- 自测 `cloud/tests/selftest.mjs`：32/32 通过（含主动性 8 项、备份 6 项）。

### 仓库化
- 补齐 `.gitignore`（机密与体积大者一律不入库）、`README.md`、`docs/ROADMAP.md`、`VERSION`、`CHANGELOG.md`。
- `scripts/git-push.mjs`：在没有 git 二进制的机器上用 isomorphic-git 完成 init/commit/tag/push。

### 已知限制
- 群聊 @ 回复只在自测里验证过，真实群未跑（小号没有群）。
- 单实例：同一 QQ 号不能同时被本机桌面端与云端消费。
- DeepSeek 无视觉能力，识图按计划推迟到后续版本。

## 后续
见 `docs/ROADMAP.md` 的 S0–S5。
