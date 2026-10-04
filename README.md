# 壹个地方 · 个人博客

一个**没有服务器**的个人博客：纯静态托管在 GitHub Pages，写作面板在浏览器里直连 GitHub 仓库，
文章即 markdown 文件，图片即仓库里的资源。

## 它长什么样

先锋刊物气质：离格排版、超大刊头、衬线正文、等宽元信息；
动效全站只用四个动作——**模糊化开 · 上浮 · 放大到位 · 淡入**，
配一条缓动曲线（`--ease-out: cubic-bezier(0.16, 1, 0.3, 1)`）。

动效出现在三个层次，用的是同一套语言：

| 层次 | 位置 | 做法 |
|---|---|---|
| 页面之间 | 换页 | View Transitions：旧页模糊放大淡出，新页从模糊缩小淡入 |
| 元素之间 | 列表卡片、页面分块 | 进入视口时按文档顺序错峰揭示（70ms 一档，封顶 560ms） |
| 文字之间 | 文章标题、正文段落 | 标题逐字揭示；正文每段依次浮起（40ms 一档） |

## 技术栈

- **Astro 5** —— 默认零 JavaScript，文章页只有几 KB 脚本
- **Motion** —— 只用在"必须按组错峰"的一处；其余揭示走 CSS
- **React** —— **只用于写作面板**（一个页面），读者打开的任何页面都不加载 React

### 为什么读者页面不加载 React

最初阅读量计数器是个 React 岛，结果**每个读者为了看一个数字要下载 211KB 的 React 运行时**。
现在计数器是一段原生脚本（`src/scripts/views.ts`，1KB，打进共享 chunk），
改完之后各页面的首屏 JS 实测：

| 页面 | 首屏 JS |
|---|---|
| 首页 | 16 KB |
| 文章页 | 16 KB |
| 归档 | 16 KB |
| 写作面板 `/admin` | 259 KB（React + Octokit-free GitHub 客户端，只有你自己用） |

原则是：**框架只出现在需要复杂状态的地方**。计数、揭示、转场都不需要。

## 快速开始

**需要 Node ≥ 23.6。** 这不是随便定的：`scripts/*.mts` 里的测试直接 `import` 源码的 `.ts`
文件，靠的是 Node 内置的类型剥离，而它从 23.6 起才默认开启。在 22 上裸跑会报
`Unknown file extension ".ts"`——所以 `engines`、CI 的 `node-version`、这份文档三处
必须说同一个数字，`npm run check:config` 会替你把它们对上。

```bash
npm install
npm run dev            # http://localhost:4321/blog
npm run verify         # 类型 → 单测 → 构建 → 产物断链，四步串跑
npm run predeploy      # 部署前跑这个（= verify + 配置一致性闸门）
npm test               # 只跑单测
```

`npm run verify` 依次做四件事，每一步都在拦一类"到线上才会炸"的错误：

| 步骤 | 拦什么 |
|---|---|
| `astro check` | 类型错、frontmatter 不符合 schema |
| `npm test` | 面板的 GitHub 链路（对着假 GitHub API 跑，**不需要真 token**）+ frontmatter 往返 + 预览渲染的注入防护 + 配置预检的检出能力自测 |
| `astro build` | 构建期错误 |
| `check-links` | 产物里的断链——纯静态站里写错的内部链接**构建期不报错、dev 上也常常能打开**，只有部署后才变 404 |

`npm run predeploy` 在此之上加了 `check:config`：**站点坐标三处一致性 + 占位值残留**。
它在占位值未替换时会以非零码退出，这就是那道"别把半成品推上线"的闸门。

单测是**开发过程中真的抓到过 bug** 才留下的，不是为了凑覆盖率：

- **图片文件名安全化**：原写法把 `我的 图 (1).PNG` 变成 `--1-.png`——中文被整段吃掉、
  连字符还叠在一起，作者拿到的路径完全看不出是哪张图
- **预览渲染的 `javascript:` 伪协议**：面板预览走 `dangerouslySetInnerHTML`，
  而 React 只转义文本、**不校验属性里的 URL**。正文里写 `[点我](javascript:alert(1))`，
  点一下就会执行。现在 URL 过白名单，大小写与插换行的绕过写法都覆盖了测试
- **漏带 sha 更新文件**：GitHub 会返回 409，测出来了才确认面板的更新路径是对的
- **配置检查器自己的检出能力**：自测第一次跑就暴露了两个问题——它漏了"只改 base 不改 url"
  这种自洽型失误，以及我把"改用户名"错当成必须拦截的场景（那个改动其实无害）

## 部署到 GitHub Pages（三步）

### 1. 改两个文件，填上你自己的信息

`src/consts.ts`：

```ts
export const GITHUB = {
  user: '你的用户名',     // ← 改这里
  repo: 'blog',          // ← 仓库名
  ...
}
export const SITE = {
  title: '站点标题',
  author: '你的名字',
  url: 'https://你的用户名.github.io/blog',
}
```

