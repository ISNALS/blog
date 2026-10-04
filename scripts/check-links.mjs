/**
 * 产物自检：在 dist/ 里逐条核对站内链接是否有对应产物。
 *
 * 为什么值得单独写一个：纯静态站里一个写错的内部链接**在构建期不会报错**，
 * 在 dev 服务器上也常常"能打开"（dev 有兜底路由），只有部署后才变成 404。
 * 所以这一检查打在**构建产物**上，而不是源码上。
 *
 * 检查两类问题：
 *   1. 相对链接（`/blog/xxx`）——有没有对应产物
 *   2. **绝对自链接**（`https://<站点域名>/xxx`）——前缀是否等于 site + base
 *      第 2 类是踩出来的：RSS 用 `context.site`（裸域名）拼相对路径，
 *      产出的链接缺了 `/blog`，在本地 dev 完全看不出来，线上全是 404。
 *
 *   node scripts/check-links.mjs
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'dist');

// 从 astro.config 读 site/base，这样检查跟着配置走，不用手工同步
const cfg = readFileSync(join(ROOT, 'astro.config.mjs'), 'utf8');
const SITE = /export const SITE = '([^']+)'/.exec(cfg)[1].replace(/\/$/, '');
const BASE = /export const BASE = '([^']*)'/.exec(cfg)[1];
const PREFIX = `${SITE}${BASE}`;
const HOST = new URL(SITE).host;

/** 递归收集所有 .html / .xml */
function htmlFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) htmlFiles(p, out);
    else if (name.endsWith('.html') || name.endsWith('.xml')) out.push(p);
  }
  return out;
}

/** 把 URL 路径映射到 dist 里的文件 */
function resolves(path) {
  if (!path.startsWith(BASE)) return true; // 站外
  let rel = decodeURIComponent(path.slice(BASE.length)).replace(/^\/+/, '');
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  const target = join(DIST, rel);
  if (existsSync(target) && statSync(target).isFile()) return true;
  if (existsSync(join(DIST, rel, 'index.html'))) return true;
  if (existsSync(join(DIST, rel.replace(/\.html$/, '') + '.html'))) return true;
  return false;
}

const ATTR = /(?:href|src)="([^"]+)"/g;
const SKIP = /^(https?:|mailto:|#|data:|javascript:|\/\/)/;
/** 抓出页面/feed 里指向本域名的一切绝对地址 */
const ABS_SELF = new RegExp(`https?://${HOST.replace(/\./g, '\\.')}(/[^"'\\s<>)]*)?`, 'g');

if (!existsSync(DIST)) {
  console.error('dist/ 不存在，先跑 npm run build');
  process.exit(2);
}

const pages = htmlFiles(DIST);
const missing = [];
const badPrefix = [];
let checked = 0;
let absChecked = 0;

for (const page of pages) {
  const text = readFileSync(page, 'utf8');
  const where = relative(DIST, page);

  if (page.endsWith('.html')) {
    for (const m of text.matchAll(ATTR)) {
      const raw = m[1];
      if (SKIP.test(raw)) continue;
      const path = raw.split('?')[0].split('#')[0];
      if (!path) continue;
      checked += 1;
      if (!resolves(path)) missing.push([where, raw]);
    }
  }

  // 绝对自链接必须带 base 前缀（RSS/OG/canonical 都走这里）
  for (const m of text.matchAll(ABS_SELF)) {
    const path = m[1] ?? '/';
    absChecked += 1;
    const hostOnly = path === '/' || path === '';
    const ok = hostOnly ? BASE === '' : path === BASE || path.startsWith(`${BASE}/`) || path.startsWith(`${BASE}?`);
    if (!ok) badPrefix.push([where, m[0]]);
  }
}

console.log(`扫描 ${pages.length} 个 HTML/XML：相对站点内链 ${checked} 条，绝对自链接 ${absChecked} 条`);

let failed = false;
if (missing.length > 0) {
  failed = true;
  console.error(`\n发现 ${missing.length} 条断链：`);
  for (const [page, link] of missing.slice(0, 40)) console.error(`  ${page}  ->  ${link}`);
}
if (badPrefix.length > 0) {
  failed = true;
  console.error(
    `\n发现 ${badPrefix.length} 条绝对自链接缺少 base 前缀（应为 ${PREFIX}）：\n` +
      '  这类错误在本地 dev 看不出来（dev 会补上 base），只有线上才 404。',
  );
  for (const [page, link] of badPrefix.slice(0, 40)) console.error(`  ${page}  ->  ${link}`);
}
if (failed) process.exit(1);
console.log(`全部内部链接都有对应产物（绝对自链接均带 ${BASE || '(无 base)'} 前缀）`);
