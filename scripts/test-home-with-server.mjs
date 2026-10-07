/**
 * 起静态服务器 → 跑首页功能测试（两遍：自动播放被拦 / 允许）→ 关服务器。
 *
 * 为什么跑两遍：自动播放的两种结局是**两条不同的代码路径**，
 * 只测一种就有一半没覆盖。默认那次模拟真实访客（会被拦），
 * 第二次加 Chrome flag 放开策略，验证"能播时确实播"。
 *
 *   node scripts/test-home-with-server.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PORT = 4519;
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

const runOnce = (env) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [join(HERE, 'test-home.mjs'), BASE], {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, ...env },
    });
    child.on('close', (c) => resolve(c ?? 1));
  });

try {
  if (!(await waitUp())) {
    console.error(`本地服务器未就绪（${BASE}），先跑 npm run build`);
    process.exitCode = 2;
  } else {
    console.log('\n──── 第一遍：模拟真实访客（自动播放会被浏览器拦截）────');
    const a = await runOnce({});
    console.log(`\n[pass1 exit=${a}]`);
    console.log('\n──── 第二遍：放开自动播放策略（验证能播时确实播）────');
    const b = await runOnce({ AUTOPLAY_OK: '1' });
    console.log(`\n[pass2 exit=${b}]`);
    process.exitCode = a === 0 && b === 0 ? 0 : 1;
  }
} finally {
  server.kill();
  await sleep(200);
}
