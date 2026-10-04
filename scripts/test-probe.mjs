/**
 * 网络探针的端到端验证：在真实浏览器里加载首页，确认它真的把数字填上了。
 *
 * 为什么必须这样测：探针依赖两个外部服务（地理定位 + 计数），
 * 而且是"构建成功但运行时静默失效"的高危类型 —— 类型检查和构建都不会报错，
 * 只有真跑一遍才知道有没有填上数字、控制台有没有报错。
 *
 * 需要联网。离线时明确跳过（exit 0），不判失败。
 *
 *   node scripts/test-probe.mjs [baseUrl]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findChrome } from './lib/find-chrome.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:4518/blog';
const PORT = 9336;

const CHROME = findChrome(existsSync);
if (!CHROME) {
  console.log('跳过探针端到端测试：未找到 Chrome/Chromium');
  process.exit(0);
}

// 先探一下外网：探针的两个依赖都在公网，离线环境测了只会误报
try {
  const r = await fetch('https://ipwho.is/', { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
} catch (err) {
  console.log(`跳过探针端到端测试：外网不可达（${err.message}）`);
  process.exit(0);
}

const profile = mkdtempSync(join(tmpdir(), 'probe-test-'));
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
  throw new Error('CDP 未就绪');
}

let id = 0;
const rpc = (ws, method, params = {}) =>
  new Promise((res, rej) => {
    const msgId = ++id;
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== msgId) return;
      ws.removeEventListener('message', onMsg);
      m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result);
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });

const ev = async (ws, expr) => {
  const r = await rpc(ws, 'Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
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

const consoleErrors = [];

/** 等当前文档加载完成并且探针容器出现（导航后必须等，否则读到的是空白文档） */
async function waitReady(ws) {
  for (let i = 0; i < 50; i += 1) {
    const ready = await ev(ws, `document.readyState`);
    const hasProbe = await ev(ws, `!!document.querySelector('[data-probe]')`);
    if (ready === 'complete' && hasProbe) return true;
    await sleep(200);
  }
  throw new Error('页面未就绪（readyState 或探针容器一直不到位）');
}

try {
  const ws = new WebSocket(await targetWs());
  await new Promise((r, j) => {
    ws.addEventListener('open', r, { once: true });
    ws.addEventListener('error', j, { once: true });
  });
  await rpc(ws, 'Page.enable');
  await rpc(ws, 'Runtime.enable');
  await rpc(ws, 'Log.enable');

  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Log.entryAdded' && m.params?.entry?.level === 'error') {
      consoleErrors.push(m.params.entry.text);
    }
  });

  console.log('\n[1] 探针是否存在于首页');
  await rpc(ws, 'Page.navigate', { url: `${BASE}/` });
  // 导航后必须等文档就绪再断言：直接查会读到导航中的空白文档（这个坑踩过一次）
  try {
    await waitReady(ws);
  } catch {
    /* 下面用断言报告 */
  }
  ok('首页渲染出探针容器', await ev(ws, `!!document.querySelector('[data-probe]')`));
  ok('标题显示「网络探针」', (await ev(ws, `document.querySelector('.probe-head')?.textContent.trim()`)) === '网络探针');

  console.log('\n[2] 等脚本填数（含真实网络请求）');
  let total = '—';
  for (let i = 0; i < 60; i += 1) {
    total = await ev(ws, `document.querySelector('[data-probe-total]')?.textContent.trim() ?? ''`);
    if (total && total !== '—') break;
    await sleep(500);
  }
  ok('访问总数已填入数字', /^[\d,]+$/.test(total), `读到「${total}」`);

  // 国家列表是**后到的**：总数一次请求就回来，各国要等一整批读取。
  // 第一版等到总数就断言列表，于是时好时坏（假红色）——必须等列表本身非空。
  let rows = '[]';
  for (let i = 0; i < 60; i += 1) {
    rows = await ev(
      ws,
      `JSON.stringify([...document.querySelectorAll('[data-probe-countries] li')].map(li => ({
         flag: li.querySelector('.probe-flag')?.textContent.trim(),
         name: li.querySelector('.probe-name')?.textContent.trim(),
         n: li.querySelector('.probe-n')?.textContent.trim(),
       })))`,
    );
    if (JSON.parse(rows).length > 0) break;
    await sleep(500);
  }
  const list = JSON.parse(rows);
  ok('国家列表非空', list.length > 0, rows);
  ok('每项都有国旗与国名', list.length > 0 && list.every((r) => r.flag && r.name && r.n), rows);
  ok(
    '国名是中文（Intl.DisplayNames 生效）',
    list.length > 0 && list.every((r) => /[\u4e00-\u9fff]/.test(r.name ?? '')),
    rows,
  );
  ok(
    '计数降序排列',
    list.every((r, i) => i === 0 || Number(list[i - 1].n.replace(/,/g, '')) >= Number(r.n.replace(/,/g, ''))),
    rows,
  );

  console.log('\n[3] 失败降级：接口不可达时不留空框');
  // 怎么模拟"接口坏了"这一步踩了两次坑，记下来：
  //  ① 真的把网络断掉再导航 → 连本地服务器也连不上，页面加载不出来，
  //     测到的是"页面没加载"而不是降级逻辑。
  //  ② 覆盖 window.fetch → **不生效**：打包后的脚本在导入时就捕获了原生 fetch，
  //     替换 window.fetch 改不到它，于是请求照常发出、计数照常增加。
  // 现在用 CDP 在网络层只拦外部域名：本地服务器仍可用（页面正常加载），
  // 而探针的两个外部依赖真的会失败。
  await rpc(ws, 'Network.enable');
  await rpc(ws, 'Network.setBlockedURLs', {
    urls: ['*abacus.jasoncameron.dev*', '*ipwho.is*', '*geojs.io*'],
  });
  await ev(ws, `localStorage.clear()`); // 清掉缓存，强制走失败分支
  await rpc(ws, 'Page.navigate', { url: `${BASE}/` });
  try {
    await waitReady(ws);
  } catch {
    /* 下面用断言报告 */
  }

  let offlineState = '';
  for (let i = 0; i < 30; i += 1) {
    offlineState = await ev(ws, `document.querySelector('[data-probe-state]')?.textContent.trim() ?? ''`);
    if (offlineState.length > 0) break;
    await sleep(300);
  }
  const offlineTotal = await ev(ws, `document.querySelector('[data-probe-total]')?.textContent.trim() ?? ''`);

  ok('外部接口全失败时探针容器仍在（页面没崩）', await ev(ws, `!!document.querySelector('[data-probe]')`));
  ok('给出说明而不是留空白', offlineState.length > 0, `总数「${offlineTotal}」 说明「${offlineState}」`);
  ok('占位符仍是「—」而非空字符串', offlineTotal === '—', `读到「${offlineTotal}」`);

  // 收尾：解除拦截，免得影响后续运行
  await rpc(ws, 'Network.setBlockedURLs', { urls: [] });

  console.log('\n[4] 控制台错误');
  const real = consoleErrors.filter((t) => !/favicon|ERR_INTERNET_DISCONNECTED|Failed to load resource/i.test(t));
  ok('无未预期的控制台错误', real.length === 0, real.slice(0, 3).join(' | '));

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
console.log('网络探针在真实浏览器里工作正常');
