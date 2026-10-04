/**
 * 站点常量：**改这一个文件就能把站点变成你自己的**。
 *
 * 部署前只需改三处：GITHUB.user、GITHUB.repo、以及 SITE_URL（与 astro.config.mjs 保持一致）。
 * Admin 面板（/admin）会读这里的值来拼 GitHub API 地址——所以不必在代码里到处找硬编码。
 */
export const SITE = {
  /** 站点标题（页签 + RSS + 首页刊头 + 分享卡片） */
  title: '八尺雪的小小屋子',
  /** 副标题：刊头上方那行小字 */
  tagline: '致给无处安放的自己',
  /** 作者名（页脚版权、关于页、以及 description 里的自我介绍都用它） */
  author: '八尺雪',
  /** 描述：**首页刊头下面那句**，同时用于 SEO / OG / RSS。
   *  改它会同时影响三处，这也是为什么它是一句话而不是一段。 */
  description: '欢迎你来到我的小小世界',
  /** 站点根地址：与 astro.config.mjs 的 site + base 拼出来的完整前缀一致。
   *  注意域名用**小写**：GitHub 会把用户名小写化用于 Pages 域名，
   *  而 canonical / OG / RSS 里的绝对地址对大小写敏感，写错会指向不存在的地址。 */
  url: 'https://isnals.github.io/blog',
  locale: 'zh-CN',
  /** 首页每页文章数 */
  pageSize: 6,
} as const;

export const GITHUB = {
  /** GitHub 用户名。填写时保持**大小写与账号一致**（API 路径用它，Pages 域名会小写化） */
  user: 'ISNALS',
  /** 仓库名 */
  repo: 'blog',
  /** 发布分支 */
  branch: 'main',
  /** 文章与图片所在的目录（Admin 面板只读写这两个目录） */
  postsDir: 'src/content/posts',
  imagesDir: 'public/images',
} as const;

/** 阅读量计数：Abacus（免费、开源、无需后端）。
 *  首次写入任意 namespace/counter 会自动登记；改成你自己的 namespace 即可。 */
export const COUNTER = {
  endpoint: 'https://abacus.jasoncameron.dev',
  namespace: 'lhx-blog',
} as const;

export const NAV = [
  { href: '/', label: '首页' },
  { href: '/archive', label: '归档' },
  { href: '/about', label: '关于' },
] as const;
