// @ts-check
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import react from '@astrojs/react';

// 站点地址：
//   - 用户主页仓库（<user>.github.io）→ SITE 与 BASE 都用根
//   - 项目仓库（<user>/blog）        → SITE 是 https://<user>.github.io，BASE 是 /blog
// 这里先按项目仓库写好占位，你 push 前把 LHX 换成你的 GitHub 用户名即可
// （`src/consts.ts` 里同一份信息，Admin 面板也读它）。
export const SITE = 'https://LHX.github.io';
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
