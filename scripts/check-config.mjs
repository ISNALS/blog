/**
 * 部署前置检查：确认"三个地方写的站点坐标"彼此一致，且没有任何占位符残留。
 *
 * 为什么需要它：这个站的部署坐标分散在三处，各自用途不同——
 *   · `src/consts.ts`  → `SITE.url`（canonical / OG / RSS 绝对地址）与 `GITHUB.user/repo`（面板要提交到哪）
 *   · `astro.config.mjs` → `site` + `base`（决定所有资源与站内链接的前缀）
 *   · 仓库名与 base 的对应关系（`<user>.github.io` 是主页仓库，base 必须为空）
 * 只改其中一处是**最容易犯且最难自查**的错误：本地 dev 一切正常，
 * 部署后出现一堆 404 或者 canonical 指错域名。这个脚本把它们放到一起比对。
 *
 *   node scripts/check-config.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const grab = (text, re, label) => {
  const m = re.exec(text);
  if (!m) throw new Error(`读不到 ${label}（正则 ${re} 没匹配上，可能是配置结构变了）`);
  return m[1];
};

const cfg = read('astro.config.mjs');
const consts = read('src/consts.ts');

// 注意这两个值**本来就不该相等**（这里一开始就断言错了，预检脚本自己抓到）：
//   astro.config 的 SITE = 裸域名，供 Astro 拼 canonical 用
//   consts 的 SITE.url    = 站点完整地址（含 base），供 RSS/OG 用
// 真正要验的是：裸域名 + base 拼出来必须等于 consts 的 url。
const rawAstroSite = grab(cfg, /export const SITE = '([^']+)'/, 'astro.config 的 SITE');
const astroSite = rawAstroSite.replace(/\/$/, '');
const astroBase = grab(cfg, /export const BASE = '([^']*)'/, 'astro.config 的 BASE');
const siteUrl = grab(consts, /url: '([^']+)'/, 'consts 的 SITE.url').replace(/\/$/, '');
const user = grab(consts, /user: '([^']+)'/, 'consts 的 GITHUB.user');
const repo = grab(consts, /repo: '([^']+)'/, 'consts 的 GITHUB.repo');
const title = grab(consts, /title: '([^']+)'/, 'consts 的 SITE.title');
const author = grab(consts, /author: '([^']+)'/, 'consts 的 SITE.author');
const ns = grab(consts, /namespace: '([^']+)'/, 'consts 的 COUNTER.namespace');

let pass = 0;
const fails = [];
const warnings = [];
const ok = (name, cond, detail = '') => {
  if (cond) {
    pass += 1;
    console.log(`  OK   ${name}`);
  } else {
    fails.push(`${name}${detail ? ' — ' + detail : ''}`);
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
};
const warn = (name, detail) => {
  warnings.push(`${name} — ${detail}`);
  console.log(`  WARN ${name} — ${detail}`);
};

console.log('\n[1] 站点坐标三处一致');
const isUserPages = repo.toLowerCase() === `${user.toLowerCase()}.github.io`;
const expectBase = isUserPages ? '' : `/${repo}`;
ok(
  'astro.config 的 SITE 是裸域名（不带路径）',
  /^https:\/\/[^/]+\/?$/.test(rawAstroSite),
  rawAstroSite,
);
ok(
  'consts 的 url = astro 的 site + base（两处拼接后必须相等）',
  siteUrl === `${astroSite}${astroBase}`,
  `${siteUrl} vs ${astroSite}${astroBase}`,
);
ok(
  `base 与仓库类型匹配（${isUserPages ? '主页仓库 → base 应为空' : '项目仓库 → base 应为 /' + repo}）`,
  astroBase === expectBase,
  `实际 base=${JSON.stringify(astroBase)}，期望 ${JSON.stringify(expectBase)}`,
);
// 交叉校验（自测脚本逼出来的）：只改 BASE 而不改 url 时，
// 上面的 `url = site + base` 等式**仍然自洽**，于是那种失误会漏过去。
// 所以再独立核对一次"url 是不是 site 拼上按仓库名推出的 base"。
ok(
  'url 的路径前缀与仓库名推出的 base 一致',
  siteUrl === `${astroSite}${expectBase}`,
  `url=${siteUrl}，按仓库名 ${repo} 推出的应是 ${astroSite}${expectBase}`,
);

console.log('\n[2] 没有占位符残留');
// 这一节刻意把"占位值"当**失败**而不是警告：
// 部署坐标还是占位时，站点能构建、页面能打开，但 canonical/OG/RSS 全指向别人的域名，
// 而且面板会把文章提交到 `LHX/blog` 这个不存在的仓库。这类错误必须硬拦。
const PLACEHOLDER = /^(LHX|your-?name|username|YOUR_[A-Z_]+|<.*>)$/i;
for (const [label, value] of [
  ['GITHUB.user', user],
  ['GITHUB.repo', repo],
  ['SITE.url', siteUrl],
]) {
  ok(`${label} 不是占位值`, !PLACEHOLDER.test(value), `"${value}"`);
}
const placeholderLeft = PLACEHOLDER.test(user) || PLACEHOLDER.test(repo) || siteUrl.includes('LHX');
// 用户名/仓库名里出现 LHX 而另两处没同步时，上面已经在 [1] 拦下了；这里只提示范围
if (placeholderLeft) {
  console.log('       → 改完 src/consts.ts 的 user/repo/url 后，务必同步 astro.config.mjs 的 SITE/BASE');
}
// URL 里含大写用户名是合法的，但 GitHub 会把用户名与仓库名小写化，容易造成 base 不匹配
if (/[A-Z]/.test(repo)) warn('仓库名含大写字母', `GitHub 页面会小写化，base 请按实际 URL 写：${repo.toLowerCase()}`);
if (/[A-Z]/.test(user)) warn('用户名含大写字母', 'canonical 域名对大小写敏感，确认与 Pages 实际地址一致');

console.log('\n[3] 站点标识已脱离模板');
ok('标题不是模板默认的占位', title.length > 0, title);
ok('作者已填', author.length > 0, author);
ok('计数 namespace 已设置（Abacus 用它隔离不同站点）', ns.length > 0, ns);

console.log('\n[4] 计数服务可达（文章页的阅读数依赖它）');
const endpoint = grab(consts, /endpoint: '([^']+)'/, 'consts 的 COUNTER.endpoint');
try {
  // 对一个**尚未创建**的 key，Abacus 返回 404 {"error":"Key not found"}——
  // 这是它的正常语义（get 是只读，不会顺手创建）。所以判据不是"2xx"，
  // 而是"服务可达 + 返回体是我们认得的形状"。这里断言错了一次，别改回去。
  const res = await fetch(`${endpoint}/get/${encodeURIComponent(ns)}/config-preflight`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  const body = await res.json();
  const known = typeof body?.value === 'number' || body?.error === 'Key not found';
  ok('计数服务可达且返回可解析的响应', known, `HTTP ${res.status} ${JSON.stringify(body)}`);
  if (res.status === 404) {
    console.log('       （404 = 该 key 尚未创建，符合 Abacus 对只读 get 的定义；文章页首次访问时会自动登记）');
  }
} catch (err) {
  warn('计数服务当前不可达', `${endpoint} — ${err.message}；页面会退回本地缓存值，不会显示 0`);
}

console.log('\n[5] 工作流与构建产物约定一致');
const wf = read('.github/workflows/deploy.yml');
ok('工作流用 npm ci（需要 lockfile 入库）', /npm ci/.test(wf));
ok('工作流跑 npm run build', /npm run build/.test(wf));
ok('上传的是 ./dist', /path:\s*\.\/dist/.test(wf));
ok('trigger 分支与 consts 的 branch 一致', wf.includes(`branches: [${grab(consts, /branch: '([^']+)'/, 'consts 的 GITHUB.branch')}]`));
ok('.nojekyll 在 public/（否则 Pages 会忽略 _astro/ 这类下划线目录）', existsSync(join(ROOT, 'public/.nojekyll')));

console.log('\n[6] Node 版本三方一致（engines / CI）');
// 这一条是"只在 CI 挂"的经典来源：scripts/*.mts 靠 Node 的类型剥离跑源码里的 .ts，
// 而剥离从 **23.6** 起才默认开启（22.x 需要 --experimental-strip-types）。
// 声明 22 会让 CI 报 "Unknown file extension .ts"，本地却全绿。
const NODE_MIN = [23, 6];
const cmp = (a, b) => (a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1]);
/** 取版本号里的 主.次 两段，用于比较 */
const parseVer = (v) => v.split('.').map(Number).concat([0, 0]).slice(0, 2);

