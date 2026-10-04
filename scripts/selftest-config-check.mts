/**
 * 预检脚本的"检出能力"自测：模拟几种真实会犯的配置错误，确认它都会拦下来。
 *
 * 为什么值得：一个只会在正确配置下输出 OK 的检查器毫无价值。
 * 做法是——
 *   1. 临时把配置置换成**已知良好的一组坐标**（无论仓库当前是占位还是已填真实值，
 *      都先归一化到这个已知状态），确认基线通过
 *   2. 在这个基线上逐条注入真实失误（漏同步、base 写错、分支不符、Node 版本不符），
 *      确认每条都被拦下
 *   3. 无论成功失败，都把文件恢复原状，并用哈希校验证明没有留下改动
 *
 * **踩过的坑（务必看）**：第一版是"把 `user: 'LHX'` 换成真名"来伪造基线的，
 * 于是仓库一旦填入真实坐标，锚点就消失、脚本直接抛错——而更糟的是我当时
 * 用 `npm run verify; ...; Remove-Item` 复核，`$LASTEXITCODE` 被后面的
 * Remove-Item 覆盖成 0，导致我误报"全绿"，直到 CI 挂了才发现。
 * 所以现在**按行替换**（靠 key 定位，不靠 value 字面量），与当前取值无关。
 *
 *   node scripts/selftest-config-check.mts
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// 四个文件都要进快照——少一个就会在注入时 writeFileSync(path, undefined) 直接抛错。
const FILES = ['src/consts.ts', 'astro.config.mjs', '.github/workflows/deploy.yml', 'package.json'];
const original = new Map(FILES.map((f) => [f, readFileSync(join(ROOT, f), 'utf8')]));
const hashes = new Map(FILES.map((f) => [f, createHash('sha256').update(original.get(f)!).digest('hex')]));

const write = (file: string, text: string) => writeFileSync(join(ROOT, file), text, 'utf8');

/** 把某一行（按行内 key 定位）替换成新内容；找不到就抛错，避免静默失效 */
const setLine = (file: string, lineRe: RegExp, replacement: string) => {
  const text = readFileSync(join(ROOT, file), 'utf8');
  let hit = false;
  const out = text
    .split('\n')
    .map((line) => {
      if (lineRe.test(line)) {
        hit = true;
        const indent = /^\s*/.exec(line)![0]; // 保留原缩进
        return indent + replacement;
      }
      return line;
    })
    .join('\n');
  if (!hit) throw new Error(`自测脚本需要更新：${file} 里找不到匹配 ${lineRe} 的行`);
  write(file, out);
};

/** 归一化到"一组已知良好的坐标"——与仓库当前取值无关 */
const GOOD = {
  user: 'testuser',
  repo: 'blog',
  site: 'https://testuser.github.io',
  url: 'https://testuser.github.io/blog',
  base: '/blog',
  branch: 'main',
  engine: '>=23.6',
  wfNode: "'>=23.6'",
};

