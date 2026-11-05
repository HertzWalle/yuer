# 前台（管理面板）方案 · 参照调研与选型

> **状态：已实现（v1.17.0，2026-11-05）** —— `cloud/panel-server.mjs` + `cloud/panel/index.html` + `cloud/lib/config.mjs`；本文保留为设计依据。
>
> 目标（用户 m08699）：把「她现在的状态 + 可改的参数」搬到网页上，实时改、不用改代码、不用重启。
> 本文只做**方案与参照**，不含实现代码。

---

## 0. 结论先行

**参照三合一，自己写一个轻面板**（不要为这个迁到 AstrBot / Letta ADE）：

| 借鉴来源 | 借什么 |
| --- | --- |
| **Letta ADE**（官方 ADE） | 「她脑子里现在装着什么」的可视化：上下文预算条、记忆块可编辑、思考/工具调用可展开 |
| **AstrBot WebUI** | 「参数怎么摆」：左侧分区导航 + 右侧表单 + 右下角保存 + `{}` 直接改 JSON；中文语境下的分组方式 |
| **Open WebUI** | 「调参手感」：滑块 + `默认 · 中等` 这类默认值提示 + 会话级覆盖（改完立刻影响下一句） |

技术栈建议：**后端在现有进程里加一个 `panel-server.mjs`（127.0.0.1:3040，token 鉴权）+ 前端一个 Vite + Preact 单页**，复用已有的 `turn-server.mjs` 模式。工作日估算 P0–P3 共 **3–4 天**（见第 6 节）。

---

## 1. 参考图（已下载到 `docs/refs/`）

| 图 | 参照点 |
| --- | --- |
| `letta-ade-context.png` | **上下文窗口预算条**：`2001/8192 TOKENS` + 四色分段（系统提示 / 工具 / 记忆 / 空余）。我们也该有：这一轮 prompt 里 system 多少字、历史多少字、记忆多少字、表情包清单多少字。 |
| `letta-ade-tools.png` | **三段式导航**（AGENTS / MEMORY / TOOLS / SYSTEM）+ 卡片网格 + 右上角「Create new tool」。我们要的是左栏 `状态 / 参数 / 人格 / 记忆 / 对话 / 日志`。 |
| `letta-ade-modes.png` | **Interactive vs Simple 两种视角**：一个给她自己调试（看 reasoning、看工具调用），一个给主人看（只看她说的话）。我们要的「状态页」正是 Interactive 的简化版。 |
| `letta-ade-reasoning.png` | 思考与最终回复**分开呈现**，回复气泡不带内心戏。 |
| `proactive-agent-settings-zh.BRD2stKm.png` | 极简一行「开关 + 说明」卡片——适合放「主动开口」「群里插话」「生图」这类总开关。 |
| `custom-rules-edit-zh.tiut4Nnr.png` | 弹窗式分区表单：服务配置 / 模型配置 / 人格配置，每段独立「保存」+ 蓝色信息提示条。人格与模型的覆盖关系可以照这个摆。 |
| `model-editor-*.png` | 模型条目的编辑表单（能力开关 + 参数）。 |
| `model-controls-slider-*.webp` | **滑块调参**（Thinking: Minimal…High，下面一行 `Default · Medium`）+ 会话级覆盖。这是「实时改、不用改代码」最舒服的交互形态。 |

---

## 2. 候选参照对比

| 项目 | 星 | 许可 | 栈 | 强在哪 | 对我们的短板 |
| --- | --- | --- | --- | --- | --- |
| **Letta ADE** | 25.2k | 官方产品 | — | agent 状态可视化做到极致：记忆块、上下文预算、工具、模拟器 | 闭源、跟我们 Node 桥不通用；我们只在试运行接 Letta |
| **AstrBot WebUI** | 43.1k | AGPL-3.0 | Vue + Vuetify | 中文、分区配置、统计/日志/追踪、插件市场 | Python 单体、许可证限制，只能当 UX 参照 |
| **Open WebUI** | 157.8k | 自定义（含品牌条款） | Svelte | 调参交互最顺：滑块、默认值提示、按模型/按会话覆盖 | 是「聊天前端」，不是「机器人运维面板」 |
| **LibreChat** | 30k+ | MIT | React | 多模型、预设、Agent 管理 | 同上，偏聊天 |
| **Grafana** | 70k+ | AGPL-3.0 | Go + React | 时间序列图表、告警 | 只能读指标，改不了参数 |
| **Langfuse** | 14k+ | MIT | Next.js | trace / prompt 版本 / 评估 | 偏 LLM 观测，不控运行时 |

