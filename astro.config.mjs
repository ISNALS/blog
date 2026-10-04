// @ts-check
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import react from '@astrojs/react';

// 站点地址：
//   - 用户主页仓库（<user>.github.io）→ SITE 与 BASE 都用根
//   - 项目仓库（<user>/blog）        → SITE 是 https://<user>.github.io，BASE 是 /blog
// 本仓库是项目仓库 ISNALS/blog，所以 BASE = /blog。
// 域名必须小写：GitHub Pages 的域名会把用户名小写化（ISNALS → isnals）。
// `src/consts.ts` 的 SITE.url 是同一份信息（= SITE + BASE），Admin 面板也读它；
// 两处不一致会被 `npm run check:config` 拦下。
export const SITE = 'https://isnals.github.io';
export const BASE = '/blog';

export default defineConfig({
  site: SITE,
  base: BASE,
  trailingSlash: 'ignore',
  integrations: [sitemap(), react()],
  markdown: {
    // 代码高亮：Shiki，双主题（浅/深各一套，由 CSS 变量切换）
    shikiConfig: {
      themes: { light: 'github-light', dark: 'github-dark-dimmed' },
      wrap: true,
    },
  },
  vite: {
    resolve: {
      // 与 tsconfig 的 paths 保持一致：客户端脚本里 import '@/' 也能解析。
      // 必须用 fileURLToPath 而不是 new URL().pathname —— 后者在 Windows 上会给出
      // `/D:/...` 这种带前导斜杠且带 %20 转义的路径，rollup 解析时拼成 `D:\D:\...` 直接 ENOENT。
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    build: {
      // 动效库 + 后台面板是独立 chunk，别让它们拖慢文章首屏
      assetsInlineLimit: 2048,
    },
  },
});
