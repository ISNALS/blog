import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

/**
 * 文章集合。
 *
 * 为什么内容按「一篇文章一个 .md 文件」存：
 *  - GitHub Pages 是纯静态托管，没有数据库；仓库本身就是内容库，git 历史就是版本历史
 *  - 新建文章 = 往仓库提交一个文件（Admin 面板走 GitHub Contents API 完成这一步）
 *  - 图片按相对路径写在正文里（`![](../../images/xxx.png)` 或 `/blog/images/xxx.png`），
 *    Admin 面板上传图片时会自动插入正确路径
 */
const posts = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/posts' }),
  schema: z.object({
    title: z.string().max(80),
    /** 摘要：列表页与 OG 描述都用它 */
    description: z.string().max(200).default(''),
    pubDate: z.coerce.date(),
    /** 置顶：列表最前、大卡展示 */
    featured: z.boolean().default(false),
    /** 草稿：只在本地 dev 可见，构建时跳过 */
    draft: z.boolean().default(false),
    tags: z.array(z.string()).default([]),
    /** 封面图：仓库内路径（/blog/images/x.jpg）或外链 */
    cover: z.string().optional(),
    /** 封面对焦位置，用于卡片裁切构图（CSS object-position） */
    coverFocus: z.string().default('50% 50%'),
    /** 语言，留着以后写英文文章 */
    lang: z.string().default('zh'),
  }),
});

export const collections = { posts };