**为什么不自建直接套 AstrBot 的 WebUI**：它的面板和后端配置结构（`cmd_config.json` + 插件系统）强耦合，搬过来等于迁框架；而我们需要改的是 `pet.json` / `bridge.config.json` / `.env` 三类文件，量很小。

---

## 3. 面板信息架构（5 页）

```
┌────────────────────────────────────────────────────────────────────┐
│ 鱼儿控制台                                    ● 在线  v1.16.2  ⚙  │
├──────────┬─────────────────────────────────────────────────────────┤
│ 状态      │  此刻                                                     │
│ 参数      │  ┌──────────────┬──────────────┬──────────────┐          │
│ 人格      │  │ 冲动 62/58   │ 心情 黏人     │ 今日开口 3/8 │          │
│ 记忆      │  │ ──────────── │ ──────────── │ ──────────── │          │
│ 对话      │  │ 上次开口 21:04│ 承诺 1 条待办 │ 群冷清/无插话 │          │
│ 日志      │  └──────────────┴──────────────┴──────────────┘          │
│          │  上下文预算  ████████████░░░░░░  6.2k / 64k               │
│          │   ┌ system 1.1k ┬ 历史 3.4k ┬ 记忆 0.9k ┬ 清单 0.8k ┐      │
│          │  最近一轮：听到「今天好累」→ 说了 2 条 → 带图「死掉了」    │
├──────────┴─────────────────────────────────────────────────────────┤
│  实时日志  ▸ [21:04] tick 冲动 +6 → 62 / 阈值 58                        │
│           ▸ [21:04] 闸门：静默期(23:30-07:30) 未到 → 允许               │
│           ▸ [21:04] generateProactive → 2 条 → 已发送                   │
└────────────────────────────────────────────────────────────────────┘
```

| 页 | 放什么 | 数据来源 |
| --- | --- | --- |
| **状态** | 冲动/阈值/心情/今日次数/上次开口/静默期/承诺列表/群档位与反感度/上下文预算条/最近一轮 trace | `data/state.json`、`data/commitments.json`、`data/groups.json`、`logs/trace.jsonl` |
| **参数** | 三组表单：**主动行为**（阈值、每小时、日上限、间隔、静默时段）、**群聊**（四档配额、占群比、反感度阈值）、**表达**（气泡数、拆句概率、表情包概率、语音开关、生图开关与配额） | `pet.json` 的 `maxBubbles`/`splitChance`/`memeChance*`/`drawEnabled`、`bridge.config.json` 的 `proactive`/`behavior` |
| **人格** | 6 个人格的卡片 + 当前分配（`surfaces.private` / `group` / `groups[群号]`），点一下切换、可编辑 prompt 正文 | `personas.json`、`pet.json.surfaces` |
| **记忆** | 四个桶的原文（私聊 `main.main`、群 `main@group:*`）+ L2 摘要 + 语义条目 + 自我模型（可编辑，≤220 字） | `data/memory.json`、`data/summaries/*`、`data/semantic.json`、`data/self.json` |
| **对话** | 最近 N 轮，可筛群/私聊、可搜索、可「忘掉某条」 | `memory.json` |
| **日志** | `bridge.log` 尾部 + `trace.jsonl` 结构化决策（为什么开口/没开口）+ `usage.jsonl` 用量 | `logs/*` |

---

## 4. 参数清单（现状 → 面板）

### 4.1 现在散落在哪里

| 文件 | 键 | 改动频率 |
| --- | --- | --- |
| `cloud/data/pet.json` | `maxBubbles`、`splitChance`、`maxBubblesGroup`、`splitChanceGroup`、`memeChancePrivate`、`memeChanceGroup`、`memeCooldown`、`drawEnabled`、`drawInGroup`、`surfaces`、`feeds`、`qzone` | 高 |
| `bridge.config.json` | `proactive{enabled,ratePerHour,impulseThreshold,impulseCost,dailyLimit,minGapMin,recentGuardMin,quiet*,viaLetta}`、`behavior{coalesceMs,quoteReply,voice,memeChance,imageDelayMs,maxBubbles,bubbleDelayMs,tailPauseMs,draw{...},letta{...}}`、群四档 `dailyLimit/hourLimit/minGapSec/urgencyMin/shareCap/openerPerHour` | 高 |
| `cloud/data/personas.json` | 6 个人格的 `prompt` | 中 |
| `/opt/dsh-pet/.env` | `DEEPSEEK_*`、`MODELSCOPE_*`、`TURN_TOKEN`、`BACKUP_TOKEN` | 低（含密钥，**面板只看不改**） |

