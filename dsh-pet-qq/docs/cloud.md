# 云端部署：把小号机器人搬走，本机 QQ 留给你自己

## 为什么要搬

本机实测（QQ 9.9.36）：同一个 Windows 用户里 **QQ 只能开一个实例**。换安装目录、加 `--user-data-dir` 都试过，第二个进程直接退出（握手里就没了，连窗口都不留）。所以只要 NapCat 占着 `D:\QQ`，你这台电脑就没法再登主号。

把「小号 + NapCat + 桥」搬到云服务器后，本机 QQ 就完全空出来，主号想什么时候登就什么时候登。

## 架构

```
  你的手机 / 电脑上的主号
          │  发消息
          ▼
  云服务器（Ubuntu）
    ├─ NapCat（Docker，挂小号 2536561711，onebot WS 127.0.0.1:3001）
    └─ qq-bridge.mjs（Node，连 3001，把消息转给「大脑」）
          │  走 Tailscale 内网 / 隧道
          ▼
  你家这台电脑
    ├─ pet-gateway.mjs（监听 0.0.0.0:2628，校验 token，只放行 /dsh-pet-7340/*）
    └─ DSH web 127.0.0.1:2627 → dsh-pet（人设、记忆、表情包、桌面气泡都在这）
```

大脑留在本机的好处：人设、`memory.json`、表情包、桌面气泡全都不用改，QQ 和桌面还是同一个人格、同一份记忆。

代价：**家里电脑得开着、DSH 得在跑**。关机时 QQ 那边只会没反应（桥可以回一句提示）。

## 服务器选型

| 项 | 建议 | 说明 |
| --- | --- | --- |
| 配置 | **2C2G**（最低 1C1G 也能跑） | NapCat 常驻约 250–400MB，Node 桥 60–100MB；1G 内存跑 Docker 会紧 |
| 系统 | **Ubuntu 22.04 LTS x64** | NapCat 的 Linux 版 / Docker 镜像在 Debian 系上最稳 |
| 硬盘 | 40GB 系统盘 | 镜像 2GB + 日志，够 |
| 带宽 | **3Mbps 起**（1Mbps 也能聊文字） | 带表情包（几十~几百 KB/张）建议 3M 以上 |
| 地域 | 国内就近（上海/广州/北京） | 延迟低；只走 IP 不需要备案 |
| 参考价 | 腾讯云/阿里云「轻量应用服务器」2C2G 约 40–60 元/月 | 新用户活动常见 100–200 元/年，学生机更便宜 |

不需要 GPU，不需要 Windows（Windows 云服务器反而贵且要装图形界面）。

## 连通方式（三选一）

| 方式 | 是否需要公网 IP | 复杂度 | 备注 |
| --- | --- | --- | --- |
| **Tailscale**（推荐） | 不需要 | 低 | 两端装客户端，云端直接 `http://<本机tailscale-ip>:2628` 访问；不暴露公网，只你自己的设备能连 |
| Cloudflare Tunnel | 不需要 | 低 | 本机跑 `cloudflared tunnel --url http://127.0.0.1:2628`，临时域名每次重启变；正式建议绑域名 |
| frp | 需要（云服务器就是服务端） | 中 | 云端跑 frps 开 7000，本机跑 frpc；稳定但要维护配置 |

`pet-gateway.mjs` 监听的是 `0.0.0.0`，所以 Tailscale 方案不用改任何端口映射，装上客户端就能直连。

## 安全

**不要把 2627 直接打洞出去**：DSH web 面板能执行命令，等于把整台电脑交出去。
所以多了 `pet-gateway.mjs` 这一层：

- 只放行 `/dsh-pet-7340/*`（`/config`、`/chat`、`/state`、`/pic/*` 这些都在里面）；
- 其它路径一律 404；
- 必须带 `x-pet-token` 头（或 `?token=`），否则 401；
- `/health` 不需要 token，方便探活。

token 用 `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"` 现生成一串。

## 部署步骤（服务器买好后照抄）

### 1. 云服务器（Ubuntu 22.04）

```bash
# Docker
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker

# Node 20（桥要跑 node）
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
node -v
```

> 国内拉 Docker Hub 慢的话，先配 `/etc/docker/daemon.json` 的 registry-mirrors（阿里云/腾讯云都有自己的加速地址）。

### 2. NapCat（Docker，挂小号）

```bash
docker run -d --name napcat --restart always \
  -e NAPCAT_UID=$(id -u) -e NAPCAT_GID=$(id -g) \
  -p 3001:3001 -p 6099:6099 \
  -v /opt/napcat/config:/app/napcat/config \
  -v /opt/napcat/plugins:/app/napcat/plugins \
  mlikiowa/napcat-docker:latest
docker logs -f napcat        # 看二维码
```

- 扫码登小号；登录后到 `/opt/napcat/config/onebot11_<uin>.json` 打开正向 WS：

```json
"websocketServers": [
  { "name": "dsh-pet-bridge", "enable": true, "host": "127.0.0.1", "port": 3001,
    "enableForcePushEvent": true, "reportSelfMessage": false,
    "messagePostFormat": "array", "token": "", "heartInterval": 30000 }
]
```

- 改完 `docker restart napcat`（配置不热重载）。
- 注意：云 IP 首次登录可能触发风控（要短信/扫码验证），**登录成功后别频繁换机器**。

### 3. 云端跑桥

把本机 `dsh-pet-qq/` 里的这几个文件传上去（`qq-bridge.mjs`、`persona.mjs`、`personas.json`、`lib/`、`bridge.config.json`）：

```bash
cd /opt/dsh-pet-qq
export DSH_PET_BASE="http://<本机 Tailscale IP>:2628"
export DSH_PET_TOKEN="<网关 token>"
node qq-bridge.mjs
```

- `bridge.config.json` 的 `onebot.ws` 保持 `ws://127.0.0.1:3001`。
- 用 systemd 或 `pm2 start qq-bridge.mjs --name dsh-pet-qq` 做常驻。
- `/人格`、`/记忆`、`/状态` 这些指令照旧可用（都是通过网关调本机 dsh-pet）。

### 4. 本机

```powershell
cd E:\DeepSeekWorkSpace\dsh-pet-qq
$env:PET_GATEWAY_TOKEN = "<同一串 token>"
node pet-gateway.mjs            # 监听 0.0.0.0:2628
```

再 `tailscale up`（或起 cloudflared），云端就能连了。

自检：云端 `curl http://<本机 IP>:2628/health` 应返回 `{"ok":true}`；
`curl -H "x-pet-token: <token>" http://<本机 IP>:2628/dsh-pet-7340/state` 应返回状态 JSON。

## 本机现状如何切换

配好云端后，本机这套 `start-bot.cmd` 就不用了（QQ 归主号）。想临时切回本机跑小号：

1. `taskkill /f /im QQ.exe`（管理员）关掉主号 QQ；
2. 双击 `start-bot.cmd`；
3. 用完反向：关掉 NapCat 的 QQ，再正常启动 QQ 登主号。

## 已验证的部分

- `pet-gateway.mjs`：token 校验、路径白名单、`/chat` 转发、`/pic/memes` 图片转发 —— 本机实测通过（401/404/200 + 表情包 145KB 取回）。
- `lib/pet-api.mjs`：支持 `DSH_PET_BASE`（自动补 `/dsh-pet-7340`）与 `DSH_PET_TOKEN`，走网关聊天/取图实测通过。

## 还没验证的部分

- 云端 NapCat 的 `mlikiowa/napcat-docker` 实际启动（等你买了机器再跑）。
- 异地 IP 登录小号的风控情况（可能要验证一次）。
