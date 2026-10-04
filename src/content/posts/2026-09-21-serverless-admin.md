---
title: 没有服务器怎么给静态博客做"后台"
description: GitHub Pages 是纯静态托管，但仓库本身就是数据库。把"发布文章"翻译成"提交一个文件"，后台就成立了。
pubDate: 2026-09-21
tags: [工程, 静态站点]
cover: /blog/images/cover-static.svg
---

我做这个博客的第一个决定是：**不买服务器**。

第二个决定更难：既然没有服务器，"发布文章"这件事该怎么办？

## 静态托管到底缺什么

GitHub Pages 给你的是：一个域名、一个 CDN、以及"把仓库里的静态文件发出去"这一个能力。它缺的只有一样东西——**写**。

- 访客能读，但没人能往回写
- 没有数据库可以存新文章
- 没有进程可以在后台跑

所以问题的正确问法不是"静态站怎么做后台"，而是：**什么东西既能当存储、又能被写、还不用服务器？**

答案是仓库本身。

## 仓库就是数据库

一篇文章 = 一个 markdown 文件。那么：

| 传统做法 | 这里怎么做 |
|---|---|
| 写入数据库 | 往仓库提交一个文件（GitHub Contents API） |
| 编辑文章 | 取文件 → 改 → 带 sha 再提交一次 |
| 删除文章 | 提交一次删除 |
| 版本历史 | git log，自带，还免费 |
| 定时发布 / 构建 | GitHub Actions |
| 上传图片 | 同一个 API，二进制走 base64 |

最妙的一步是最后两行：**提交即触发构建**。所以"发布"这个动作天然是完整的——不需要我再写任何部署逻辑。

## 那个面板长什么样

面板的全部职责就是把上面那张表变成按钮。核心其实只有两个请求：

```ts
// 读一篇文章
GET /repos/:owner/:repo/contents/:path

// 写回去（没有 sha 就是新建）
PUT /repos/:owner/:repo/contents/:path
{ message, content: base64(text), branch, sha? }
```

注意 `content` 必须是 base64，而且**中文要先转 UTF-8 再 base64**。这一步我用 `TextEncoder` 绕过去，否则提交上去的中文全会变成乱码：

```ts
const bytes = new TextEncoder().encode(text);
let bin = '';
bytes.forEach((b) => (bin += String.fromCharCode(b)));
return btoa(bin);
```

## 关于令牌，说清楚

浏览器直连 GitHub 需要 token。三件事必须讲明白，否则这东西不该被用：

1. **权限最小化**：用 Fine-grained token，只勾这一个仓库，权限只给 `Contents: Read and write`。不要用 classic token 的 `repo` 全权限——那等于把整个账号交出去。
2. **存在哪**：只存浏览器的 localStorage，请求直连 api.github.com，不经过本站（本站也没有后端可以经过）。
3. **代价**：token 在浏览器里就等于"这台设备有写权限"。所以别在公共电脑上连。

这三条不是免责声明，是使用说明书。**一个工具如果不把它的信任边界讲清楚，那它就不该被托付任何东西。**

## 那阅读量呢

阅读量是唯一一件"仓库解决不了"的事：仓库里存不了访问日志。

两条路：

- **GitHub 官方流量数据**：零第三方，但只保留 14 天，而且必须带 token 才看得到。
- **第三方计数服务**：比如 Abacus，免费开源，一行 API：`GET /hit/{namespace}/{counter}`，同一访客 24 小时只计一次。

我选了后者，因为它把"数字"变成了一次普通的 HTTP 请求——静态站最擅长处理的东西。

代价是引入了一个外部依赖。所以我做了一件事：**接口挂了就显示缓存值，不显示 0**。宁可显示一个旧数字，也不要显示一个假数字。
