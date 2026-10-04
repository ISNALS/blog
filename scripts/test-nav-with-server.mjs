/**
 * 起一个静态服务器 → 跑导航端到端测试 → 关服务器。
 *
 * 为什么要编排而不是直接用现成的服务器：导航测试必须在**真实构建产物**上跑
 * （dev 服务器会补 base、行为不同），而 CI 里没有人在旁边手动起服务。
 * 所以这里把它做成自包含的：先 npm run build 的产物已经在了（verify 的顺序保证），
 * 起 dist 服务器、跑测试、无论成败都关掉。
 *
 *   node scripts/test-nav-with-server.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PORT = 4517;
const BASE = `http://127.0.0.1:${PORT}/blog`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(process.execPath, [join(HERE, 'serve-dist.mjs'), String(PORT)], {
  cwd: ROOT,
  stdio: 'ignore',
});

/** 等服务器真正能响应，而不是盲等固定时长 */
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

let code = 1;
try {
  if (!(await waitUp())) {
    console.error(`本地服务器未就绪（${BASE}），先跑 npm run build`);
    process.exitCode = 2;
  } else {
    code = await new Promise((resolve) => {
      const child = spawn(process.execPath, [join(HERE, 'test-nav.mjs'), BASE], {
        cwd: ROOT,
        stdio: 'inherit',
      });
      child.on('close', (c) => resolve(c ?? 1));
    });
    process.exitCode = code;
  }
} finally {
  server.kill();
  await sleep(200);
}
