/**
 * 收藏面板「草稿 + 保存并发布」的端到端验证。
 *
 * 为什么必须真跑：用户报的问题是交互层面的——
 * 「不能一起改，只能等一个生效了另一个才能改」。
 * 要证明改好了，就得在真实浏览器里做这几件事：
 *   ① 连续改多个字段 → **不能有任何网络写入**（旧版每处 onBlur 都提交一次）
 *   ② 按一次「保存并发布」→ **恰好一次** PUT
 *   ③ 没改动时按钮必须是禁用的
 *
 * 做法：本地跑 dist，同时起一个假 GitHub API，用 CDP 把面板的请求改道过去。
 * 这样测的是**真实构建产物**，而不是源码或 mock 组件。
 *
 *   node scripts/test-shelf-ui.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome } from './lib/find-chrome.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SITE_PORT = 4520;
const API_PORT = 4521;
const CDP_PORT = 9340;
const BASE = `http://127.0.0.1:${SITE_PORT}/blog`;

const CHROME = findChrome(existsSync);
if (!CHROME) {
  console.log('跳过收藏面板 UI 测试：未找到 Chrome/Chromium');
  process.exit(0);
}

/* ── 假 GitHub API（面板所有请求都会被改道到这里）────────────────────────── */
const TOKEN = 'test-token';
let shelfSha = 'sha-1';
let puts = 0;
const putBodies = [];
let committed = { animeTitle: '看过的番', anime: [{ title: '原标题', stars: 3 }], music: [] };
const apiHits = [];

const json = (res, code, body) => {
  // 必须带上 CORS 头：页面在 127.0.0.1:4520，而 API 在 127.0.0.1:4521 —— 端口不同即跨域，
  // 浏览器会先发 OPTIONS 预检。假 API 不处理预检的话请求直接失败，
  // 而面板在令牌校验失败时会**主动删掉本地令牌**，于是表现成"令牌没写进去"（踩过）。
  res.writeHead(code, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, accept, content-type, x-github-api-version',
    'access-control-allow-methods': 'GET, PUT, POST, DELETE, OPTIONS',
  });
  res.end(JSON.stringify(body));
};

const api = createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    apiHits.push(`${req.method} ${p}`);
    // 预检：不校验令牌、不执行业务逻辑，只回 CORS 头
    if (req.method === 'OPTIONS') return json(res, 204, {});
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(res, 401, { message: 'Bad credentials' });
    if (p === '/user') return json(res, 200, { login: 'tester' });
    if (/^\/repos\/[^/]+\/[^/]+$/.test(p)) return json(res, 200, { permissions: { push: true } });

    const CONT = /^\/repos\/[^/]+\/[^/]+\/contents\//;
    if (!CONT.test(p)) return json(res, 404, { message: 'mock 未实现 ' + p });
    const path = p.replace(CONT, '');

    if (req.method === 'GET') {
      if (path.endsWith('shelf.json')) {
        return json(res, 200, { content: Buffer.from(JSON.stringify(committed), 'utf8').toString('base64'), sha: shelfSha });
      }
      return json(res, 404, { message: 'Not Found' });
    }

    if (req.method === 'PUT') {
      const body = JSON.parse(raw);
      puts += 1;
      putBodies.push(Buffer.from(body.content, 'base64').toString('utf8'));
      if (body.sha && body.sha !== shelfSha) return json(res, 409, { message: `${path} does not match ${body.sha}` });
      committed = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'));
      shelfSha = `sha-${puts + 1}`;
      return json(res, 200, { commit: { sha: `c${puts}` } });
    }
    return json(res, 404, { message: 'mock 未实现 ' + req.method });
  });
});

await new Promise((r) => api.listen(API_PORT, '127.0.0.1', r));
const site = spawn(process.execPath, [join(HERE, 'serve-dist.mjs'), String(SITE_PORT)], { cwd: ROOT, stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUp(url) {
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(200);
  }
  return false;
}

const profile = mkdtempSync(join(tmpdir(), 'shelf-ui-'));
const chrome = spawn(
  CHROME,
  ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, 'about:blank'],
  { stdio: 'ignore' },
);

async function targetWs() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
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

