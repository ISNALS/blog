/**
 * 预检脚本的"检出能力"自测：模拟几种真实会犯的配置错误，确认它都会拦下来。
 *
 * 为什么值得：一个只会在正确配置下输出 OK 的检查器毫无价值。
 * 做法是——
 *   1. 先把仓库临时改成"已填好部署坐标"的状态，确认基线通过
 *   2. 在这个基线上逐条注入真实失误（漏同步、base 写错、分支不符），确认每条都被拦下
 *   3. 无论成功失败，都把文件恢复原状，并用哈希校验证明没有留下改动
 *
 * 直接拿仓库现在的占位配置跑会失败（那是**故意**的：占位坐标必须硬拦），
 * 所以第 1 步的"伪造成已填好"不是取巧，而是让自测能在一个已知良好的起点上验检出能力。
 *
 *   node scripts/selftest-config-check.mts
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// 三个文件都要进快照——少一个就会在注入时 writeFileSync(path, undefined) 直接抛错。
// （自测脚本自己踩过：原来只装了 2 个文件，注入工作流那一步崩了，
//   而前面几条因为"找不到锚点就提前 return"被误报成失败。）
const FILES = ['src/consts.ts', 'astro.config.mjs', '.github/workflows/deploy.yml', 'package.json'];
const original = new Map(FILES.map((f) => [f, readFileSync(join(ROOT, f), 'utf8')]));
const hashes = new Map(FILES.map((f) => [f, createHash('sha256').update(original.get(f)!).digest('hex')]));

/** 把占位坐标伪造成一个"已填好"的站点，用于建立基线 */
const FILLED_IN: Record<string, [string, string][]> = {
  'src/consts.ts': [
    ["user: 'LHX'", "user: 'chenchen'"],
    ["url: 'https://LHX.github.io/blog'", "url: 'https://chenchen.github.io/blog'"],
  ],
  'astro.config.mjs': [
    ["export const SITE = 'https://LHX.github.io'", "export const SITE = 'https://chenchen.github.io'"],
  ],
};

const write = (file: string, text: string) => writeFileSync(join(ROOT, file), text, 'utf8');

const applyFilledIn = () => {
  for (const [file, pairs] of Object.entries(FILLED_IN)) {
    let text = original.get(file)!;
    for (const [from, to] of pairs) {
      if (!text.includes(from)) throw new Error(`自测脚本需要更新：${file} 里找不到锚点 "${from}"`);
      text = text.replace(from, to);
    }
    write(file, text);
  }
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
  console.log('\n[0] 基线：把占位坐标填成实际值后，预检应当通过');
  applyFilledIn();
  {
    const { code, out } = runCheck();
    ok(
      '已填好的配置下预检通过（exit 0）',
      code === 0,
      code === 0 ? '' : out.split('\n').filter((l) => l.includes('FAIL')).map((l) => l.trim()).join(' / '),
    );
  }

  console.log('\n[1] 在当前基线上注入真实会犯的失误，每一条都必须被拦下');
  const inject = (name: string, file: string, from: string, to: string, expectIn: RegExp) => {
    const base = readFileSync(join(ROOT, file), 'utf8');
    if (!base.includes(from)) {
      ok(`${name}（自测锚点存在）`, false, `在 ${file} 里找不到 "${from}"`);
      return;
    }
    write(file, base.replace(from, to));
    const { code, out } = runCheck();
    // 恢复成"已填好"的基线，供下一条继续注入
    applyFilledIn();
    ok(name, code !== 0 && expectIn.test(out), `exit=${code}，期望匹配 ${expectIn}`);
  };

  // 注意选场景要准：改 `user` 只影响面板提交目标与页脚链接，
  // **不影响站点 URL**，所以预检不拦它是对的（第一版自测在这里设计错了场景，
  // 把一个本来无害的改动当成必须拦截的失误）。真正该拦的是"站点地址不同步"。
  inject(
    '把站点地址改成自定义域名，但只改了 consts 没同步 astro.config',
    'src/consts.ts',
    "url: 'https://chenchen.github.io/blog'",
    "url: 'https://blog.example.com/blog'",
    /url = astro 的 site \+ base/,
  );

  inject(
    '把项目仓库名改了，但没同步 base',
    'src/consts.ts',
    "repo: 'blog'",
    "repo: 'my-blog'",
    /base 与仓库类型匹配|url 的路径前缀与仓库名推出的 base 一致/,
  );

  inject(
    '项目仓库却把 base 留空（部署后所有资源 404）',
    'astro.config.mjs',
    "export const BASE = '/blog'",
    "export const BASE = ''",
    /url = astro 的 site \+ base|url 的路径前缀与仓库名推出的 base 一致/,
  );

  inject(
    '把 base 改成与仓库名不符的值',
    'astro.config.mjs',
    "export const BASE = '/blog'",
    "export const BASE = '/my-site'",
    /base 与仓库类型匹配|url 的路径前缀与仓库名推出的 base 一致/,
  );

  inject(
    '两处站点域名不一致',
    'astro.config.mjs',
    "export const SITE = 'https://chenchen.github.io'",
    "export const SITE = 'https://wrong.example.com'",
    /url = astro 的 site \+ base|url 的路径前缀/,
  );

  inject(
    '工作流触发分支与配置不一致（push 后 Actions 不触发）',
    '.github/workflows/deploy.yml',
    'branches: [main]',
    'branches: [master]',
    /trigger 分支与 consts 的 branch 一致/,
  );

  // "只在 CI 挂"的经典来源：engines 声明 Node 22，而 *.mts 测试依赖 24 才默认开启的类型剥离。
  // 本地是 24 所以全绿，推上去 CI 立刻报 Unknown file extension .ts。
  inject(
    'engines 声明了低于 CI 要求的 Node 版本',
    'package.json',
    '"node": ">=23.6"',
    '"node": ">=22.0"',
    /engines 与 workflow 声明同一个版本|声明版本不低于/,
  );

  console.log('\n[2] 占位坐标必须被硬拦（不是警告）');
  restore();
  {
    const { code, out } = runCheck();
    ok('仓库当前是占位配置 → 预检失败', code !== 0, `exit=${code}`);
    ok('失败项指名了占位字段', /不是占位值/.test(out), '');
  }
} finally {
  // 无论上面怎么炸，都要把仓库恢复原状
  restore();
}

console.log('\n[3] 恢复检查：配置文件必须与开始时逐字节一致');
for (const [file, text] of original) {
  const now = createHash('sha256').update(readFileSync(join(ROOT, file), 'utf8')).digest('hex');
  const same = now === hashes.get(file);
  ok(`${file} 未被自测改动`, same, same ? '' : '内容已变——自测污染了配置！');
  void text;
}

console.log(`\n通过 ${pass} 项，失败 ${fails.length} 项`);
if (fails.length > 0) {
  console.log('失败项：\n  - ' + fails.join('\n  - '));
  process.exit(1);
}
console.log('预检脚本具备检出能力，且自测未污染配置');
