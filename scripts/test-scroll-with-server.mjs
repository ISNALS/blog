/**
 * 起静态服务器 → 跑滚动入场测试 → 关服务器。
 * 与其它 *-with-server 脚本同一套路：滚动测试必须在真实构建产物上跑
 * （dev 服务器不会隐藏卡片，测不出"滚到才出现"）。
 *
 *   node scripts/test-scroll-with-server.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PORT = 4522;
const BASE = `http://127.0.0.1:${PORT}/blog`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(process.execPath, [join(HERE, 'serve-dist.mjs'), String(PORT)], {
  cwd: ROOT,
  stdio: 'ignore',
});

async function waitUp() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(200);
  }
  return false;
}

try {
  if (!(await waitUp())) {
    console.error(`本地服务器未就绪（${BASE}），先跑 npm run build`);
    process.exitCode = 2;
  } else {
    process.exitCode = await new Promise((resolve) => {
      const child = spawn(process.execPath, [join(HERE, 'test-scroll.mjs'), BASE], {
        cwd: ROOT,
        stdio: 'inherit',
      });
      child.on('close', (c) => resolve(c ?? 1));
    });
  }
} finally {
  server.kill();
  await sleep(200);
}
