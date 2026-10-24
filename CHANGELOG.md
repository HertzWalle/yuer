# CHANGELOG

版本号遵循 `MAJOR.MINOR.PATCH`：加了用户能感知的新能力 → MINOR；只修 bug / 调参数 → PATCH；
架构大改或跑不通旧数据 → MAJOR。当前版本见根目录 `VERSION`，每个版本打一个 `vX.Y.Z` 标签。

## v1.1.0 — 2026-10-24

对话节奏：一条回复可以拆成 1~4 个气泡连发，不再永远「一句一气泡」。

- eat(pet-api): 新增 splitBubbles()——模型用换行/|| 自己分段时直接采纳；只给一整句时按
  splitChance（默认 0.5）在标点处断一次，短句（<26 字）不拆；剥掉前几条结尾的逗号/分号；
  单条 >70 字按句号再切；末尾拼接超过 90 字在标点处截断加「…」。
- eat(pet-api): system 末尾追加 REPLY_STYLE 打字约束（1~3 条、每条约 20 字、先说结论），
  personas.json 五个人格的【输出格式】同步补充。
- eat(bridge): sendReply 逐条发气泡，第一条等 	ypingDelayMs，之后每条
  ubbleDelayMs + 字数×22ms(≤600) + 0~250ms 随机；ehavior.maxBubbles（默认 3）、
  ehavior.bubbleDelayMs（默认 700）可调。
- eat(data): cloud/data/pet.json 增加 maxBubbles / splitChance。
- ix(bridge): /记忆 命令引用了不在作用域内的 conv（ReferenceError: conv is not defined），
  群里/私聊发 /记忆 都会直接回「脑袋卡住了」——现在在 handleCommand 内部自己算 conv。
- 自测 33/33（新增「模型分段时发成多个气泡」用例；测试里把 ubbleDelayMs/	ypingDelayMs 置 0 免得跑得慢）。
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
