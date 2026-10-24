/**
 * 云端入口：读 .env → 起 OneBot 桥（复用 qq-bridge.mjs）→ 顺带起记忆备份服务。
 *
 * 为什么要有这一层而不是直接 `node qq-bridge.mjs`：
 *  - 服务器上不该把配置写死在代码里，`.env` 一处管全部（API key、OneBot 地址、备份 token）；
 *  - OneBot 的 WS 地址/令牌用环境变量覆盖 bridge.config.json，换机器不用改 JSON；
 *  - 备份服务和机器人同一个进程组，systemd 一个单元管两件事，少一半运维面。
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = HERE;

/** 极简 .env 解析：KEY=VALUE、# 注释、可选的引号包裹；已存在的环境变量优先 */
async function loadDotEnv() {
  const file = join(ROOT, '.env');
  if (!existsSync(file)) {
    console.warn('[boot] 没找到 .env，全部依赖进程环境变量（见 .env.example）');
    return;
  }
  const raw = await readFile(file, 'utf8');
  let n = 0;
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const eq = s.indexOf('=');
    if (eq <= 0) continue;
    const key = s.slice(0, eq).trim();
    let val = s.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = val;
      n++;
    }
  }
  console.log(`[boot] 已从 .env 载入 ${n} 项配置`);
}

async function main() {
  await loadDotEnv();

  const { llmConfig } = await import('./lib/llm.mjs');
  const llm = llmConfig();
  if (!llm.key) {
    console.error('[boot] 缺少 DEEPSEEK_API_KEY —— 云端大脑没有 key 就没法说话。填进 .env 再启动。');
    process.exit(1);
  }
  console.log(`[boot] 大脑：${llm.base} 模型=${llm.model}`);

  // 用环境变量覆盖 OneBot 连接参数，生成一份临时配置给桥用
  const baseConf = JSON.parse(await readFile(join(ROOT, 'bridge.config.json'), 'utf8'));
  if (process.env.ONEBOT_WS) baseConf.onebot = { ...(baseConf.onebot || {}), ws: process.env.ONEBOT_WS };
  if (process.env.ONEBOT_TOKEN) baseConf.onebot = { ...(baseConf.onebot || {}), accessToken: process.env.ONEBOT_TOKEN };
  if (process.env.PET_ID) baseConf.pet = { ...(baseConf.pet || {}), id: process.env.PET_ID };
  const tmpConf = join(ROOT, '.runtime-bridge.config.json');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(tmpConf, JSON.stringify(baseConf, null, 2), 'utf8');

  // 备份服务（可选：没配 token 就不起）
  if ((process.env.BACKUP_TOKEN || '').trim()) {
    import('./backup-server.mjs').catch((e) => console.error('[boot] 备份服务启动失败：' + (e?.message ?? e)));
  } else {
    console.warn('[boot] 没配 BACKUP_TOKEN，记忆备份服务不启动（云端记忆仍会落盘，只是不能远程拉取）');
  }

  // S4：把大脑暴露成 `POST /turn`（配了 TURN_TOKEN 才起，默认只听回环）
  if ((process.env.TURN_TOKEN || '').trim()) {
    try {
      const { createTurnServer } = await import('./lib/turn-server.mjs');
      const host = (process.env.TURN_HOST || '127.0.0.1').trim();
      const port = Number(process.env.TURN_PORT || 3030) || 3030;
      const srv = await createTurnServer({
        host,
        port,
        token: process.env.TURN_TOKEN.trim(),
        log: {
          info: (m) => console.log(`[turn] ${m}`),
          error: (m) => console.error(`[turn] ${m}`),
        },
      });
      console.log(`[boot] /turn 契约已启动：http://${srv.host}:${srv.port}/turn（别的接入层可以直接接）`);
    } catch (e) {
      console.error('[boot] /turn 启动失败（机器人仍可正常对话）：' + (e?.message ?? e));
    }
  } else {
    console.log('[boot] 没配 TURN_TOKEN，/turn 契约不启动（只走 OneBot 接入）');
  }

  const { start } = await import('./qq-bridge.mjs');
  const { bridge } = await start(tmpConf);

  // 主动性调度：承诺兑现 + 私聊主动开口（配置在 bridge.config.json 的 proactive 段）
  try {
    const { createScheduler } = await import('./lib/scheduler.mjs');
    const schedLog = {
      info: (m) => console.log(`[agency] ${m}`),
      warn: (m) => console.warn(`[agency] ${m}`),
      error: (m) => console.error(`[agency] ${m}`),
    };
    const scheduler = createScheduler({ conf: baseConf, log: schedLog });
    scheduler.attachSender((conv, payload) => bridge.sendProactive(conv, payload));
    bridge.attachScheduler(scheduler);
    scheduler.start();
  } catch (e) {
    console.error('[boot] 主动性调度启动失败（机器人仍可正常对话）：' + (e?.message ?? e));
  }

  console.log('[boot] 已启动。日志见 logs/bridge.log，主动行为决策见 logs/trace.jsonl');
}

main().catch((e) => {
  console.error('[boot] 启动失败：', e);
  process.exit(1);
});