const applyGood = () => {
  setLine('src/consts.ts', /^\s*user:\s*'/, `user: '${GOOD.user}',`);
  setLine('src/consts.ts', /^\s*repo:\s*'/, `repo: '${GOOD.repo}',`);
  setLine('src/consts.ts', /^\s*url:\s*'/, `url: '${GOOD.url}',`);
  setLine('astro.config.mjs', /^\s*export const SITE\s*=/, `export const SITE = '${GOOD.site}';`);
  setLine('astro.config.mjs', /^\s*export const BASE\s*=/, `export const BASE = '${GOOD.base}';`);
  setLine('.github/workflows/deploy.yml', /^\s*branches:\s*\[/, `branches: [${GOOD.branch}]`);
  setLine('.github/workflows/deploy.yml', /^\s*node-version:/, `node-version: ${GOOD.wfNode}`);
  setLine('package.json', /"node":\s*">=/, `"node": "${GOOD.engine}"`);
};

const restore = () => {
  for (const [file, text] of original) write(file, text);
};

const runCheck = () => {
  try {
    const out = execFileSync(process.execPath, ['scripts/check-config.mjs'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: String(e.stdout ?? '') + String(e.stderr ?? '') };
  }
};

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

try {
  console.log('\n[0] 基线：把坐标归一化到一组已知良好值后，预检应当通过');
  applyGood();
  {
    const { code, out } = runCheck();
    ok(
      '已知良好的配置下预检通过（exit 0）',
      code === 0,
      code === 0
        ? ''
        : out
            .split('\n')
            .filter((l) => l.includes('FAIL'))
            .map((l) => l.trim())
            .join(' / '),
    );
  }

  console.log('\n[1] 在当前基线上注入真实会犯的失误，每一条都必须被拦下');
  const inject = (name: string, mutate: () => void, expectIn: RegExp) => {
    applyGood(); // 每轮都从干净基线开始
    mutate();
    const { code, out } = runCheck();
    ok(name, code !== 0 && expectIn.test(out), `exit=${code}，期望匹配 ${expectIn}`);
  };

  // 注意选场景要准：改 user 只影响面板提交目标与页脚链接，
  // **不影响站点 URL**，所以预检不拦它是对的。真正该拦的是"站点地址不同步"。
  inject(
    '把站点地址改成自定义域名，但只改了 consts 没同步 astro.config',
    () => setLine('src/consts.ts', /^\s*url:\s*'/, `url: 'https://blog.example.com/blog',`),
    /url = astro 的 site \+ base/,
  );

  inject(
    '把项目仓库名改了，但没同步 base',
    () => setLine('src/consts.ts', /^\s*repo:\s*'/, `repo: 'my-blog',`),
    /base 与仓库类型匹配|url 的路径前缀与仓库名推出的 base 一致/,
  );

  inject(
    '项目仓库却把 base 留空（部署后所有资源 404）',
    () => setLine('astro.config.mjs', /^\s*export const BASE\s*=/, `export const BASE = '';`),
    /url = astro 的 site \+ base|url 的路径前缀与仓库名推出的 base 一致/,
  );

  inject(
    '把 base 改成与仓库名不符的值',
    () => setLine('astro.config.mjs', /^\s*export const BASE\s*=/, `export const BASE = '/my-site';`),
    /base 与仓库类型匹配|url 的路径前缀与仓库名推出的 base 一致/,
  );

  inject(
    '两处站点域名不一致',
    () =>
      setLine('astro.config.mjs', /^\s*export const SITE\s*=/, `export const SITE = 'https://wrong.example.com';`),
    /url = astro 的 site \+ base|url 的路径前缀/,
  );

  inject(
    '工作流触发分支与配置不一致（push 后 Actions 不触发）',
    () => setLine('.github/workflows/deploy.yml', /^\s*branches:\s*\[/, `branches: [master]`),
    /trigger 分支与 consts 的 branch 一致/,
  );

  // "只在 CI 挂"的经典来源：engines 声明 Node 22，而 *.mts 测试依赖 23.6 才默认开启的类型剥离。
  inject(
    'engines 声明了低于要求的 Node 版本',
    () => setLine('package.json', /"node":\s*">=/, `"node": ">=22.0"`),
    /声明版本不低于|engines 与 workflow/,
  );

  inject(
    'CI 的 node-version 与 engines 不一致',
    () => setLine('.github/workflows/deploy.yml', /^\s*node-version:/, `node-version: '24'`),
    /engines 与 workflow 声明同一个版本/,
  );

  console.log('\n[2] 占位坐标必须被硬拦（不是警告）');
  // 明确构造"占位值残留"的状态：改回 LHX 再跑，必须失败
  applyGood();
  setLine('src/consts.ts', /^\s*user:\s*'/, `user: 'LHX',`);
  {
    const { code, out } = runCheck();
    ok('占位坐标 → 预检失败', code !== 0, `exit=${code}`);
    ok('失败项指名了占位字段', /不是占位值/.test(out), '');
  }
} finally {
  // 无论上面怎么炸，都要把仓库恢复原状
  restore();
}

console.log('\n[3] 恢复检查：配置文件必须与开始时逐字节一致');
for (const [file] of original) {
  const now = createHash('sha256').update(readFileSync(join(ROOT, file), 'utf8')).digest('hex');
  const same = now === hashes.get(file);
  ok(`${file} 未被自测改动`, same, same ? '' : '内容已变——自测污染了配置！');
}

console.log(`\n通过 ${pass} 项，失败 ${fails.length} 项`);
if (fails.length > 0) {
  console.log('失败项：\n  - ' + fails.join('\n  - '));
  process.exit(1);
}
console.log('预检脚本具备检出能力，且自测未污染配置');
