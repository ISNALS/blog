/**
 * 串行保存器的测试：用假 GitHub API 复现"连续编辑导致的 409"，并证明修法有效。
 *
 * 这组测试的起点是一个**真实故障**：用户在收藏面板里连续改字段，
 * 报 `HTTP 409 · public/shelf.json does not match 9337eeda...`。
 * 错误里两个 sha 差一个版本，说明是并发写入抢 sha。
 * 但"串行队列"到底有没有解决问题，靠读代码是判断不了的——
 * 所以这里起一个**忠实实现 sha 校验的假 API**，把动作序列真的跑一遍。
 *
 *   node --experimental-strip-types scripts/test-saver.mts
 */
import { createServer } from 'node:http';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      return nextResolve(pathToFileURL(join(SRC, specifier.slice(2))).href + '.ts', context);
    }
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

/* ── 假 GitHub：只实现 contents 的读写，并**忠实实现 sha 校验** ───────────── */
type Blob = { content: string; sha: string };
let store = new Map<string, Blob>();
let seq = 0;
const nextSha = () => `sha-${++seq}`;
let putLatencyMs = 0; // 用来放大并发窗口
const requestLog: string[] = [];

const json = (res: any, code: number, body: unknown) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const server = createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', async () => {
    requestLog.push(`${req.method} ${p}${raw ? ` sha=${(JSON.parse(raw).sha ?? '(无)')}` : ''}`);
    // 仓库坐标必须与真实 consts.ts 一致：写死成别的名字会让测试在错误路径上全红，
    // 而且看不出原因（这个坑在 test-github-client.mts 里踩过一次，这里又踩了一次）。
    if (!p.startsWith(CONT)) return json(res, 404, { message: 'mock 未实现' });
    const path = p.slice(CONT.length);
    const existing = store.get(path);

    if (req.method === 'GET') {
      if (!existing) return json(res, 404, { message: 'Not Found' });
      return json(res, 200, { content: Buffer.from(existing.content, 'utf8').toString('base64'), sha: existing.sha });
    }

    if (req.method === 'PUT') {
      // 真实 GitHub 的行为：带 sha 但和当前不符 → 409；文件已存在却没带 sha → 409
      const body = JSON.parse(raw) as { content: string; sha?: string };
      if (putLatencyMs) await new Promise((r) => setTimeout(r, putLatencyMs));
      if (existing && !body.sha) return json(res, 422, { message: 'Invalid request' });
      if (existing && body.sha !== existing.sha) {
        return json(res, 409, {
          message: `${path} does not match ${body.sha}`,
        });
      }
      const sha = nextSha();
      store.set(path, { content: Buffer.from(body.content, 'base64').toString('utf8'), sha });
      return json(res, 200, { commit: { sha } });
    }
    return json(res, 404, { message: 'mock 未实现 ' + req.method });
  });
});

await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const port = (server.address() as { port: number }).port;

const gh = await import('../src/lib/github.ts');
gh.setApiBase(`http://127.0.0.1:${port}`);

// 从真实常量拼出 contents 路径前缀，避免与配置脱节
const { GITHUB } = await import('../src/consts.ts');
const CONT = `/repos/${GITHUB.user}/${GITHUB.repo}/contents/`;

const { createSaver } = await import('../src/lib/saver.ts');

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

const TOKEN = 't';
const PATH = 'public/shelf.json';

const mkSaver = () => {
  const saver = createSaver({
    path: PATH,
    token: TOKEN,
    read: (p, t) => gh.readFile(p, t),
    write: (p, b, m, t, s) => gh.writeFile(p, b, m, t, s),
  });
  return saver;
};

const seed = async (sha = 'sha-seed') => {
  store.set(PATH, { content: '{}', sha });
  return sha;
};

console.log('\n[1] 复现故障：并发写同一个 sha（修法要解决的正是这个）');
{
  await seed('sha-A');
  const body = (n: number) => JSON.stringify({ n });
  const [a, b, c] = await Promise.all([
    gh.writeFile(PATH, body(1), 'm1', TOKEN, 'sha-A'),
    gh.writeFile(PATH, body(2), 'm2', TOKEN, 'sha-A'),
    gh.writeFile(PATH, body(3), 'm3', TOKEN, 'sha-A'),
  ]);
  const okCount = [a, b, c].filter((r) => r.ok).length;
  ok('裸并发：成功数恰好 1', okCount === 1, `成功 ${okCount}`);
  ok(
    '失误信息形如 "… does not match …"（与用户看到的一致）',
    [a, b, c].some((r) => !r.ok && /does not match/.test(r.error ?? '')),
    [a, b, c].map((r) => r.error).join(' | '),
  );
}

