// 极简静态服务器：只用于本地验证 dist/ 产物（生产构建的渲染与 dev 会有差异，
// 所以交付前必须在真实产物上过一遍）。
//   node scripts/serve-dist.mjs [port]
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

// 必须用 fileURLToPath：URL.pathname 会给出 `/D:/ds%20hareness%20test/...` 这种
// 带前导斜杠 + 百分号转义的字符串，Windows 下直接 ENOENT（和 astro.config 的别名同一个坑）。
const ROOT = fileURLToPath(new URL('../dist', import.meta.url));
const BASE = '/blog';
const PORT = Number(process.argv[2] ?? 4500);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.xml': 'application/xml; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (!p.startsWith(BASE)) {
    res.writeHead(404).end('not found (只服务 ' + BASE + ' 前缀)');
    return;
  }
  p = p.slice(BASE.length) || '/';
  if (p.endsWith('/')) p += 'index.html';
  const file = normalize(join(ROOT, p));
  if (!file.startsWith(normalize(ROOT)) || !existsSync(file) || !statSync(file).isFile()) {
    // 目录无 index.html 时兜底到 404 页，模拟 GitHub Pages 的行为
    const notFound = join(ROOT, '404.html');
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    createReadStream(notFound).pipe(res);
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`[serve-dist] http://127.0.0.1:${PORT}${BASE}/`);
});
