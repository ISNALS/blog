import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import { SITE } from '../consts';

/**
 * 站点前缀（含 base），例如 `https://isnals.github.io/blog`。
 *
 * 这里有一处**很容易踩、且本地完全测不出来**的坑，记下来：
 * `@astrojs/rss` 用 `new URL(link, site)` 拼条目链接。而按 RFC 3986，
 * **根相对路径 `/posts/x/` 是相对"域根"解析的**，会把 base 整段丢掉：
 *     new URL('/posts/x/', 'https://host/blog/')  ===  'https://host/posts/x/'   ← base 没了
 * 所以即便把 `site` 写成带 base 的完整地址、channel 的 link 也正确，
 * 每个条目的 link 仍然会缺 `/blog`，订阅者点开全是 404。
 * 解法是**传绝对 URL**——`@astrojs/rss` 对能 `new URL()` 解析的链接会原样采用。
 */
const PREFIX = SITE.url.replace(/\/$/, '');

export async function GET() {
  const posts = await getCollection('posts', ({ data }) => !data.draft);
  posts.sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());

  return rss({
    title: SITE.title,
    description: SITE.description,
    // 不要用 `context.site`：它是 astro.config 的 `site`，只有裸域名
    site: SITE.url,
    items: posts.map((p) => ({
      title: p.data.title,
      description: p.data.description,
      pubDate: p.data.pubDate,
      // 绝对 URL（见上面的 PREFIX 注释）；写成 `/posts/${p.id}/` 会丢掉 base
      link: `${PREFIX}/posts/${p.id}/`,
      categories: p.data.tags,
    })),
    customData: `<language>${SITE.locale}</language>`,
  });
}
