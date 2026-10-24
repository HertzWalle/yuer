# 云端部署（NapCat + 桥 + 大脑，全量在服务器上跑）

目标：**你本机可以关机**。QQ 小号、NapCat、人格、记忆、LLM 调用全在服务器上；
本机只在开机时把记忆拉回来备份到 `E:\DeepSeekWorkSpace\`。

```
手机/电脑上的大号 QQ
        │ 私聊 / 群聊 @
        ▼
服务器：NapCat（QQ 小号登录）──ws:3001──> start-bot.mjs
                                          ├─ qq-bridge.mjs（传输/指令/去重/白名单）
                                          ├─ lib/pet-api.mjs（云端版：人格 + 记忆 + 表情包）
                                          ├─ lib/llm.mjs ──> api.deepseek.com
                                          └─ backup-server.mjs（:3020，token 鉴权）
                                                    ▲
                        Tailscale / ssh -L ─────────┘
                                    │
本机：backup-pull.mjs → E:\DeepSeekWorkSpace\dsh-pet-qq\backups\
```

---

## 0. 服务器

- 2 核 2G / Ubuntu 22.04 / 40G 硬盘够用（1C1G 也能跑，NapCat 吃内存，2G 更稳）
- 安全组只开：SSH 22、（部署时临时开）6099 WebUI。**3001 与 3020 绝不要开公网**
- 装 Node 22：

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # 需要 v22 或更新
```

**不需要 npm install**：本项目只用 Node 内置模块。

## 1. NapCat（Docker，QQ 小号在这台服务器上登录）

```bash
sudo mkdir -p /opt/napcat/config /opt/napcat/qq
sudo docker run -d --name napcat --restart=always \
  -p 3001:3001 -p 6099:6099 \
  -e NAPCAT_UID=$(id -u) -e NAPCAT_GID=$(id -g) \
  -v /opt/napcat/config:/app/napcat/config \
  -v /opt/napcat/qq:/app/.config/QQ \
  mlikiowa/napcat-docker:latest

sudo docker logs -f napcat      # 出二维码就扫（小号）
```

扫码登录小号后，WebUI 记下 token，浏览器打开 `http://服务器IP:6099/` 也能操作。

然后配 OneBot 正向 WS（容器里监听 0.0.0.0，宿主机桥连 127.0.0.1:3001）：

`/opt/napcat/config/onebot11_<小号QQ号>.json`：

```json
{
  "network": {
    "websocketServers": [
      {
        "name": "dsh-pet-bridge",
        "enable": true,
        "host": "0.0.0.0",
        "port": 3001,
        "enableForcePushEvent": true,
        "reportSelfMessage": false,
        "messagePostFormat": "array",
        "token": "",
        "heartInterval": 30000
      }
    ]
  }
}
```

```bash
sudo docker restart napcat
sudo docker logs --tail 30 napcat     # 应看到 WebSocket服务: 0.0.0.0:3001 已启动
```

> 如果你更习惯反连 WS（NapCat 主动连桥），把 `websocketClients` 里配上桥的地址也行——
> 但本项目按「桥作为客户端连 NapCat」实现，别两种同时开。

## 2. 部署机器人

```bash
# 本机（Windows）打包
node cloud\build.mjs

# 只更新代码时：别覆盖 data/（那里是记忆、人格、心思、承诺）
tar -czf dist.tgz -C dist --exclude data --exclude logs .
scp dist.tgz ubuntu@<服务器IP>:/tmp/dist.tgz
ssh ubuntu@<服务器IP> 'sudo tar -xzf /tmp/dist.tgz -C /opt/dsh-pet && sudo chown -R dshpet:dshpet /opt/dsh-pet/lib /opt/dsh-pet/*.mjs && sudo systemctl restart dsh-pet-bot'
```

服务器上：

```bash
cd /opt/dsh-pet
cp .env.example .env
nano .env      # 至少填 DEEPSEEK_API_KEY；BACKUP_TOKEN 用 openssl rand -hex 24 生成
node start-bot.mjs     # 前台试跑，看到「OneBot WS 已连接」「已启动」就对了
```

按 Ctrl+C 停掉，改成常驻：

