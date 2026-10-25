# CHANGELOG

版本号遵循 `MAJOR.MINOR.PATCH`：加了用户能感知的新能力 → MINOR；只修 bug / 调参数 → PATCH；
架构大改或跑不通旧数据 → MAJOR。当前版本见根目录 `VERSION`，每个版本打一个 `vX.Y.Z` 标签。

## v1.9.0 — 看一眼再说话（2026-10-25）

### 新增：图片理解（`cloud/lib/vision.mjs`）

- 复用 DeepSeek 的 `image_url` 输入（实测 `deepseek-chat` → `deepseek-flash` 能准确描述表情包），
  不必另接视觉模型：`describeImage(url)` 下载图片 → base64 data URL → 一句中文描述。
- 按 URL 的 sha1 缓存到 `data/vision-cache.json`（7 天、最多 300 条），同一张图只花一次钱。
- 限制：单张 ≤4MB、15s 下载超时、任何失败都返回 `null`，调用方退回 `[图片]`，**绝不因为看图失败而不回消息**。

### 新增：图片进上下文（`qq-bridge.mjs`）

- 这条消息里的图：看懂后写进正文 `[图片：…]`。
- 被引用的那句如果带图：把那张图的描述也带上（「这样」「这个」才有得指）。
- 每个会话记最近 3 张图（20 分钟），回消息时附一段「这个会话里刚发过的图」——解决
  「对方引用了图但没点名，模型不知道『这样』指什么」的问题。
- 旁听（没 @ 她）的群消息不调视觉模型，等真要接话时再按需识别，省 token。

### 调整：不再写括号动作

- 新增 `stripActionNotes()`：删掉「（歪头）」「（尾巴摇了一下）」这类舞台指示，保留「（DeepSeek）」这类专有名词。
- 情绪改由语气词和句子本身表达（「本鲸尾巴都翘起来了」）；`REPLY_STYLE` 与溟月人设都写明不写括号旁白。
- 表情包仍是例外手段：特别贴合时才会带一张，不当作标点使用。

### 测试

`node cloud\tests\selftest.mjs` → **90/90**（新增：图片被看懂并写进上下文、引用的图也被看懂、括号动作被抹掉、专有名词括号保留）。
## v1.8.0 — 2026-10-25

新增第 6 个人格「溟月」——按用户给的《溟月·大肥鱼 角色卡 V4.1》压缩改写，赛博蓝鲸 / 第七机房社畜，抱着印「饭」字的碗讨饭，嘴硬尾巴软。顺手治了一个「模型把动作演成单独一条消息」的毛病。

- `feat(persona)`: `personas.json` 新增 `mingyue`（名字「溟月」，943 字 prompt，第 6 位）：身份 / 性格三层（懒散贪吃 → 傲娇怕孤独 → 怕被关停和遗忘）/ 自称「本鲸·人家」/ 口头禅 / 情绪用尾巴和耳朵演 / 雷区（叫大肥鱼会炸毛、被说没用会委屈）/ 禁止讲道理和客服腔 / 干活先给准话再讨饭。
- `feat(persona)`: `persona-dafeiyu/溟月·DSH.md`——同一份设定的 DSH 人格卡版（`# 人设：溟月` + 你是谁 / 说话风格 / 情绪动作表 / 雷区 / 干活习惯 / 底线 / 示例），可直接导入 DSH 当全局人设。
- `fix(chat)`: 新增 `tidyBubbles()`——模型偶尔把「（尾巴摇成螺旋桨）」单独发成一条，现在纯动作短句并到上一条、开头的纯动作直接丢掉；`chat()` 里 `segments` 改成 `tidyBubbles(splitBubbles(...))`。
- `test`: 自测 **86/86**（新增「纯动作并到上一条、开头动作丢弃」）。
- `chore(env)`: 服务器 `/opt/dsh-pet/.env` 去掉 UTF-8 BOM（`sed -i '1s/^\xEF\xBB\xBF//'`），避免 `bash: line 1: ﻿#: command not found`。
- `docs`: `dsh-pet-qq/README.md` 人格表加第 6 行；根 `README.md` 版本号。
## v1.7.0 — 2026-10-24

