/**
 * 产物自检：在 dist/ 里逐条核对站内链接是否有对应产物。
 *
 * 为什么值得单独写一个：纯静态站里一个写错的内部链接**在构建期不会报错**，
 * 在 dev 服务器上也常常"能打开"（dev 有兜底路由），只有部署后才变成 404。
 * 所以这一检查打在**构建产物**上，而不是源码上。
 *
 *   node scripts/check-links.mjs
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'dist');
const BASE = '/blog';

/** 递归收集所有 .html */
function htmlFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) htmlFiles(p, out);
    else if (name.endsWith('.html')) out.push(p);
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

if (!existsSync(DIST)) {
  console.error('dist/ 不存在，先跑 npm run build');
  process.exit(2);
}

const pages = htmlFiles(DIST);
const missing = [];
let checked = 0;

for (const page of pages) {
  const html = readFileSync(page, 'utf8');
  for (const m of html.matchAll(ATTR)) {
    const raw = m[1];
    if (SKIP.test(raw)) continue;
    const path = raw.split('?')[0].split('#')[0];
    if (!path) continue;
    checked += 1;
    if (!resolves(path)) missing.push([relative(DIST, page), raw]);
  }
}

console.log(`扫描 ${pages.length} 个 HTML，检查 ${checked} 条站内链接`);
if (missing.length > 0) {
  console.error(`\n发现 ${missing.length} 条断链：`);
  for (const [page, link] of missing.slice(0, 40)) console.error(`  ${page}  ->  ${link}`);
  process.exit(1);
}
console.log('全部内部链接都有对应产物');
