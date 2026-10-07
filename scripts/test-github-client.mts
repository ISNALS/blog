/**
 * 写作面板的 GitHub 链路测试（不需要真 token、不碰真仓库）。
 *
 * 为什么值得写：面板的每一处读写都只靠 HTTP 契约成立，而里面藏着几个
 * 一错就"看着像成功、实际内容坏了"的点——
 *   · 中文正文必须先 UTF-8 再 base64（直接 btoa 会抛或写出乱码）
 *   · 更新文件必须带上次的 sha（漏了就 409）
 *   · 图片上传要先探测同名文件拿 sha，否则第二次覆盖会失败
 *   · URL 路径里的中文/空格要 encodeURI
 * 这些用真仓库测很麻烦（要建私有库、要 token、还留垃圾提交），
 * 所以这里起一个**假 GitHub API**，把客户端的请求形状与解析逐条验掉。
 *
 *   node scripts/test-github-client.mts
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');

// 把 Vite 的 `@/` 别名接到真正的 src 上（只在无扩展名解析时兜底，不影响其它裸模块）
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      return nextResolve(pathToFileURL(join(SRC, specifier.slice(2))).href + '.ts', context);
    }
    // src 内部的相对 import 也不带扩展名（给打包器写的），这里补 .ts
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
      const base = new URL(specifier, context.parentURL);
      for (const ext of ['.ts', '.tsx']) {
        try {
          return nextResolve(base.href + ext, context);
        } catch {
          /* 试下一个 */
        }
      }
    }
    return nextResolve(specifier, context);
  },
});

/* ── 假 GitHub：只实现客户端用到的那几个端点 ─────────────────────────────── */
type Blob = { content: string; sha: string };
const store = new Map<string, Blob>();
const commits: string[] = [];
const log: string[] = [];
let shaSeq = 0;
const nextSha = () => `sha-${++shaSeq}-${Math.random().toString(16).slice(2, 8)}`;

const TOKEN = 'github_pat_TESTTOKEN';

const json = (res: ServerResponse, code: number, body: unknown) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(s);
};

// 仓库坐标必须与真实 consts.ts 一致——写死成别的名字会让测试在错误的路径上全绿，
// 或者像第一次跑那样全红却看不出问题在哪（实测踩过：mock 用 tester/blog，常量是 LHX/blog）。
const { GITHUB } = await import('../src/consts.ts');
const REPO_PATH = `/repos/${GITHUB.user}/${GITHUB.repo}`;
const TREE_PATH = `${REPO_PATH}/git/trees/${GITHUB.branch}`;
const CONTENTS = `${REPO_PATH}/contents/`;

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const p = decodeURIComponent(url.pathname);
  const auth = req.headers.authorization ?? '';

  // 记下每个到达服务器的请求。用途之一：断言"超限图片没有发出任何请求"——
  // 预检如果只在前端说一句却照样发了请求，那是没拦住。
  log.push(`${req.method} ${p}`);

  // 所有端点都校验 token（真实 GitHub 也是如此，写错 token 会 401）
  if (auth !== `Bearer ${TOKEN}`) return json(res, 401, { message: 'Bad credentials' });

  if (p === '/user') return json(res, 200, { login: 'tester' });

  if (p === REPO_PATH && req.method === 'GET') {
    return json(res, 200, { permissions: { push: true } });
  }

  if (p === TREE_PATH && req.method === 'GET') {
    return json(res, 200, {
      tree: [
        ...store.keys(),
        'src/index.ts', // 目录外的文件，派生列表时不该出现
      ].map((path) => ({ path, type: 'blob', sha: store.get(path)?.sha ?? 'x' })),
    });
  }

  if (p.startsWith(CONTENTS)) {
    const path = p.slice(CONTENTS.length);
    const existing = store.get(path);

    if (req.method === 'GET') {
      if (!existing) return json(res, 404, { message: 'Not Found' });
      return json(res, 200, {
        content: Buffer.from(existing.content, 'utf8').toString('base64'),
        sha: existing.sha,
      });
    }

    if (req.method === 'PUT') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw) as {
          message: string;
          content: string;
          branch: string;
          sha?: string;
        };
        // 真实 GitHub 的行为：文件已存在但没带 sha → 409
        if (existing && !body.sha) {
          return json(res, 409, { message: 'sha was not supplied' });
        }
        if (existing && body.sha !== existing.sha) {
          return json(res, 409, { message: 'sha does not match' });
        }
        const decoded = Buffer.from(body.content, 'base64');
        const text = path.startsWith(`${GITHUB.imagesDir}/`)
          ? decoded.toString('binary') // 图片：按二进制存
          : decoded.toString('utf8');
        const sha = nextSha();
        store.set(path, { content: text, sha });
        const commit = `commit-${commits.length + 1}`;
        commits.push(`${commit}: ${body.message}`);
        json(res, 200, { commit: { sha: commit } });
      });
      return;
    }

    if (req.method === 'DELETE') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw) as { sha: string };
        if (!existing || existing.sha !== body.sha) {
          return json(res, 409, { message: 'sha does not match' });
        }
        store.delete(path);
        commits.push(`commit-${commits.length + 1}: delete ${path}`);
        json(res, 200, {});
      });
      return;
    }
  }

  json(res, 404, { message: `mock 未实现：${req.method} ${p}` });
});

