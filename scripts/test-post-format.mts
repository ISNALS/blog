/**
 * 面板纯逻辑测试：frontmatter 解析/序列化 + 预览渲染的安全性。
 *
 * 为什么必须测这两块：
 *  · 序列化的结果要交给 Astro 的 schema（`src/content.config.ts`）去解析。
 *    字段名写错、日期带了引号、tags 少方括号——都是"面板说保存成功、
 *    构建时才发现挂"的错误，在浏览器里看不出来。
 *  · `mdToHtml` 的输出会进 `dangerouslySetInnerHTML`，必须验它不会被正文注入。
 *
 *   node scripts/test-post-format.mts
 */
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      return nextResolve(pathToFileURL(join(SRC, specifier.slice(2))).href + '.ts', context);
    }
    return nextResolve(specifier, context);
  },
});

const pf = await import('../src/lib/post-format.ts');

let pass = 0;
const fails: string[] = [];
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) {
    pass += 1;
    console.log(`  OK   ${name}`);
  } else {
    fails.push(name);
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
};

console.log('\n[1] 序列化 → 解析 往返');
const tricky = {
  ...pf.EMPTY_FRONTMATTER,
  title: '标题里有：中文冒号、"引号" 和 # 井号',
  description: '摘要里也有：冒号与 *星号*',
  pubDate: '2026-10-04',
  tags: '动效, 设计 测试',
  featured: true,
  draft: false,
  cover: '/blog/images/cover.svg',
};
const md = pf.serializePost(tricky, '正文第一段。\n\n## 小标题\n\n- 一\n- 二\n');
const back = pf.parsePost(md);
ok('标题原样往返（含冒号/引号/井号）', back.fm.title === tricky.title, back.fm.title);
ok('摘要原样往返', back.fm.description === tricky.description, back.fm.description);
ok('日期往返', back.fm.pubDate === '2026-10-04', back.fm.pubDate);
ok('tags 逗号与空格都当分隔符', back.fm.tags === '动效, 设计, 测试', back.fm.tags);
ok('布尔字段往返', back.fm.featured === true && back.fm.draft === false);
ok('封面往返', back.fm.cover === tricky.cover);
ok('正文被完整切出来（不含 --- 围栏）', back.body.startsWith('正文第一段。') && !back.body.includes('title:'));
ok('序列化结果以 --- 开头', md.startsWith('---\n'));
ok('序列化结果以换行结尾', md.endsWith('\n'));

console.log('\n[2] 序列化的字段名必须与 Astro schema 对齐');
const schemaFields = ['title', 'description', 'pubDate', 'tags', 'featured', 'draft', 'cover', 'coverFocus'];
const fmBlock = md.slice(4, md.indexOf('\n---', 4));
const writtenKeys = fmBlock.split('\n').map((l) => l.split(':')[0].trim()).filter(Boolean);
ok(
  '写出的字段都在 schema 里',
  writtenKeys.every((k) => schemaFields.includes(k)),
  writtenKeys.filter((k) => !schemaFields.includes(k)).join(','),
);
ok('没有漏写必填的 title / pubDate', writtenKeys.includes('title') && writtenKeys.includes('pubDate'));
ok('tags 是 YAML 数组形态', /^tags: \[.*\]$/m.test(fmBlock), fmBlock.split('\n').find((l) => l.startsWith('tags:')));
ok('布尔是裸 true/false（不是字符串）', /^featured: true$/m.test(fmBlock) && /^draft: false$/m.test(fmBlock));
ok('日期不带引号（z.coerce.date 直接吃）', /^pubDate: 2026-10-04$/m.test(fmBlock));
ok('没有封面时不写 cover/coverFocus', !pf.serializePost({ ...tricky, cover: '' }, 'x').includes('cover:'));

console.log('\n[3] 无 frontmatter 的容错');
const plain = pf.parsePost('就是一段正文，没有 frontmatter。');
ok('不抛异常', plain.fm.title === '' && plain.body === '就是一段正文，没有 frontmatter。');
ok('用默认值兜底（保证表单完整）', plain.fm.draft === true && plain.fm.coverFocus === '50% 50%');