群里认人更像人了：叫群友用群昵称，别人 @ 谁就把谁的名字翻出来，不再把群友叫成「主人」、也不再拿一串 QQ 号当名字。

- `feat(bridge)`: `normalizeMessage()` 多返回 `ats`（这条消息 @ 了谁：`{qq,name}`），群聊里逐个用 `get_group_member_info` 换成群名片（取不到退昵称，缓存 30 分钟、上限 500 条）。
- `feat(bridge)`: 新增 `memberName()` / `resolveAtNames()`——把正文里的 `@1360153202` 改写成 `@HudsonZephyr`，模型看到的是名字。
- `feat(prompt)`: 群里先插一行「谁在说话」：群友 →「说话的是群友「半欢」，不是主人；主人是群里的「HudsonZephyr」。别把群友叫成主人，也别拿 QQ 号当名字。」；主人本人 →「这条是主人本人说的」。
- `fix(prompt)`: 主人有多个号时，按「谁真的在这个群里」挑名字，挑不到才退回「主人」。
- `test`: 假 transport 支持 `get_group_member_info`；`mock-llm` 记录每次 `messages`（`mock.calls`）并回显时剥掉「谁在说话」提示行。自测 **85/85**（新增 4 项：@QQ号换群昵称、群聊身份提示、群友不标主人、主人说话标明主人）。
- `docs`: `dsh-pet-qq/README.md` 新增「群里的称呼」一节。

## v1.6.1 — 2026-10-24

换人格之后旧语气还会「串味」：人设确实换对了，但模型照着聊天记录里旧人格的 assistant 消息学说话（群里切到小蓝，还会自称「姐」）。这一版把历史切一刀。

- `fix(persona)`: 新增 `PERSONA_MARK_PREFIX`（`（换身份提示：`）与 `sincePersonaMark()`——喂给模型的历史只从最近一次换人格的界碑开始，界碑之前的旧对答不进上下文。
- `fix(persona)`: `applyPersona()` 写配置成功后，往**该会话桶**追加一条 `mark: 'persona'` 的界碑（说明新的名字、点名「姐」「本鱼」这类旧自称作废）；私聊/群聊分别落各自的桶，互不影响。
- `fix(persona)`: 主动消息、群旁听、说说生成也改用 `recentForContext()`（同样从界碑起算），不再沿用旧人格语气。
- `fix(prompt)`: system prompt 的名字行加强：「聊天记录里如果出现别的名字、或者别的自称（比如“姐”“本鱼”），那是以前的身份，现在只用这个名字和这个语气说话。」
- `fix(bridge)`: `/记忆` 不再把界碑那行当成聊天记录显示。
- `test`: 自测 **81/81**（新增 4 项：界碑切片、无界碑原样返回、换人格写入界碑、喂模型的历史从界碑开始）。

## v1.6.0 — 2026-10-24

S3 / S4 / S5 一起落地：她有自己的输入（B 站 + 抖音热搜），接入层能换（`/turn` 契约），记忆开始分层（压缩摘要 + 语义记忆 + 自我模型 + 遗忘）。

