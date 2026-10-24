/**
 * 版本号：优先读仓库/dist 根目录的 VERSION 文件，读不到退环境变量，最后兜底 0.0.0。
 * 源码布局 cloud/lib/version.mjs → ../../VERSION；dist 布局 /opt/dsh-pet/lib/version.mjs → ../VERSION。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

function readVersion() {
  for (const rel of ['../VERSION', '../../VERSION']) {
    try {
      const v = readFileSync(join(HERE, rel), 'utf8').trim();
      if (v) return v;
    } catch {
      /* 换下一个位置 */
    }
  }
  return process.env.YUER_VERSION || '0.0.0';
}

export const VERSION = readVersion();