try {
  if (!(await waitUp(`${BASE}/admin/`))) throw new Error('站点未就绪');
  const ws = new WebSocket(await targetWs());
  await new Promise((r, j) => {
    ws.addEventListener('open', r, { once: true });
    ws.addEventListener('error', j, { once: true });
  });
  await rpc(ws, 'Page.enable');
  await rpc(ws, 'Runtime.enable');

  // 令牌必须在**组件挂载之前**写好：面板在 mount 时读一次 localStorage，
  // 之后再写它不会重新读（第一版在导航之后才注入，于是永远停在令牌引导页）。
  // 所以先访问同源的任意页面建立 origin，写入令牌，再导航到 /admin。
  await rpc(ws, 'Page.navigate', { url: `${BASE}/` });
  await sleep(1200);
  await ev(ws, `localStorage.setItem('blog:gh-token', ${JSON.stringify(TOKEN)}); true`);

  // 用 Fetch 域拦截，把 api.github.com 换成本地假 API
  await rpc(ws, 'Fetch.enable', { patterns: [{ urlPattern: '*api.github.com*' }] });
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = m.params;
    const rewritten = request.url.replace('https://api.github.com', `http://127.0.0.1:${API_PORT}`);
    void rpc(ws, 'Fetch.continueRequest', { requestId, url: rewritten }).catch(() => undefined);
  });

  await rpc(ws, 'Page.navigate', { url: `${BASE}/admin/` });
  await sleep(2500);

  // 诊断信息：这两条能区分"令牌没写进去"和"校验请求没成功"
  const tokenSeen = await ev(ws, `localStorage.getItem('blog:gh-token')`);
  console.log(`  [诊断] 面板读到的令牌: ${tokenSeen ? '有' : '无'}`);
  console.log(`  [诊断] 假 API 收到的请求: ${apiHits.length} 条 ${apiHits.slice(0, 4).join(' / ')}`);

  console.log('\n[0] 令牌门已通过');
  ok('localStorage 里确实有令牌', !!tokenSeen, String(tokenSeen));
  ok('没有停在令牌引导页', !(await ev(ws, `!!document.querySelector('.gate')`)));
  ok('主面板已渲染', await ev(ws, `!!document.querySelector('.admin')`));

  // 切到「收藏」标签
  await ev(ws, `[...document.querySelectorAll('.tabs button')].find(b => b.textContent.trim() === '收藏')?.click()`);
  await sleep(1500);

  console.log('\n[1] 面板加载');
  ok('收藏面板出现', await ev(ws, `!!document.querySelector('.shelfpanel')`));
  ok('保存条存在', await ev(ws, `!!document.querySelector('.shelfbar')`));
  ok('初始状态显示"已与仓库一致"', /一致/.test(await ev(ws, `document.querySelector('.shelfbar-state').textContent`)));
  ok('初始时保存按钮禁用', await ev(ws, `document.querySelector('.shelfbar .primary').disabled === true`));

  console.log('\n[2] 关键回归：连续改多个字段，不能有任何网络写入');
  const putsBefore = puts;
  // 依次改：分组标题、条目标题、年份、短评、星星 —— 旧版每次 onBlur 都会提交
  await ev(ws, `
    (() => {
      const setVal = (el, v) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const title = document.querySelector('.shelfpanel-head .titleinput');
      setVal(title, '我看过的番');
      title.dispatchEvent(new FocusEvent('blur', { bubbles: true }));

      const inputs = document.querySelectorAll('.shelfrow-fields input');
      setVal(inputs[0], '改名后的番');
      inputs[0].dispatchEvent(new FocusEvent('blur', { bubbles: true }));
      setVal(inputs[1], '2019');
      inputs[1].dispatchEvent(new FocusEvent('blur', { bubbles: true }));
      setVal(inputs[3], '新写的短评');
      inputs[3].dispatchEvent(new FocusEvent('blur', { bubbles: true }));

      const sel = document.querySelector('.shelfrow-side select');
      sel.value = '5';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()
  `);
  await sleep(1200);
  ok('改 5 个字段后仍无任何写入（旧版会写 5 次）', puts === putsBefore, `PUT ${puts - putsBefore} 次`);
  ok('保存条变为"有未保存的改动"', /未保存/.test(await ev(ws, `document.querySelector('.shelfbar-state').textContent`)));
  ok('保存按钮已启用', await ev(ws, `document.querySelector('.shelfbar .primary').disabled === false`));
  ok('保存条进入 dirty 状态（描边高亮）', (await ev(ws, `document.querySelector('.shelfbar').dataset.dirty`)) === 'true');

  console.log('\n[3] 按一次「保存并发布」→ 恰好一次写入');
  await ev(ws, `document.querySelector('.shelfbar .primary').click()`);
  for (let i = 0; i < 30; i += 1) {
    if (puts > putsBefore) break;
    await sleep(300);
  }
  await sleep(800);
  ok('恰好写入一次', puts - putsBefore === 1, `PUT ${puts - putsBefore} 次`);
  ok('提交的内容包含全部 5 处改动', (() => {
    const t = putBodies[putBodies.length - 1] ?? '';
    return t.includes('我看过的番') && t.includes('改名后的番') && t.includes('2019') && t.includes('新写的短评') && t.includes('"stars": 5');
  })(), putBodies[putBodies.length - 1]?.slice(0, 200));
  ok('保存后回到"已与仓库一致"', /一致/.test(await ev(ws, `document.querySelector('.shelfbar-state').textContent`)));
  ok('保存后按钮重新禁用', await ev(ws, `document.querySelector('.shelfbar .primary').disabled === true`));

  console.log('\n[4] 丢弃改动');
  await ev(ws, `
    (() => {
      const el = document.querySelector('.shelfpanel-head .titleinput');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, '这段不要了');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  await sleep(400);
  ok('改后有未保存状态', /未保存/.test(await ev(ws, `document.querySelector('.shelfbar-state').textContent`)));
  await ev(ws, `[...document.querySelectorAll('.shelfbar button')].find(b => b.textContent.includes('丢弃')).click()`);
  await sleep(500);
  ok('丢弃后回到一致状态', /一致/.test(await ev(ws, `document.querySelector('.shelfbar-state').textContent`)));
  ok('丢弃后字段值被还原', (await ev(ws, `document.querySelector('.shelfpanel-head .titleinput').value`)) === '我看过的番');
  ok('丢弃没有产生写入', puts - putsBefore === 1, `PUT ${puts - putsBefore} 次`);

  ws.close();
} finally {
  chrome.kill();
  site.kill();
  api.close();
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
console.log('收藏面板：改多处只提交一次，符合预期');