`astro.config.mjs`：把 `SITE` / `BASE` 改成同样的值。
**如果你把仓库命名为 `<用户名>.github.io`**（用户主页仓库），则 `BASE` 要改成 `''`，
`SITE` 改成 `https://<用户名>.github.io`。

### 2. 跑一次部署前检查

```bash
npm run predeploy     # = verify（类型/单测/构建/断链）+ 配置一致性检查
```

`check:config` 会把**分散在三处的站点坐标**放在一起比对，这是最容易犯也最难自查的错——
只改一处时本地 dev 一切正常，部署后才出现一堆 404 或 canonical 指错域名。它检查：

- 站点地址三处是否自洽（`consts.url` = `astro.config` 的 `site` + `base`）
- `base` 是否与仓库类型匹配（主页仓库要留空、项目仓库要等于 `/<repo>`）
- 工作流的触发分支是否等于配置里的分支（不一致 → push 后 Actions 根本不跑）
- 计数服务是否可达
- **占位值有没有改干净**（还是 `LHX` 就直接失败，不让你推上去）

> 这个检查器本身还有一份"检出能力自测"（`npm run selftest:config`，已并入 `npm test`）：
> 它临时把配置改成"已填好"的状态建立基线，再逐条注入真实失误——
> 漏同步域名、`base` 写空、仓库名改了没同步、分支不符——确认每一条都被拦下，
> 最后用 SHA-256 证明自测没污染仓库文件。一个只会在正确配置下输出 OK 的检查器没有价值。

### 3. 建仓库并推送

```bash
git init
git add -A
git commit -m "init: personal blog"
git branch -M main
git remote add origin https://github.com/<用户名>/<仓库名>.git
git push -u origin main
```

推送后 Actions 会自动跑：`npm ci` → 单测 → 类型与 schema 检查 → 构建 → 断链检查 → 发布。
也就是说**流水线跑的检查和你在本地跑的是同一套**，本地绿了线上不会因为"少跑了一步"而红。

### 4. 打开 Pages

仓库 → **Settings → Pages → Build and deployment → Source** 选 **GitHub Actions**。

之后每次推送都会自动构建发布（`.github/workflows/deploy.yml`）。
站点地址：`https://<用户名>.github.io/<仓库名>/`

> 为什么必须在 Pages 里选 "GitHub Actions"：Astro 的产物需要一次构建，
> Pages 自带的 "Deploy from a branch" 只会原样发布仓库文件，那会得到一个 404 的首页。

## 怎么发文章

写作面板的地址是 **`/admin`**。导航里刻意没有入口——那是只给站主用的页面，
访客没有令牌也写不了（GitHub 会返回 401），但没必要把它摆在最显眼处。
你的面板地址就是：

```
https://<用户名>.github.io/<仓库名>/admin
```

### 第一次：接一次令牌

面板首次打开会要一个 GitHub 访问令牌。这个令牌就是「你能写这个仓库」的凭证，
**除了你没人有**：

1. 打开 <https://github.com/settings/personal-access-tokens/new>
2. **Token name** 随便写（例如 `blog-admin`）；**Expiration** 按需选（建议 90 天，到期重签）
3. **Repository access** 选 **Only select repositories**，只勾你这一个博客仓库
4. **Permissions → Repository permissions → Contents** 设为 **Read and write**
   （只改这一项，别的都不用给）
5. 生成后复制，粘贴进面板输入框，点「连接」

连上之后令牌存在你这台浏览器的 `localStorage`，下次打开不用再填。

### 每次发文：五步

1. 左侧点 **新建文章**
2. 填上面的表单：
   - **标题**（必填）
   - **摘要**：一句话说清这篇讲什么。列表卡片、分享卡片、RSS 都用它——
     **别留空**，空着卡片会少一行、版面会塌
   - **日期**：默认今天
   - **标签**：逗号分隔，2–4 个最合适
   - **草稿**：默认**开着**。写完确认没问题再关掉——只有关掉并发布才会出现在线上
   - **首页置顶大卡**：勾上会占据首页整宽大图。**同时只勾一篇**，多了首页会失去节奏
   - **封面**：仓库内路径，例如 `/blog/images/cover-xxx.svg`。不填则卡片显示斜纹占位
3. 写正文（Markdown）。点 **显示预览** 可以边写边看
4. 点 **发布**（编辑已有文章时按钮是「保存」）
5. 等约一分钟——GitHub Actions 自动构建发布。想确认就去仓库的 **Actions** 页看那次运行

> 文章本质就是仓库里 `src/content/posts/` 下的一个 Markdown 文件。
> 所以「发布」= 一次提交，「撤稿」= 删掉那次提交，版本历史你天然就有。

### 在文章里插图

光标点到想插图的位置，点正文上方的 **插入图片**，选一张本地图片。面板自动做三件事：
把图片提交进仓库的 `public/images/`、生成带日期的文件名、在**光标处**插入图片语法。