/* ── 断言 ─────────────────────────────────────────────────────────────────── */
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

await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const port = (server.address() as { port: number }).port;

const gh = await import('../src/lib/github.ts');
gh.setApiBase(`http://127.0.0.1:${port}`);

console.log('\n[1] 令牌校验');
const bad = await gh.verifyToken('wrong');
ok('错误 token 被拒', !bad.ok && bad.status === 401, `status=${bad.status}`);
const good = await gh.verifyToken(TOKEN);
ok('正确 token 通过并识别出登录名', good.ok && good.data?.login === 'tester');
ok('识别出仓库写权限', good.data?.canWrite === true);

console.log('\n[2] 新建文章（含中文正文）');
const CJK = '标题：中文冒号与"引号"\n\n正文里还有 emoji 🎬 和 CJK 标点。';
const created = await gh.writeFile('src/content/posts/2026-10-04-test.md', CJK, 'post: test', TOKEN);
ok('新建成功', created.ok, created.error);
ok(
  '中文未乱码地落进仓库',
  store.get('src/content/posts/2026-10-04-test.md')?.content === CJK,
  JSON.stringify(store.get('src/content/posts/2026-10-04-test.md')?.content?.slice(0, 24)),
);

console.log('\n[3] 读写往返');
const read = await gh.readFile('src/content/posts/2026-10-04-test.md', TOKEN);
ok('读回内容一致', read.ok && read.data?.text === CJK);
ok('带回 sha（更新时必需）', typeof read.data?.sha === 'string' && read.data!.sha.length > 0);

console.log('\n[4] 更新：必须带 sha');
const noSha = await gh.writeFile('src/content/posts/2026-10-04-test.md', 'x', 'update', TOKEN);
ok('漏带 sha 时被 GitHub 拒绝（409）', !noSha.ok && noSha.status === 409, `status=${noSha.status}`);
const updated = await gh.writeFile('src/content/posts/2026-10-04-test.md', CJK + '\n补一句。', 'update', TOKEN, read.data!.sha);
ok('带正确 sha 时更新成功', updated.ok, updated.error);
const reread = await gh.readFile('src/content/posts/2026-10-04-test.md', TOKEN);
ok('更新后内容正确', reread.data?.text === CJK + '\n补一句。');