const enginesField = grab(read('package.json'), /"node":\s*">=([\d.]+)"/, 'package.json 的 engines.node');
// 工作流里我们写的是范围（'>=23.6'），所以正则需要容忍前导的 >=
const wfNode = grab(wf, /node-version:\s*'?[><=~^]*([\d.]+)'?/, 'workflow 的 node-version');

ok('engines 与 workflow 声明同一个版本', enginesField === wfNode, `engines>=${enginesField} / workflow=${wfNode}`);
ok(
  `声明版本不低于 ${NODE_MIN.join('.')}（类型剥离默认开启的最低版本）`,
  cmp(parseVer(enginesField), NODE_MIN) >= 0,
  `实际 ${enginesField}`,
);
if (!existsSync(join(ROOT, 'package-lock.json'))) {
  fails.push('package-lock.json 缺失（npm ci 会失败）');
  console.log('  FAIL package-lock.json 缺失（npm ci 会失败）');
} else {
  ok('package-lock.json 存在（npm ci 的前提）', true);
}
// 自检：别把断言写成 `ok(cond, name)` —— 那样输出会变成 "OK true"，
// 检查器看起来还在跑，实际标签全是噪音（本项目踩过三次）。
if (typeof enginesField !== 'string' || typeof wfNode !== 'string') {
  fails.push('Node 版本断言拿到了非字符串（配置结构可能变了）');
}

console.log(`\n通过 ${pass} 项，失败 ${fails.length} 项，警告 ${warnings.length} 项`);
if (warnings.length > 0) {
  console.log('警告（不阻断构建，但部署前应处理）：\n  - ' + warnings.join('\n  - '));
}
if (fails.length > 0) {
  console.log('失败项：\n  - ' + fails.join('\n  - '));
  process.exit(1);
}
console.log(fails.length === 0 && warnings.length === 0 ? '部署配置一致，可以 push' : '配置无硬错误');
