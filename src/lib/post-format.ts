/**
 * 文章 frontmatter 的解析 / 序列化，以及预览用的极简 Markdown 渲染。
 *
 * 为什么抽成独立模块（而不是留在 Admin.tsx 里）：
 *  1. **序列化结果必须和 Astro 的 schema 对得上**（`src/content.config.ts`）。
 *     写错一个字段名或日期格式，是"面板说保存成功、构建时却挂在 schema 校验"——
 *     这类错误在浏览器里看不见，只有构建期才炸。抽出来就能被测试覆盖。
 *  2. 预览用的 `mdToHtml` 输出会进 `dangerouslySetInnerHTML`，
 *     属于必须验"会不会被内容注入"的地方。
 *  3. Admin.tsx 是 .tsx（有 JSX），Node 无法直接加载；纯逻辑放这里就能。
 */

export interface Frontmatter {
  title: string;
  description: string;
  pubDate: string;
  tags: string;
  featured: boolean;
  draft: boolean;
  cover: string;
  coverFocus: string;
}

export const EMPTY_FRONTMATTER: Frontmatter = {
  title: '',
  description: '',
  pubDate: new Date().toISOString().slice(0, 10),
  tags: '',
  featured: false,
  draft: true,
  cover: '',
  coverFocus: '50% 50%',
};

/** 解析 markdown 的 frontmatter；缺字段用 EMPTY 兜底，保证面板永远有完整表单 */
export function parsePost(text: string): { fm: Frontmatter; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { fm: { ...EMPTY_FRONTMATTER }, body: text };

  const fm: Frontmatter = { ...EMPTY_FRONTMATTER };
  for (const line of m[1].split('\n')) {
    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, k, vRaw] = kv;
    // 去掉 YAML 的引号包裹（JSON.stringify 写出来的就是双引号形态）
    const v = vRaw.trim().replace(/^"(.*)"$/s, '$1').replace(/^'(.*)'$/s, '$1').replace(/\\"/g, '"');
    if (k === 'title') fm.title = v;
    else if (k === 'description') fm.description = v;
    else if (k === 'pubDate') fm.pubDate = v.slice(0, 10);
    else if (k === 'tags') fm.tags = v.replace(/^\[|\]$/g, '').split(',').map((t) => t.trim().replace(/^"|"$/g, '')).filter(Boolean).join(', ');
    else if (k === 'featured') fm.featured = v === 'true';
    else if (k === 'draft') fm.draft = v === 'true';
    else if (k === 'cover') fm.cover = v;
    else if (k === 'coverFocus') fm.coverFocus = v || '50% 50%';
  }
  return { fm, body: text.slice(m[0].length) };
}

/**
 * 把表单序列化回 markdown。
 *
 * 用 JSON.stringify 生成 YAML 标量：它产出的双引号字符串是合法的 YAML 双引号标量，
 * 中文标题里的 `：`、`"`、`#` 都不会破坏解析——这正是手写 YAML 最容易踩的坑。
 * 日期写不带引号的 `YYYY-MM-DD`：Astro 的 `z.coerce.date()` 直接吃得下。
 */
export function serializePost(fm: Frontmatter, body: string): string {
  const tags = fm.tags
    .split(/[,，\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);

  const lines = [
    '---',
    `title: ${JSON.stringify(fm.title)}`,
    `description: ${JSON.stringify(fm.description)}`,
    `pubDate: ${fm.pubDate}`,
    `tags: [${tags.map((t) => JSON.stringify(t)).join(', ')}]`,
    `featured: ${fm.featured}`,
    `draft: ${fm.draft}`,
    ...(fm.cover ? [`cover: ${JSON.stringify(fm.cover)}`] : []),
    ...(fm.cover ? [`coverFocus: ${JSON.stringify(fm.coverFocus || '50% 50%')}`] : []),
    '---',
    '',
  ];
  return `${lines.join('\n')}${body.trim()}\n`;
}

/** 由标题与日期生成 slug（文件名）：保留中文，其余折成短横线 */
export function slugify(title: string, date: string): string {
  const ascii = title
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${date}-${ascii || 'post'}`;
}

/**
 * URL 白名单：只放行 http/https/mailto/站内相对路径与锚点。
 *
 * 这里是**真的安全边界**，不是形式主义：预览的 HTML 会进 React 的
 * `dangerouslySetInnerHTML`，而它会原样渲染 `href`。于是正文里写一个
 * `[点我](javascript:alert(1))`，读者点一下就执行了——React 不会拦这个
 * （它只转义文本，不校验属性里的 URL）。测试脚本抓到过一次。
 */
function safeUrl(raw: string): string {
  const url = raw.trim();
  // 控制字符会被浏览器忽略后再解析，`java\nscript:` 这类绕过必须先剥掉再判断
  const probe = url.replace(/[\u0000-\u001f\u007f\s]/g, '').toLowerCase();
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(probe);
  if (scheme) {
    const s = scheme[1];
    if (s === 'http' || s === 'https' || s === 'mailto') return url;
    return '#'; // 其余一律废掉（javascript:/data:/vbscript: 等）
  }
  // 没有 scheme：相对路径、锚点、查询串都安全；`//host` 也算协议相对，放行
  if (probe.startsWith('javascript')) return '#';
  return url;
}

/**
 * 极简 Markdown → HTML，只用于面板里的实时预览。
 * 刻意不引 markdown-it：预览只要"看得懂结构"，多 30KB 换 5% 的渲染保真度不划算。
 *
 * **两道防线**：文本过 `esc()`（标签与引号都转义），URL 过 `safeUrl()`（伪协议废掉）。
 */
export function mdToHtml(md: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let inCode = false;
  let inList = false;

  const inline = (s: string) =>
    esc(s)
      .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt: string, url: string) => `<img alt="${alt}" src="${safeUrl(url)}" />`)
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text: string, url: string) => `<a href="${safeUrl(url)}">${text}</a>`)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>');

  for (const raw of lines) {
    if (raw.startsWith('```')) {
      if (inList) (out.push('</ul>'), (inList = false));
      out.push(inCode ? '</pre>' : '<pre>');
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out.push(esc(raw));
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(raw);
    if (h) {
      if (inList) (out.push('</ul>'), (inList = false));
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
      continue;
    }
    const li = /^[-*]\s+(.*)$/.exec(raw);
    if (li) {
      if (!inList) (out.push('<ul>'), (inList = true));
      out.push(`<li>${inline(li[1])}</li>`);
      continue;
    }
    if (inList) (out.push('</ul>'), (inList = false));
    if (raw.startsWith('> ')) {
      out.push(`<blockquote>${inline(raw.slice(2))}</blockquote>`);
      continue;
    }
    if (raw.trim() === '') {
      out.push('');
      continue;
    }
    out.push(`<p>${inline(raw)}</p>`);
  }
  if (inList) out.push('</ul>');
  if (inCode) out.push('</pre>');
  return out.join('\n');
}
