/**
 * 导航高亮的端到端验证：用真实浏览器点导航，确认下划线跟着走。
 *
 * 为什么要单独写一个：高亮逻辑有两条路径——**首屏**由服务器渲染，
 * **换页**由 transition:persist 复用的 DOM + 客户端脚本重算。后者是用户报的
 * 那个 bug（点哪儿都停在首页），而它只在"站内点击导航"时才会出现：
 * 直接改地址栏访问是全新加载，走的是首屏路径，测不出问题。
 *
 * 用 CDP 直连（不引入 puppeteer 等依赖），流程：
 *   加载首页 → 等页面就绪 → 点「归档」→ 等 SPA 换页完成 → 读 aria-current
 *
 *   node scripts/test-nav.mjs [baseUrl]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findChrome } from './lib/find-chrome.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:4500/blog';
const PORT = 9333;

/**
 * 找一个**真实存在**的 Chrome/Chromium。
 * 找不到就**明确跳过**（exit 0 并打印原因），不要判失败——
 * 这个测试依赖真实浏览器，而 CI（ubuntu-latest）上通常没有。
 * 一个因为环境缺失就报红的测试，最后只会被人从流水线里删掉。
 * 探测逻辑在 scripts/lib/find-chrome.mjs，有单测（test-find-chrome.mjs）。
 */
const CHROME = findChrome(existsSync);

if (!CHROME) {
  console.log('跳过导航端到端测试：未找到 Chrome/Chromium');
  console.log('（可用 CHROME_PATH 环境变量指定可执行文件；这一步在 CI 上通常跳过）');
  process.exit(0);
}

const profile = mkdtempSync(join(tmpdir(), 'nav-test-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等 CDP 端点起来 */
async function targetWs() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  throw new Error('CDP 端点未就绪');
}

let id = 0;
function rpc(ws, method, params = {}) {
  const msgId = ++id;
  return new Promise((resolve, reject) => {
    const onMsg = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== msgId) return;
      ws.removeEventListener('message', onMsg);
      if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
      else resolve(msg.result);
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
}

const evaluate = async (ws, expression) => {
  const r = await rpc(ws, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
};

/** 读当前高亮项（可读文本） */
const ACTIVE = `(() => {
  const el = document.querySelector('nav[aria-label] a[aria-current="page"]');
  return el ? el.textContent.trim() : null;
})()`;

/**
 * 按**可见文字**点导航项。
 * 不要用 `a[href$="/archive/"]` 这类选择器：Astro 渲染出的 href 不带尾斜杠
 * （实测是 `/blog/archive`），带尾斜杠的选择器命中 0 个、点击静默失败——
 * 我第一版就是这么写的，结果测出一个假象"点击不换页"，白查一轮。
 * 按文字定位同时也更接近真实用户行为。
 */
const clickNav = (label) => `(() => {
  const a = [...document.querySelectorAll('nav[aria-label] a')]
    .find(el => el.textContent.trim() === ${JSON.stringify(label)});
  if (!a) return 'NOT_FOUND:' + ${JSON.stringify(label)};
  a.click();
  return 'clicked';
})()`;

/** 等 SPA 换页真正落地：URL 变了且高亮是期望值 */
const waitFor = async (ws, expr, expect, timeoutMsg) => {
  for (let i = 0; i < 60; i += 1) {
    const v = await evaluate(ws, expr);
    if (v === expect) return v;
    await sleep(200);
  }
  throw new Error(`${timeoutMsg}（最终读到 ${JSON.stringify(await evaluate(ws, expr))}）`);
};

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) {
    pass += 1;
    console.log(`  OK   ${name}`);
  } else {
    fails.push(name);
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
};

try {
  const wsUrl = await targetWs();
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  await rpc(ws, 'Page.enable');
  await rpc(ws, 'Runtime.enable');

  console.log('\n[1] 首屏（服务器渲染）');
  await rpc(ws, 'Page.navigate', { url: `${BASE}/` });
  await waitFor(ws, `document.readyState === 'complete' && !!document.querySelector('nav[aria-label]')`, true, '首页未就绪');
  await sleep(600);
  ok('首页高亮「首页」', (await evaluate(ws, ACTIVE)) === '首页', String(await evaluate(ws, ACTIVE)));

  console.log('\n[2] 站内点击导航（SPA 换页，DOM 被 persist 复用——问题就出在这条路径）');
  ok('点「归档」的指令未报 NOT_FOUND', (await evaluate(ws, clickNav('归档'))) === 'clicked');
  await waitFor(ws, `location.pathname`, '/blog/archive', 'URL 未切到归档');
  await waitFor(ws, ACTIVE, '归档', '换页后高亮没跟到「归档」');
  ok('点「归档」后高亮变成「归档」', true);
  ok('高亮只有一个', (await evaluate(ws, `document.querySelectorAll('nav[aria-label] a[aria-current="page"]').length`)) === 1);

  await evaluate(ws, clickNav('关于'));
  await waitFor(ws, `location.pathname`, '/blog/about', 'URL 未切到关于');
  await waitFor(ws, ACTIVE, '关于', '换页后高亮没跟到「关于」');
  ok('点「关于」后高亮变成「关于」', true);

  await evaluate(ws, clickNav('首页'));
  await waitFor(ws, `location.pathname.replace(/\\/+$/, '')`, '/blog', 'URL 未切回首页');
  await waitFor(ws, ACTIVE, '首页', '换页后高亮没跟回「首页」');
  ok('点「首页」后高亮变回「首页」', true);

  console.log('\n[3] 进了文章页：主导航不该残留任何高亮');
  await rpc(ws, 'Page.navigate', { url: `${BASE}/posts/2026-09-28-motion-four-moves/` });
  await waitFor(ws, `document.readyState === 'complete'`, true, '文章页未就绪');
  await sleep(600);
  ok('文章页无残留高亮', (await evaluate(ws, ACTIVE)) === null, String(await evaluate(ws, ACTIVE)));

  console.log('\n[4] 从文章页点回导航（同一路径的第二次换页）');
  await evaluate(ws, clickNav('归档'));
  await waitFor(ws, ACTIVE, '归档', '从文章页换到归档后高亮不对');
  ok('文章页 → 归档，高亮正确', true);

  ws.close();
} finally {
  chrome.kill();
  await sleep(300);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* 句柄没释放就先留着 */
  }
}

console.log(`\n通过 ${pass} 项，失败 ${fails.length} 项`);
if (fails.length > 0) {
  console.log('失败项：\n  - ' + fails.join('\n  - '));
  process.exit(1);
}
console.log('导航高亮在首屏与 SPA 换页两条路径下都正确');
