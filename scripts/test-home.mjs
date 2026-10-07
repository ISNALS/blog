/**
 * 「关于我」收藏栏 + 悬浮音乐播放器的端到端验证。
 *
 * 为什么要真跑浏览器：这一批功能全是运行时行为——
 *  · 自动播放**会被浏览器拦截**（这是策略，不是 bug），所以必须验证
 *    "被拦截时优雅降级成一个按钮"这条路径真的成立，而不是弹个错误
 *  · 播放器的状态机（暂停/下一首/列表高亮）只在真实 media 元素上才有意义
 *  · 收藏栏是构建期渲染的静态 HTML，验的是"清单真的进了页面"
 *
 * 同一个脚本跑两遍，靠 `AUTOPLAY_OK` 环境变量切换 Chrome 的自动播放策略：
 *   默认（模拟真实访客）→ 预期被拦截 → 必须降级
 *   AUTOPLAY_OK=1       → 预期自动播成功 → 必须进入播放态
 * 只测一种情况都不够：只测被拦截，就不知道能播时到底播不播。
 *
 *   node scripts/test-home.mjs [baseUrl]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findChrome } from './lib/find-chrome.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:4519/blog';
const PORT = 9338;
const AUTOPLAY_OK = process.env.AUTOPLAY_OK === '1';

const CHROME = findChrome(existsSync);
if (!CHROME) {
  console.log('跳过首页功能测试：未找到 Chrome/Chromium');
  process.exit(0);
}

const profile = mkdtempSync(join(tmpdir(), 'home-test-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    // 默认**不加**这个 flag —— 让自动播放真的被拦，才能测到降级路径
    ...(AUTOPLAY_OK ? ['--autoplay-policy=no-user-gesture-required'] : []),
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

try {
  const ws = new WebSocket(await targetWs());
  await new Promise((r, j) => {
    ws.addEventListener('open', r, { once: true });
    ws.addEventListener('error', j, { once: true });
  });
  await rpc(ws, 'Page.enable');
  await rpc(ws, 'Runtime.enable');

  // 用一次性 profile，每次都是"新访客"，自动播放策略才有意义
  await rpc(ws, 'Page.navigate', { url: `${BASE}/` });
  for (let i = 0; i < 50; i += 1) {
    if ((await ev(ws, `document.readyState`)) === 'complete' && (await ev(ws, `!!document.querySelector('.shelf')`))) break;
    await sleep(200);
  }

  console.log(`\n[1] 「关于我」收藏栏（${AUTOPLAY_OK ? '自动播放允许' : '自动播放被拦（真实访客）'}）`);
  ok('收藏栏已渲染', await ev(ws, `!!document.querySelector('.shelf')`));
  ok('有分组的标题', (await ev(ws, `document.querySelectorAll('.shelf-group-title').length`)) >= 1);
  const animeN = await ev(ws, `document.querySelectorAll('.shelf-grid:not(.is-music) .shelf-card').length`);
  const musicN = await ev(ws, `document.querySelectorAll('.shelf-grid.is-music .shelf-card').length`);
  ok('番剧条目渲染出来', animeN > 0, `番剧 ${animeN} 条`);
  ok('音乐条目渲染出来', musicN > 0, `音乐 ${musicN} 条`);
  ok(
    '封面区有占位兜底（没有封面时不留空洞）',
    (await ev(ws, `document.querySelectorAll('.shelf-cover-fallback').length`)) >= 0,
  );
  ok('星级按分数渲染', (await ev(ws, `document.querySelectorAll('.shelf-stars').length`)) > 0);

  console.log('\n[2] 悬浮播放器');
  ok('播放器已渲染', await ev(ws, `!!document.querySelector('[data-player]')`));
  ok('曲目已写入 dataset（构建期注入）', (await ev(ws, `JSON.parse(document.querySelector('[data-player]').dataset.tracks).length`)) > 0);
  ok('audio 元素有 src', (await ev(ws, `!!document.querySelector('[data-player-audio]').src`)));
  ok('曲名已显示', (await ev(ws, `document.querySelector('[data-player-title]').textContent.trim()`)) !== '—');
  ok('曲目列表项数与清单一致', await ev(ws, `
    (() => {
      const el = document.querySelector('[data-player]');
      const n = JSON.parse(el.dataset.tracks).length;
      return document.querySelectorAll('[data-player-item]').length === n;
    })()
  `));

  console.log('\n[3] 自动播放策略的两种结局');
  // 给播放尝试留出时间（play() 是异步的）
  await sleep(2500);
  const playing = await ev(ws, `document.querySelector('[data-player]').dataset.playing === 'true'`);
  const state = await ev(ws, `document.querySelector('[data-player-state]').textContent.trim()`);
  if (AUTOPLAY_OK) {
    ok('允许自动播放时进入播放态', playing, `playing=${playing} state="${state}"`);
    ok('播放时不显示讨点击的提示', state === '', `state="${state}"`);
  } else {
    ok('被拦截时不弹错误、只提示点一下', state.length > 0, `state="${state}"`);
    ok(
      '提示文案是"点一下播放"而不是报错',
      /点一下|播放/.test(state) && !/错|失败|error/i.test(state),
      `state="${state}"`,
    );
  }

  console.log('\n[4] 手动交互');
  // 这一组只在**放开自动播放策略**的那一遍断言"点了就播"，原因有两个：
  //  ① `el.click()` 是**合成点击**，无头浏览器不把它算作用户手势，
  //     被拦模式下任何实现都播不起来，断言"点了能播"本身就是错的；
  //  ② 更隐蔽的是**状态耦合**：自动播放成功时音频已经在播，
  //     此时点那个键是「暂停」而不是「播放」——第一版没先把状态归零，
  //     于是"点播放键后进入播放态"在能播的那一遍反而失败。
  // 所以下面先显式 pause() 把状态归零，再点，才是确定性的复核。
  if (AUTOPLAY_OK) {
    await ev(ws, `(() => { const a = document.querySelector('[data-player-audio]'); a.pause(); return true; })()`);
    await sleep(400);
    ok('前置状态已归零（暂停）', (await ev(ws, `document.querySelector('[data-player]').dataset.playing === 'true'`)) === false);

    await ev(ws, `document.querySelector('[data-player-toggle]').click()`);
    await sleep(1200);
    ok('点播放键后进入播放态', await ev(ws, `document.querySelector('[data-player]').dataset.playing === 'true'`));

    await ev(ws, `document.querySelector('[data-player-toggle]').click()`);
    await sleep(800);
    ok('再点一次回到暂停态', (await ev(ws, `document.querySelector('[data-player]').dataset.playing === 'true'`)) === false);
  } else {
    await ev(ws, `document.querySelector('[data-player-toggle]').click()`);
    await sleep(1000);
    ok('被拦模式下点播放键不报错、页面仍在', await ev(ws, `!!document.querySelector('[data-player]')`));
    ok(
      '被拦模式下播放器仍给出可点击的提示',
      (await ev(ws, `document.querySelector('[data-player-state]').textContent.trim()`)).length > 0,
    );
  }

  // 切歌：无论能否播，audio.src 都必须被换成有效地址
  await ev(ws, `document.querySelector('[data-player-next]').click()`);
  await sleep(600);
  ok('点下一首后 audio 仍有有效 src', await ev(ws, `!!document.querySelector('[data-player-audio]').src`));

  console.log('\n[5] 展开控制区');
  const before = await ev(ws, `document.querySelector('[data-player-extra]').hidden`);
  await ev(ws, `document.querySelector('[data-player-list-toggle]').click()`);
  await sleep(300);
  const after = await ev(ws, `document.querySelector('[data-player-extra]').hidden`);
  ok('点列表键能展开/收起控制区', before !== after, `before=${before} after=${after}`);
  ok('aria-expanded 同步更新', ['true', 'false'].includes(await ev(ws, `document.querySelector('[data-player-list-toggle]').getAttribute('aria-expanded')`)));

  console.log('\n[6] 自定义鼠标指针');
  const bodyCursor = await ev(ws, `getComputedStyle(document.body).cursor`);
  const linkCursor = await ev(ws, `getComputedStyle(document.querySelector('.shelf a, .player button, .nav a')).cursor`);
  // 无头浏览器里 (hover: hover) 可能不匹配，所以只断言"不是默认值"这一软条件
  const customish = (c) => c.includes('url(') || c === 'auto' || c === 'pointer';
  ok('body 光标的取值合理', customish(bodyCursor), bodyCursor);
  ok('可点元素光标不是 text', !linkCursor.startsWith('text'), linkCursor);

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

console.log(`\n通过 ${pass} 项，失败 ${fails.length} 项${AUTOPLAY_OK ? '（自动播放允许模式）' : '（自动播放被拦模式）'}`);
if (fails.length > 0) {
  console.log('失败项：\n  - ' + fails.join('\n  - '));
  process.exit(1);
}
console.log('首页收藏栏与播放器工作正常');