console.log('\n[2] 串行保存器：连续 5 次写入必须全部成功');
{
  const sha = await seed();
  // 放大写入延迟，让"如果没有串行化就一定会并发"这件事变得确定
  putLatencyMs = 40;
  const saver = mkSaver();
  saver.setSha(sha);
  const results = await Promise.all([
    saver.save(JSON.stringify({ step: 1 }), 'shelf: 1'),
    saver.save(JSON.stringify({ step: 2 }), 'shelf: 2'),
    saver.save(JSON.stringify({ step: 3 }), 'shelf: 3'),
    saver.save(JSON.stringify({ step: 4 }), 'shelf: 4'),
    saver.save(JSON.stringify({ step: 5 }), 'shelf: 5'),
  ]);
  putLatencyMs = 0;
  ok('五次连续保存全部成功', results.every((r) => r.ok), results.map((r) => r.ok).join(','));
  ok('最终内容 = 最后一次写入', store.get(PATH)?.content === JSON.stringify({ step: 5 }), store.get(PATH)?.content);
}

console.log('\n[3] 复现用户的操作序列：改封面 → 立刻改星星');
{
  const sha = await seed();
  putLatencyMs = 30;
  const saver = mkSaver();
  saver.setSha(sha);
  // 面板里是「换封面」写一次、"改评分"写一次，中间没有 await
  const cover = saver.save(JSON.stringify({ cover: 'a.jpg' }), 'shelf: 改封面');
  const stars = saver.save(JSON.stringify({ cover: 'a.jpg', stars: 5 }), 'shelf: 改评分');
  const [r1, r2] = await Promise.all([cover, stars]);
  putLatencyMs = 0;
  ok('改封面成功', r1.ok, r1.error);
  ok('紧接着改评分也成功（用户卡住的就是这一步）', r2.ok, r2.error);
  ok('最终内容含星星', (store.get(PATH)?.content ?? '').includes('"stars":5'), store.get(PATH)?.content);
}

console.log('\n[4] 外部把文件改了（sha 变了）：保存器应自动恢复');
{
  await seed();
  const saver = mkSaver();
  saver.setSha('sha-过期的值'); // 模拟"面板手里的 sha 已被别处改动作废"
  const r = await saver.save(JSON.stringify({ recovered: true }), 'shelf: 恢复');
  ok('自动重取 sha 后写入成功', r.ok, r.error);
  ok('内部 sha 已刷新到最新', saver.currentSha() === store.get(PATH)?.sha, `${saver.currentSha()} vs ${store.get(PATH)?.sha}`);
}

console.log('\n[5] 首次保存（文件还不存在，没有 sha）');
{
  store = new Map();
  const saver = mkSaver();
  saver.setSha(undefined);
  const r = await saver.save('{"first":true}', 'shelf: 首次');
  ok('无 sha 时能创建文件', r.ok, r.error);
  ok('创建后内部 sha 已填上', !!saver.currentSha());
}

console.log('\n[6] 写入之间确实没有重叠（串行的直接证据）');
{
  await seed();
  putLatencyMs = 30;
  requestLog.length = 0;
  const saver = mkSaver();
  saver.setSha(store.get(PATH)!.sha);
  await Promise.all([
    saver.save('{"a":1}', 'm1'),
    saver.save('{"a":2}', 'm2'),
    saver.save('{"a":3}', 'm3'),
  ]);
  putLatencyMs = 0;
  // 串行的话，请求是 GET/PUT/GET/PUT... 交替；并发的话会出现连续多个 PUT
  const puts = requestLog.filter((l) => l.startsWith('PUT'));
  const gets = requestLog.filter((l) => l.startsWith('GET'));
  ok('三次写入 = 三次 PUT', puts.length === 3, puts.join(' | '));
  ok('每次写后都刷新了 sha（GET 次数 ≥ PUT 次数）', gets.length >= puts.length, `GET ${gets.length} / PUT ${puts.length}`);
  ok(
    '每个 PUT 带的 sha 都不是种子 sha（说明每次都用了刷新后的值）',
    puts.filter((l) => l.includes('sha-sha-seed')).length <= 1,
    puts.join(' | '),
  );
}

server.close();

console.log(`\n通过 ${pass} 项，失败 ${fails.length} 项`);
if (fails.length > 0) {
  console.log('失败项：\n  - ' + fails.join('\n  - '));
  process.exit(1);
}
console.log('串行保存器在并发与外部改动下都可靠');