插入的那行长这样：

```markdown
![原始文件名](/blog/images/2026-10-04-我的图.png)
```

文件名会被安全化（保留中英文、空格折成短横线），中文名不会变成乱码。
方括号里那段是**替代文字**——图片加载不出来时显示，读屏软件也读它。
嫌它是原始文件名难看，直接改成一句描述即可：

```markdown
![深夜的剪辑台](/blog/images/2026-10-04-我的图.png)
```

**想复用已经传过的图**：点正文下方的 **已上传图片（点击插入）** 展开，
里面是仓库里所有图片的缩略图，点任意一张就插到光标处，不用重复上传。

**其他几种写法**（同一件事，按需要选）：

| 想要的效果 | 怎么写 |
|---|---|
| 普通插图 | `![描述](/blog/images/xxx.png)` |
| 带标题（鼠标悬停显示） | `![描述](/blog/images/xxx.png "这是标题")` |
| 外链图片 | `![描述](https://example.com/a.png)` |
| 控制显示宽度 | 用 HTML：`<img src="/blog/images/xxx.png" alt="描述" width="420">` |

正文图片会自动获得「从放大 + 模糊收进清晰」的揭示效果，不需要额外加标记。

### 关于令牌，三件事必须说清楚

- 它只存在你这台浏览器的 `localStorage`，请求直连 `api.github.com`，
  **不经过本站**（本站是纯静态的，也没有后端能经过）
- 务必用 **Fine-grained token** 且只授权这一个仓库。
  不要用 classic token 的 `repo` 全权限——那等于把整个账号交出去
- 令牌在浏览器里就等于「**这台设备能写你的博客**」。公共电脑上别连；
  怀疑泄露就去 GitHub 撤销它，面板里的旧令牌立刻失效

面板还能做的事：编辑 / 删除文章、草稿开关、首页置顶、以及**每篇文章的阅读量排行**。

## 阅读量怎么来的

GitHub Pages 是纯静态托管，没有后端可以写计数。这里用
[Abacus](https://abacus.jasoncameron.dev) —— 免费、开源的计数服务，一行 API：

```
GET /hit/{namespace}/{counter}   # 自增并返回 { value }
GET /get/{namespace}/{counter}   # 只读
```

同一访客 24 小时只计一次（服务端按 IP 去重），所以数字读作"约多少个读者"而不是 PV。

`src/consts.ts` 里的 `COUNTER.namespace` 改成你自己的名字（首次调用会自动登记）。
**接口挂掉时页面显示本地缓存值，不显示 0** —— 宁可显示一个旧数字，也不要显示一个假数字。

## 目录结构

```
src/
  consts.ts              站点常量（部署前改这里）
  content.config.ts      文章 schema（title/description/pubDate/tags/cover/draft/featured）
  content/posts/*.md     文章本体
  layouts/BaseLayout.astro
  pages/
    index.astro          首页
    archive.astro        归档（按月 + 标签）
    about.astro          关于
    admin.astro          写作面板（client:only React）
    posts/[id].astro     文章页
    rss.xml.ts           订阅
  components/
    PostCard.astro       文章卡片
    Admin.tsx            写作面板（全站唯一用到 React 的地方）
  lib/
    github.ts            GitHub Contents API 客户端（可注入 API 基址，便于测试）
    post-format.ts       frontmatter 解析/序列化 + 预览渲染（纯逻辑，可单测）
    format.ts            日期 / 阅读时长
  scripts/
    motion.ts            动效引擎
    views.ts             阅读量（原生实现，1KB）
  styles/global.css      设计令牌 + 版式 + 动效基元
public/
  images/                文章图片与封面
  favicon.svg
scripts/                 开发辅助（不进构建产物）
  serve-dist.mjs         本地预览 dist/
  check-links.mjs        产物站内链接核对
  test-github-client.mts 面板 GitHub 链路测试（对着假 API 跑）
  test-post-format.mts   frontmatter 与预览渲染测试
```

## 两个踩过的坑（写在这里省得你再踩）

**1. `word-break: keep-all` 会让中文标题溢出。**
这个值常被中文排版建议推荐，但它的真实含义是"禁止 CJK 字符之间换行"——
中文句子于是不再折行，864px 的容器里能排出 1404px 的单行。保持默认的 `normal`，
需要时配 `overflow-wrap: break-word`。

**2. 入场动效的初始态不要写在默认规则里。**
`[data-reveal] { opacity: 0 }` 这种写法，只要渲染进程在过渡期间被截图或被中断
（慢设备首屏、流式加载、无头截图），元素就会**永远停在不可见**。
本项目用 CSS `@starting-style` 声明初始态，JS 只负责挂 `.is-in`——
于是最坏情况的失败模式退化成"没有动画但内容完整可见"。

## 许可

代码随便用。文章内容归作者所有。