```bash
sudo useradd -r -m -d /opt/dsh-pet dshpet || true
sudo chown -R dshpet:dshpet /opt/dsh-pet
sudo cp systemd/dsh-pet-bot.service /etc/systemd/system/
sudo nano /etc/systemd/system/dsh-pet-bot.service   # 确认 User/WorkingDirectory
sudo systemctl daemon-reload && sudo systemctl enable --now dsh-pet-bot
sudo systemctl status dsh-pet-bot --no-pager
journalctl -u dsh-pet-bot -f     # 实时日志
```

开机自启由 systemd 保证，NapCat 由 Docker `--restart=always` 保证。

## 3. 验证

用大号私聊小号：

```
在吗          → 正常回一句
/人格         → 列出 4 个人格，标出「我现在是：」
/人格 2       → 换成阿喵（云端 pet.json 会立刻落盘）
/状态         → 人格、气泡、统计
/记忆 5       → 最近 5 轮
/心思         → 冲动 / 心情 / 今天主动了几次
/安静 6       → 6 小时内不主动找你；/说话 恢复
/承诺         → 她答应过你的事
```

主动性（P1a）上线后会自己开口：每 300s 一次 tick，冲动 >= 70 且过了静默/日上限/间隔闸门才发；承诺到点前 20 分钟单独兑现。每条决策都写进 `/opt/dsh-pet/logs/trace.jsonl`：

```bash
sudo tail -f /opt/dsh-pet/logs/trace.jsonl
```

想临时停掉主动性：把 `/opt/dsh-pet/bridge.config.json` 的 `proactive.enabled` 改成 `false`，再 `sudo systemctl restart dsh-pet-bot`。

失败排查顺序：`journalctl -u dsh-pet-bot -n 50` → `docker logs napcat --tail 50` →
`.env` 里的 key 是否可用（`curl` 一下 `/chat/completions`）→ 3001 是否在监听。

## 4. 记忆备份拉回本机

云端每 6 小时自动打一份快照（保留 72 份 ≈ 18 天），也可以随时 `POST /snapshot`。

**通道**（二选一，推荐 Tailscale）：

```bash
# 服务器 + 本机都装 Tailscale 并登录同账号后，服务器上：
tailscale ip -4          # 例：100.101.102.103
# .env 里把 BACKUP_HOST 改成这个 tailscale IP，重启机器人
sudo systemctl restart dsh-pet-bot
sudo ufw allow in on tailscale0 to any port 3020 proto tcp
```

本机（Windows，开机后手动或放进「启动」文件夹）：

```powershell
node E:\DeepSeekWorkSpace\dsh-pet-qq\backup-pull.mjs `
  --url http://100.101.102.103:3020 --token <BACKUP_TOKEN>
```

不装 Tailscale 就用 SSH 隧道，效果一样：

```powershell
ssh -N -L 3020:127.0.0.1:3020 root@<服务器IP>
# 另开一个窗口
node E:\DeepSeekWorkSpace\dsh-pet-qq\backup-pull.mjs --url http://127.0.0.1:3020 --token <BACKUP_TOKEN>
```

拉下来的文件在 `E:\DeepSeekWorkSpace\dsh-pet-qq\backups\`：

- `memory-latest.json` —— 最新记忆（覆盖式，方便随时看）
- `memory-YYYYmmdd-HHMMSS.json` —— 带时间戳的历史副本（不覆盖）

### 想把记忆搬到桌面端？

两者的 `memory.json` 结构完全一样（`{ "main": { "main": { messages: [...] } } }`）：

```powershell
Copy-Item E:\DeepSeekWorkSpace\dsh-pet-qq\backups\memory-latest.json `
  C:\Users\黄志\.dsh\dsh-pet\memory.json -Force
```

桌面宠物就接上了云端的对话历史（人设也一样：云端 `data/pet.json` 里的 `pet.prompt` 就是桌面端 `whisperPrompt`）。

## 已知限制

- 云端**没有**桌面宠物窗口，也没有「碎碎念」；只有 QQ 对话与表情包。
- 时间背景里不含节日从句（dsh-pet 那份需要农历表，未复刻）；其余逐字一致。
- 记忆按宠物实例共享：所有私聊与群聊共用同一份记忆（群聊正文会带 `【昵称】` 前缀区分说话人）。
- `/人格` 对所有会话全局生效（和桌面端语义一致）。
- NapCat 登录同一小号会互相顶号：云端在跑时，别在别处再登这个小号。
- 备份是**拉取式**：本机不开机就不会拉，但云端自己一直有快照，不会丢。