### 4.2 面板要能改的（P1 范围，12 项）

- 主动：`ratePerHour`、`impulseThreshold`、`impulseCost`、`dailyLimit`、`minGapMin`、静默起止
- 群聊：`shareCap`、四档 `dailyLimit` 与 `minGapSec`
- 表达：`maxBubbles`/`maxBubblesGroup`、`memeChancePrivate`/`Group`、`voice.enabled`、`draw.enabled`/`limitPrivate`/`limitGroup`
- 开关：`proactive.enabled`、`proactive.group.enabled`、`observeGroups`、`viaLetta`

> 交互照 Open WebUI：每项带 **默认值提示**（`默认 · 9 次/小时`）和 **回滚到默认**；改动先落「草稿」，点保存才写盘并**热生效**（进程内重读 config，不重启）。

---

## 5. 技术方案

### 5.1 后端：`cloud/panel-server.mjs`

与 `turn-server.mjs`（3030）、`backup-server.mjs`（3020）同款：`node:http` + token 头鉴权 + 只绑 `127.0.0.1`。

```
GET  /api/state          → 冲动/心情/承诺/群档位/上下文预算/最近 trace
GET  /api/config         → pet.json + bridge.config.json（脱敏：不返密钥）
POST /api/config         → 校验（每项有 min/max/type）→ 写临时文件 + rename → 热重载
GET  /api/personas       → 列表 + surfaces
POST /api/personas/use   → {surface, conv?, id}
PUT  /api/personas/:id   → 改 prompt（带「写入后回读校验」，和现在 applyPersona 一样）
GET  /api/memory?bucket= → 原文 / 摘要 / 语义 / 自我模型
GET  /api/events         → SSE：tail trace.jsonl + bridge.log（每 1s 推增量）
```

热重载的关键：现在 `qq-bridge.mjs` 的 `conf` 是启动时读一次的常量；需要改成 `loadConfig()` 可重入 + `createScheduler` 读最新值。这是**唯一有侵入性的改动**（约 40 行）。

### 5.2 前端

- **Vite + Preact + 原生 CSS**（约 800 行），不引 UI 框架，避免 npm 供应链风险；配色沿用她现在的蓝白。
- 三个交互组件就够：`Card`（指标卡）、`Slider`（带默认值提示）、`SectionForm`（分区 + 保存）。
- 上下文预算条直接照 `letta-ade-context.png` 的四色分段做（纯 CSS `linear-gradient` + 百分比）。

### 5.3 访问方式（安全）

- 面板只绑 `127.0.0.1:3040`；外部访问走 **SSH 隧道** `ssh -L 13040:127.0.0.1:3040`（和现在备份服务一样的路子）。
- 若要手机看：Tailscale 内网 + 只允许 tailnet。
- **绝不开公网**：面板能改 prompt 和主动频率，等于能改她的行为。

---

## 6. 分期（估时）

| 阶段 | 内容 | 估时 |
| --- | --- | --- |
| **P0** | 只读状态页：冲动/心情/承诺/群档位/上下文预算/trace 流 | 0.5 天 |
| **P1** | 12 项参数可改 + 热生效 + 默认值提示 | 1 天 |
| **P2** | 人格页（列表/切换/编辑 prompt）+ 记忆页（四桶 + 自我模型） | 1 天 |
| **P3** | 对话检索 + 日志/用量 + 移动端适配 | 0.5–1 天 |

---

## 7. 明确不做

- 不做多用户 / 权限体系（只有主人一个人用）。
- 不做在线编辑器改 `.env` 密钥（看可以，改不了）。
- 不做「在面板里聊天」——聊天就是 QQ，面板只负责看和调。
- 不引入 AstrBot 的插件市场那套（我们不是插件宿主）。

---

## 8. 待拍板

1. **形态**：独立小面板（推荐，2–3 天见效果）还是「迁到 AstrBot 用它的 WebUI」（等于重写后端）。
2. **范围**：先做 P0+P1（状态 + 参数），还是连人格/记忆一起（P2）？
3. **访问**：只 SSH 隧道够不够，还是要在手机上随时看（那就上 Tailscale）。
