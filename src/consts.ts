/**
 * 站点常量：**改这一个文件就能把站点变成你自己的**。
 *
 * 部署前只需改三处：GITHUB.user、GITHUB.repo、以及 SITE_URL（与 astro.config.mjs 保持一致）。
 * Admin 面板（/admin）会读这里的值来拼 GitHub API 地址——所以不必在代码里到处找硬编码。
 */
export const SITE = {
  /** 站点标题（页签 + RSS + 首页刊头） */
  title: '壹个地方',
  /** 副标题：一句话说清这个博客是什么 */
  tagline: '写代码、写片子，偶尔写人。',
  /** 作者名（页脚版权、关于页、以及 description 里的自我介绍都用它） */
  author: '八尺雪',
  /** 描述（SEO / OG） */
  description: '一个写代码与影像的地方。文章、笔记、以及做过的东西。',
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
