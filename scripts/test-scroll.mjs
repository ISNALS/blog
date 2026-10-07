/**
 * 滚动入场的端到端验证：确认"滚到哪里，哪里才出现动效"。
 *
 * 要验的不是"有没有动效"，而是**时序**：
 *   · 视口外的元素必须是未激活的（否则等于整页在首屏一起动完，用户就是这么反馈的）
 *   · 滚到之后必须变成激活态
 *   · 划线（data-rule）必须真的从 scaleX(0) 变到 scaleX(1)
 *   · 同时留在视口外的那些，必须还是未激活的
 *
 *   node scripts/test-scroll.mjs [baseUrl]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findChrome } from './lib/find-chrome.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:4522/blog';
const PORT = 9344;

const CHROME = findChrome(existsSync);
if (!CHROME) {
  console.log('跳过滚动动效测试：未找到 Chrome/Chromium');
  process.exit(0);
}

const profile = mkdtempSync(join(tmpdir(), 'scroll-test-'));
const chrome = spawn(
  CHROME,
  ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'],
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

/**
 * 每个可动画元素的状态：是否已激活 + 它相对视口的位置。
 *
 * 注意 [data-group] 的 is-in 是加在**子元素**上的（容器只是错峰的锚点，
 * 详见 motion.ts 第 7 节）。第一版直接检查容器，于是永远读到"未激活"，
 * 把一条正常的实现误报成失败——所以这里同时给出子元素的激活情况。
 */
const SNAPSHOT = `(() => {
  const rect = (el) => { const r = el.getBoundingClientRect(); return { inView: r.top < window.innerHeight && r.bottom > 0, top: Math.round(r.top) }; };
  const rules = [...document.querySelectorAll('[data-rule]')].map((el, i) => {
    const cs = getComputedStyle(el, '::after');
    return { kind: 'rule', i, ...rect(el), activated: el.classList.contains('is-in'),
             ruleScaleX: cs.transform, ruleTransition: cs.transitionDuration };
  });
  const reveals = [...document.querySelectorAll('[data-reveal]')].map((el, i) => ({ kind: 'reveal', i, ...rect(el), activated: el.classList.contains('is-in') }));
  // 成组入场：看容器里有多少子元素已激活
  const groups = [...document.querySelectorAll('[data-group]')].map((el, i) => {
    const kids = [...el.children];
    return { kind: 'group', i, ...rect(el),
             activated: kids.length > 0 && kids.every((k) => k.classList.contains('is-in')),
             kids: kids.length, kidsOn: kids.filter((k) => k.classList.contains('is-in')).length };
  });
  return [...rules, ...reveals, ...groups];
})()`;