console.log('\n[4b] 过期 sha 的自动恢复（面板在 save 里做的那套动作）');
// 真实事故：本地做了一次 git rebase（为了合并面板发出的提交），rebase 重写提交 →
// 文件的 blob sha 变了 → 面板里再保存就 409，而当时的代码只能把错误甩给用户、
// 让他自己刷新页面。面板现在的做法是：遇 409 → 重新读文件拿新 sha → 用新 sha 再写一次。
// 这里逐条验证那套动作成立。
{
  const p = 'src/content/posts/2026-10-04-test.md';
  const before = store.get(p)!;

  const stale = await gh.writeFile(p, '正文 v2', 'try', TOKEN, '一个过期 sha');
  ok('过期 sha 写入被拒（409）', !stale.ok && stale.status === 409, `status=${stale.status}`);

  const fresh = await gh.readFile(p, TOKEN);
  ok('重新读取能拿到当前 sha', fresh.ok && fresh.data?.sha === before.sha, String(fresh.data?.sha));

  const retry = await gh.writeFile(p, '正文 v2', 'try', TOKEN, fresh.data!.sha);
  ok('用新 sha 重试成功', retry.ok, retry.error);
  ok('重试后内容正确', store.get(p)?.content === '正文 v2', store.get(p)?.content);

  // 反向断言：重试时 sha 若又过期，必须**仍然失败**，不能假装成功或静默覆盖
  store.set(p, { content: '别人刚改过', sha: 'another-sha' });
  const stillStale = await gh.writeFile(p, '正文 v3', 'try', TOKEN, fresh.data!.sha);
  ok(
    '重试时 sha 又过期 → 仍失败，不静默覆盖',
    !stillStale.ok && stillStale.status === 409,
    `status=${stillStale.status}`,
  );
  ok('失败时没有改动文件', store.get(p)?.content === '别人刚改过', store.get(p)?.content);
}

console.log('\n[4c] 并发保存的 sha 竞争（面板串行队列要解决的那个真问题）');
// 真实事故：面板里每个输入框 onBlur 都会提交一次，连续改标题→年份→短评时
// 多次保存并发跑、各自拿着同一个旧 sha，第二个开始必然 409
// （用户看到的错误 "is at 475a2e3 but expected 127269a" 差的正好一个版本）。
// 这里把两种做法都跑一遍，证明"为什么会坏"与"修法为什么有效"。
{
  const p = 'src/content/posts/2026-10-04-test.md';
  store.set(p, { content: '初始', sha: 'sha-A' });

  // (1) 并发写法：都拿同一个旧 sha → 只有第一个能成功
  const [w1, w2, w3] = await Promise.all([
    gh.writeFile(p, '改1', '并发1', TOKEN, 'sha-A'),
    gh.writeFile(p, '改2', '并发2', TOKEN, 'sha-A'),
    gh.writeFile(p, '改3', '并发3', TOKEN, 'sha-A'),
  ]);
  const okCount = [w1, w2, w3].filter((r) => r.ok).length;
  ok('并发写同一个 sha：成功数恰好为 1（其余 409）', okCount === 1, `成功 ${okCount} 个`);
  ok(
    '失败的都是 409 且带 "does not match"',
    [w1, w2, w3].filter((r) => !r.ok).every((r) => r.status === 409 && /does not match/.test(r.error ?? '')),
    [w1, w2, w3].map((r) => `[${r.status}]${r.error}`).join(' | '),
  );

  // (2) 串行写法（面板现在的做法）：每次写前用最新的 sha → 全部成功
  store.set(p, { content: '初始', sha: 'sha-B' });
  let latest = 'sha-B';
  const results: boolean[] = [];
  for (const [body, msg] of [
    ['改1', '串行1'],
    ['改2', '串行2'],
    ['改3', '串行3'],
  ] as const) {
    let r = await gh.writeFile(p, body, msg, TOKEN, latest);
    // 与面板 persist 相同的恢复逻辑：409 就重取当前 sha 再写一次
    if (!r.ok && r.status === 409) {
      const fresh = await gh.readFile(p, TOKEN);
      if (fresh.ok && fresh.data?.sha) r = await gh.writeFile(p, body, msg, TOKEN, fresh.data.sha);
    }
    if (r.ok) {
      const after = await gh.readFile(p, TOKEN);
      if (after.ok && after.data?.sha) latest = after.data.sha;
    }
    results.push(r.ok);
  }
  ok('串行写 + 每轮刷新 sha：三次全部成功', results.every(Boolean), results.join(','));
  ok('最终内容是最后一次写入的值', store.get(p)?.content === '改3', store.get(p)?.content);
}

console.log('\n[5] 列目录（应只返回该目录下的文件）');
const listed = await gh.listDir('src/content/posts', TOKEN);
ok('列出文章目录', listed.ok && (listed.data?.length ?? 0) === 1, `count=${listed.data?.length}`);
ok('路径外的文件被排除', !(listed.data ?? []).some((e) => e.path.includes('src/index.ts')));
ok('name 字段是相对目录的短名', listed.data?.[0]?.name === '2026-10-04-test.md', listed.data?.[0]?.name);