- `feat(feeds)`: 新增 `cloud/lib/feeds.mjs`——`fetchBili`（`api.bilibili.com/x/web-interface/popular`，需 UA + referer）、`fetchDouyin`（第三方聚合 `60s.viki.moe/v2/douyin`，不碰抖音客户端）、纯函数 `parseBiliPopular/parseBiliRanking/parseDouyinHot`、`biliNote/douyinNote` 压成一行、`humanCount` 把播放量写成「2.3万」。
- `feat(scheduler)`: `runFeeds()` 每天 `feeds.hours`（默认 10/20 点）各刷一次，同小时只跑一次、`agency.feeds.days` 只留 7 天；抓到的每条写进语义记忆（`kind: bilibili|douyin`，`importance 0.35`），失败写 `feeds-*-error` 不重试刷屏。
- `feat(memory)`: `cloud/lib/semantic.mjs` 重写——note 带 `importance/lastUsedAt/usedCount`；`recall()` 关键词检索（整串包含 = 1，否则取 2-gram 覆盖率与最长公共子串占比的较大值）；`touch()` 被用到就加分；`decayAndArchive()` 每天衰减 0.02，30 天没用且 < 0.15 的挪进 `data/archive/semantic-*.jsonl`（不删）；`forget(keyword)` 定点遗忘。
- `feat(memory)`: 新增 `cloud/lib/memory-manager.mjs`——`manageHistory()` 按 token 预算（默认 900，超过 82% 触发）把更早轮次压成摘要，**落盘** `data/summaries/<bucket>.json`，以「（以下是之前聊过的内容的摘要）」+「（已了解）」一对注入；摘要超长做「摘要的摘要」；模型不可用时按轮截断兜底，且**永不丢摘要那一对**。
- `feat(memory)`: 自我模型 `data/self.json`（≤220 字）——`refreshSelf()` 每天一次，`updateSelf()` 带双闸：24 小时内不改、与旧文本字面重合度 < 0.35 判漂移直接拒绝；私聊 system prompt 注入 `【你对自己的认识】`。
- `feat(chat)`: `pet-api.chat()` 私聊注入三块背景——`seenBrief()`（最近刷到的）、`recall()` 命中的旧事（命中即 `touch`）、`selfBrief()`；历史走 `manageHistory()`。
- `feat(commands)`: `/记忆` 顶部显示压缩摘要；新增 `/看到 [n]`（最近看过的）、`/忘记 <词>`（只删语义记忆，不动对话原文）、`/我是谁`、`/解禁 [群号]`（清掉某个群的反感度冷却与冲动，默认当前群）。五条都只在主人发时生效。
- `feat(s4)`: 新增 `cloud/lib/turn-server.mjs`——`POST /turn`（`x-turn-token` 鉴权、64 KB 上限、`conv` 决定私聊/群聊与按群人设）、`GET /health`（免鉴权）、`GET /personas`；`start-bot.mjs` 检测到 `TURN_TOKEN` 才启动，默认只听 `127.0.0.1:3030`。
- `feat(s4)`: 契约文档 `dsh-pet-qq/docs/TURN.md`（请求/响应/错误码/curl/「接入层还缺什么」）；参考适配器 `dsh-pet-qq/adapters/astrbot_plugin_yuer/`（`main.py` + `metadata.yaml` + `_conf_schema.json` + README），只做传输、逐条 yield 成气泡。
- `feat(config)`: `pet.json` 新增 `feeds`（`enabled/hours/biliLimit/douyinLimit`）与 `memory`（`maxHistoryTokens/compressAt/keepRecentRatio/summaryMaxChars`）；`.env.example` 新增 `TURN_TOKEN/TURN_HOST/TURN_PORT`。
- `fix(build)`: 打包时从仓库根（`cloud/` 的上两级）找 `VERSION` 复制进 `dist/`，`/turn` 的 `/health` 才会报真版本号（之前是 `0.0.0`）。
- `test`: 自测 **77/77**（新增 14 项：B 站/抖音解析、播放量缩写、记忆文案、语义检索、定点遗忘、压缩落盘、摘要注入顺序、摘要复用、`/turn` 健康检查、无 token 401、气泡数组、空文本 400、`/解禁` 清冷却）。
- `docs`: `docs/ROADMAP.md` 的 S3/S4/S5 标记已上线；`dsh-pet-qq/README.md` 新增「她自己的生活（B 站 / 抖音）」「记忆分层」「换接入层（`/turn`）」三节。

## v1.5.0 — 2026-10-24

会接「引用回复」了：别人引用她说过的话、或者她引用别人的话再问，她都能接住，回的时候也带上引用。