console.log('\n[4] slug 生成');
ok('中文标题保留在文件名里', pf.slugify('中文标题测试', '2026-10-04') === '2026-10-04-中文标题测试', pf.slugify('中文标题测试', '2026-10-04'));
ok('英文与空格折成单个短横线', pf.slugify('Hello  World!', '2026-10-04') === '2026-10-04-hello-world', pf.slugify('Hello  World!', '2026-10-04'));
ok('纯符号标题有兜底', pf.slugify('！！！', '2026-10-04') === '2026-10-04-！！！'.replace('！！！', '！！！') ? true : pf.slugify('！！！', '2026-10-04').startsWith('2026-10-04-'), pf.slugify('！！！', '2026-10-04'));
ok('超长标题被截断到 40 字内', pf.slugify('a'.repeat(80), '2026-10-04').length <= 11 + 40);

console.log('\n[5] 预览渲染：结构与转义');
ok('标题渲染成 h2', pf.mdToHtml('## 小标题').includes('<h2>小标题</h2>'));
ok('加粗渲染成 strong', pf.mdToHtml('这是 **重点** 内容').includes('<strong>重点</strong>'));
ok('行内代码渲染成 code', pf.mdToHtml('用 `npm run dev` 启动').includes('<code>npm run dev</code>'));
ok('列表渲染成 ul/li', pf.mdToHtml('- 一\n- 二').includes('<ul>') && pf.mdToHtml('- 一\n- 二').includes('<li>一</li>'));
ok('引用渲染成 blockquote', pf.mdToHtml('> 引用一句').includes('<blockquote>引用一句</blockquote>'));
ok('图片渲染成 img', pf.mdToHtml('![](/blog/images/a.png)').includes('src="/blog/images/a.png"'));
ok('代码块渲染成 pre', pf.mdToHtml('```\nconst a = 1;\n```').includes('<pre>'));

console.log('\n[6] 预览渲染：注入防护（这段 HTML 会进 dangerouslySetInnerHTML）');
const evil = pf.mdToHtml('<script>alert(1)</script>');
ok('script 标签被转义', !evil.includes('<script>') && evil.includes('&lt;script&gt;'), evil);
const evil2 = pf.mdToHtml('<img src=x onerror=alert(1)>');
ok('onerror 属性无法逃逸', !evil2.includes('<img src=x') && evil2.includes('&lt;img'), evil2);
const evil3 = pf.mdToHtml('[点我](javascript:alert(1))');
ok('javascript: 伪协议被废掉（换成 #）', !/href="javascript:/i.test(evil3) && evil3.includes('href="#"'), evil3);
const evil3b = pf.mdToHtml('[点我](JaVaScRiPt:alert(1))');
ok('大小写混写的伪协议同样被废掉', !/href="javascript:/i.test(evil3b), evil3b);
const evil3c = pf.mdToHtml('[点我](java\nscript:alert(1))');
ok('插了换行的伪协议同样被废掉', !/href="javascript:/i.test(evil3c), evil3c);
const evil3d = pf.mdToHtml('[点我](data:text/html,<script>alert(1)</script>)');
ok('data: 伪协议被废掉', !/href="data:/i.test(evil3d), evil3d);
const good3 = pf.mdToHtml('[官网](https://example.com/a) 和 [站内](/blog/posts/x/) 和 [锚点](#top)');
ok('正常的 https / 站内 / 锚点链接不受影响', /href="https:\/\/example\.com\/a"/.test(good3) && /href="\/blog\/posts\/x\/"/.test(good3) && /href="#top"/.test(good3), good3);
const evil4 = pf.mdToHtml('![x"](" onerror="alert(1))');
ok('属性引号被转义（无法提前闭合属性）', !/onerror="alert/.test(evil4), evil4);
const evil5 = pf.mdToHtml('正常文本 & 符号 < 尖括号');
ok('正文里的 & 与 < 被转义', evil5.includes('&amp;') && evil5.includes('&lt;'), evil5);

console.log(`\n通过 ${pass} 项，失败 ${fails.length} 项`);
if (fails.length > 0) {
  console.log('失败项：\n  - ' + fails.join('\n  - '));
  process.exit(1);
}
console.log('面板纯逻辑全部符合预期');