/** 从 matrix(a, b, c, d, e, f) 里取 scaleX */
const scaleXOf = (t) => {
  const m = /matrix\(([-\d.]+)/.exec(t ?? '');
  return m ? Number(m[1]) : 1;
};

try {
  const ws = new WebSocket(await targetWs());
  await new Promise((r, j) => {
    ws.addEventListener('open', r, { once: true });
    ws.addEventListener('error', j, { once: true });
  });
  await rpc(ws, 'Page.enable');
  await rpc(ws, 'Runtime.enable');

  // 视口故意设矮，才能造出"有的在视口内、有的在外"的局面
  await rpc(ws, 'Emulation.setDeviceMetricsOverride', { width: 1100, height: 700, deviceScaleFactor: 1, mobile: false });
  await rpc(ws, 'Page.navigate', { url: `${BASE}/` });
  await sleep(2500);

  console.log('\n[1] 页面确实比视口长（否则谈不上"滚到哪里"）');
  const scrollable = await ev(ws, `document.documentElement.scrollHeight - window.innerHeight`);
  ok('可以滚动', scrollable > 200, `可滚动 ${scrollable}px`);

  console.log('\n[2] 首屏：视口外的元素必须还没激活');
  let s = await ev(ws, SNAPSHOT);
  const rules = s.filter((x) => x.kind === 'rule');
  ok('页面里存在划线元素（data-rule）', rules.length >= 2, `${rules.length} 个`);
  const outOfView = s.filter((x) => !x.inView);
  const wronglyOn = outOfView.filter((x) => x.activated);
  ok(
    `视口外的元素尚未激活（共 ${outOfView.length} 个在视口外）`,
    wronglyOn.length === 0,
    wronglyOn.slice(0, 3).map((x) => `${x.kind}#${x.i} top=${x.top} 已激活${x.activated}`).join(', '),
  );

  // 卡片在滚到之前必须是"看不见"的，否则用户看到的就是一坨已经在那儿的静态内容
  const hiddenCards = await ev(
    ws,
    `(() => {
       const cards = [...document.querySelectorAll('[data-group] > *')];
       const off = cards.filter(el => el.getBoundingClientRect().top > window.innerHeight);
       return { total: cards.length, off: off.length,
                hidden: off.filter(el => Number(getComputedStyle(el).opacity) < 0.1).length };
     })()`,
  );
  ok(
    '视口外的卡片处于隐藏态（opacity≈0）',
    hiddenCards.off === 0 || hiddenCards.hidden === hiddenCards.off,
    `视口外 ${hiddenCards.off} 张，其中隐藏 ${hiddenCards.hidden} 张`,
  );

  console.log('\n[3] 划线在激活前是收起的（scaleX≈0）');
  const pendingRule = s.find((x) => x.kind === 'rule' && !x.activated);
  if (pendingRule) {
    ok('未激活的划线 scaleX≈0', Math.abs(scaleXOf(pendingRule.ruleScaleX)) < 0.01, pendingRule.ruleScaleX);
    ok('划线有过渡时长（说明是画出来的，不是硬切）', /[1-9]/.test(pendingRule.ruleTransition ?? ''), pendingRule.ruleTransition);
  } else {
    ok('存在未激活的划线（首屏条件不足，跳过）', true);
  }

  console.log('\n[4] 滚动到底：之前视口外的元素应逐个激活');
  const before = s.filter((x) => !x.inView).length;
  // 分几次滚，模拟真实滚动而不是一步跳到底
  for (let i = 1; i <= 6; i += 1) {
    await ev(ws, `window.scrollTo({ top: document.documentElement.scrollHeight * ${i} / 6, behavior: 'instant' })`);
    await sleep(700);
  }
  await sleep(1200);
  s = await ev(ws, SNAPSHOT);
  const stillOff = s.filter((x) => !x.activated);
  ok(
    `滚到底后全部激活（首屏有 ${before} 个在视口外）`,
    stillOff.length === 0,
    stillOff.slice(0, 4).map((x) => `${x.kind}#${x.i} top=${x.top}`).join(', '),
  );
  const rulesAfter = s.filter((x) => x.kind === 'rule' && x.activated);
  ok(
    '划线都已展开（scaleX≈1）',
    rulesAfter.every((x) => Math.abs(scaleXOf(x.ruleScaleX) - 1) < 0.02),
    rulesAfter.map((x) => scaleXOf(x.ruleScaleX).toFixed(2)).join(','),
  );

  console.log('\n[5] 回到顶部：已激活的不应退回（只播一次，不做滚动跟随）');
  await ev(ws, `window.scrollTo({ top: 0, behavior: 'instant' })`);
  await sleep(900);
  s = await ev(ws, SNAPSHOT);
  const deactivated = s.filter((x) => !x.activated);
  ok('滚回顶部后没有元素退回未激活', deactivated.length === 0, deactivated.slice(0, 3).map((x) => `${x.kind}#${x.i}`).join(', '));

  console.log('\n[6] 归档页的月份划线也生效');
  await rpc(ws, 'Page.navigate', { url: `${BASE}/archive/` });
  await sleep(2200);
  const arcRules = await ev(ws, `document.querySelectorAll('[data-rule]').length`);
  ok('归档页有划线元素', arcRules >= 1, `${arcRules} 个`);
  await ev(ws, `window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' })`);
  await sleep(1500);
  const arcPending = await ev(ws, `[...document.querySelectorAll('[data-rule]')].filter(el => !el.classList.contains('is-in')).length`);
  ok('归档页滚到底后划线都激活', arcPending === 0, `仍有 ${arcPending} 个未激活`);

  console.log('\n[7] 最坏情况：脚本没跑时内容必须可见（不能白屏）');
  // 这是选"显式隐藏态 + js-anim 标记"而不是直接写 opacity:0 的**唯一理由**：
  // 万一脚本被拦/报错，页面必须是完整可读的，而不是一片空白。
  await rpc(ws, 'Emulation.setScriptExecutionDisabled', { value: true });
  await rpc(ws, 'Page.navigate', { url: `${BASE}/` });
  await sleep(2000);
  const noJs = await ev(ws, `
    (() => {
      const html = document.documentElement;
      const cards = [...document.querySelectorAll('[data-group] > *')];
      return {
        hasMarker: html.classList.contains('js-anim'),
        cards: cards.length,
        visible: cards.filter(el => Number(getComputedStyle(el).opacity) > 0.9).length,
      };
    })()
  `);
  ok('禁用脚本时没有 js-anim 标记', noJs.hasMarker === false, JSON.stringify(noJs));
  ok(
    '禁用脚本时卡片全部可见（不会白屏）',
    noJs.cards === 0 || noJs.visible === noJs.cards,
    `共 ${noJs.cards} 张，可见 ${noJs.visible} 张`,
  );
  await rpc(ws, 'Emulation.setScriptExecutionDisabled', { value: false });

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
console.log('滚动入场：视口外不动、滚到才出现、只播一次');