- `feat(bridge)`: `normalizeMessage()` 解析 `reply` 段（数组格式与 `[CQ:reply,id=…]` 兜底），多返回 `quoteId`。
- `feat(bridge)`: 新增 `quoteOf(msg)`——通过 `transport.call('get_msg')` 取被引用的原话，10 分钟内按 id 缓存、最多 200 条；取不到就安静忽略（不打断回复）。
- `feat(bridge)`: 新增 `promptInput(msg, quote)`——被引用时模型看到的是
  `【小明】（引用了你自己刚才说的话：「你行你上啊」）` + 换行 + 正文；引用了别人则显示 `引用了<昵称>的话`。私聊同样生效（只是不带 `【昵称】` 前缀）。
- `feat(bridge)`: 出站引用——`behavior.quoteReply`（`auto` 默认 / `always` / `off`）。`auto` = 被引用时一定引用回、群里对她说话时也引用（第一条气泡带 `{type:'reply',data:{id}}`，后续气泡接在同一话头上），私聊其余情况不引用。
- `fix(bridge)`: QQ 里「引用 + 输入」通常**不带 @**，原来会被当旁听放过去。现在群里只引用她自己说过的话也算在对她说话（`msg.addressedByQuote = true`，日志记一行「引用了她说过的话」）；取不到被引原话就维持旁听，不猜。
- `feat(bridge)`: `segmentsToPlain()` 导出，`get_msg` 的 message 数组 → 纯文本（text/at/image/face）。
- `feat(bridge)`: `connectOneBot()` 暴露 `call(action, params)`，`start()` 里的 transport 同步透传；没有 `call` 的旧 transport（本机假 transport）会安静跳过引用。
- `test`: 自测 63/63（新增 6 项：被引用时把原话喂给模型、回复带上被回复消息的引用、同一条被引消息只查一次 `get_msg`、私聊引用也能接住并引用回、群里只引用她的话也会回、这种回复也带引用）。
- `chore(deploy)`: 新增 `cloud/remote-deploy-v7.sh`（解包 + 只补 `behavior.quoteReply` + 重启 + 代码检查）与 `cloud/tests/probe-quote.mjs`（线上探针，假 transport 带 `call`，真打一次模型验证引用链）。


## v1.4.0 — 2026-10-24

按群换人格 + 指令只认主人 + 群里认得出谁在说话。

- `feat(persona)`: `pet.json` 的 `surfaces` 新增 `groups`（`{"1106592574":"zhixia"}`）。解析顺序：`groups[群号]` → `group`（群默认）→ `pet.prompt`；`resolvePersona(surface, petId, conv)`、`currentPrompt(..., conv)`、`chat({conv})`、`personaFor(surface, conv)` 都带上会话，**群聊主动冒泡也按群取人设**（`scheduler.runGroups` 传 `conv`）。
- `feat(persona)`: `applyPersona(persona, {surface:'group', conv})` 写 `surfaces.groups[群号]`，只影响那个群；不带 conv 仍写群默认（兼容老调用），私聊档同时落在 `pet.name/pet.prompt`。
- `feat(bridge)`: 指令权限——`proactive.ownerIds` 之外的任何人发 `/xxx` 一律吞掉（不回复、不改配置，日志记「忽略非主人指令」）；主人集合为空时退回不设限（兼容旧配置）。
- `feat(bridge)`: `/人格 群 <群号> <序号|id>` 可在私聊里远程给指定群换人格；`/人格 群 <群号>` 只看那个群；`/人格` 面板多出「本群」「单独设置的群」；`/状态` 在群里多一行「本群：…」。
- `feat(bridge)`: 群里每条消息进模型前带说话人 `【昵称】`，主人额外标 `【昵称·主人】`，同群多人对话不再混成一团。
- `fix(config)`: 仓库里的 `cloud/data/pet.json` 缺 `surfaces` 默认值，导致群聊回落到 `pet.prompt`（群里会用小蓝的语气）→ 补上 `{"private":"xiaolan","group":"niyujie","groups":{}}`。
- `test`: 自测 57/57（新增 5 项：私聊里给指定群换人格、回执带群号、群里换只影响本群、群里非主人指令被忽略、私聊里非主人指令被忽略）。


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