console.log('\n[6] 上传图片（二进制 + 首次无 sha 探测）');
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 0xff, 0xfe]);
const file = new File([png], '我的 图 (1).PNG', { type: 'image/png' });
const up1 = await gh.uploadImage(file, TOKEN, undefined, '/blog');
ok('首次上传成功', up1.ok, up1.error);
ok(
  '文件名安全化：保留中文、折叠多余短横线、去掉首尾横线、扩展名小写',
  up1.data?.path.endsWith('-我的-图-1.png'),
  up1.data?.path,
);
ok('返回的 URL 带 base 前缀', (up1.data?.url ?? '').startsWith('/blog/images/'), up1.data?.url);
ok('URL 里不出现未编码的空格或括号', !/[ ()]/.test(up1.data?.url ?? ''), up1.data?.url);
const stored = store.get(up1.data!.path)?.content ?? '';
ok('图片按二进制存储（非 UTF-8 改写）', stored.length === png.length && stored.charCodeAt(0) === 0x89);

const up2 = await gh.uploadImage(file, TOKEN, undefined, '/blog');
ok('同名二次上传成功（先探测 sha 再覆盖）', up2.ok, up2.error);

console.log('\n[6b] 体积预检：超限必须在**发请求之前**就拦下');
// 这是真踩过的坑：用户传了一张 2.27MB 的图，GitHub Contents API 上限 1MB，
// 返回 422 而且**没有 message**（只有一句 documentation_url），于是面板只显示
// "上传失败"，看不出是体积问题。现在本地先拦，并说清该怎么办。
const before = log.length;
const big = new Uint8Array(2 * 1024 * 1024); // 2MB
const bigFile = new File([big], 'big.png', { type: 'image/png' });
const upBig = await gh.uploadImage(bigFile, TOKEN, undefined, '/blog');
ok('2MB 图片被拒绝', !upBig.ok, `ok=${upBig.ok}`);
ok('状态码标记为 413（语义上就是"太大"）', upBig.status === 413, `status=${upBig.status}`);
ok('错误信息说清上限', /1 MB|950 KB/.test(upBig.error ?? ''), upBig.error);
ok('错误信息给出可行做法', /压|Squoosh|TinyPNG|1600/.test(upBig.error ?? ''), upBig.error);
ok('没有为超限文件发出任何请求', log.length === before, `新增 ${log.length - before} 条请求`);

// 边界：刚好在限内要放行（不能把正常图片也拦掉）
const nearLimit = new Uint8Array(900 * 1024);
const okFile = new File([nearLimit], 'near.png', { type: 'image/png' });
const upNear = await gh.uploadImage(okFile, TOKEN, undefined, '/blog');
ok('900KB 图片正常放行（不误伤）', upNear.ok, upNear.error);

console.log('\n[7] 删除');
// 注意：必须用**当前**的 sha。前面 [4b] 又改过这个文件，早先拿到的 sha 已经失效——
// 我第一版就是直接用旧的 reread.sha，结果"删除成功"这条断言红了（409）。
// 这恰好说明服务端的 sha 校验是有效的，不是我该绕过去的东西。
const forDelete = await gh.readFile('src/content/posts/2026-10-04-test.md', TOKEN);
const del = await gh.deleteFile('src/content/posts/2026-10-04-test.md', forDelete.data!.sha, 'delete', TOKEN);
ok('删除成功', del.ok, del.error);
ok('删除后读不到了', (await gh.readFile('src/content/posts/2026-10-04-test.md', TOKEN)).status === 404);
const delAgain = await gh.deleteFile('src/content/posts/2026-10-04-test.md', 'stale-sha', 'delete', TOKEN);
ok('用过期 sha 删除被拒', !delAgain.ok && delAgain.status === 409);

console.log('\n[8] 提交信息落库（用于确认 git 历史可读）');
ok('每次写入都产生了提交', commits.length >= 5, `commits=${commits.length}`);
ok('提交信息可辨识', commits.some((c) => c.includes('post: test')));

server.close();

console.log(`\n通过 ${pass} 项，失败 ${fails.length} 项`);
if (fails.length > 0) {
  console.log('失败项：\n  - ' + fails.join('\n  - '));
  process.exit(1);
}
console.log('写作面板的 GitHub 链路全部符合预期');
if (!existsSync(SRC)) process.exit(3);
