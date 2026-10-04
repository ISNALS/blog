/**
 * findChrome 的单测。
 *
 * 为什么值得写：这段逻辑之前的写法（`[env.CHROME_PATH, …].filter(Boolean).find(existsSync)`）
 * 有个隐蔽的漏洞——`filter(Boolean)` **不会剔除"设了值但文件不存在"的环境变量**，
 * 所以 CHROME_PATH 指向坏路径时仍然被当成可用浏览器，跳过逻辑等于没有。
 * 我当时是用 `set CHROME_PATH=C:\nonexistent\...` 去模拟 CI 验证的，
 * 结果那次验证给出了假的安全感（测试照样跑、照样通过）。
 * 所以现在直接对纯函数断言，不依赖真实文件系统。
 *
 *   node scripts/test-find-chrome.mjs
 */
import { findChrome, chromeCandidates } from './lib/find-chrome.mjs';

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) {
    pass += 1;
    console.log(`  OK   ${name}`);
  } else {
    fails.push(name);
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
};

// 假的存在性判定：只有列在 existing 里的路径算存在
const fs = (existing) => (p) => existing.includes(p);

console.log('\n[1] 候选列表');
ok(
  'Windows 候选含 Chrome 与 Edge',
  chromeCandidates({}, 'win32').some((p) => p.includes('Chrome')) &&
    chromeCandidates({}, 'win32').some((p) => p.includes('Edge')),
);
ok(
  'Linux 候选都是 /usr 或 /snap 下的绝对路径',
  chromeCandidates({}, 'linux').every((p) => p.startsWith('/')),
  chromeCandidates({}, 'linux').join(', '),
);
ok('Windows 候选不带 Linux 路径', chromeCandidates({}, 'win32').every((p) => !p.startsWith('/')));
ok(
  'CHROME_PATH 优先排在第一位',
  chromeCandidates({ CHROME_PATH: '/custom/chrome' }, 'linux')[0] === '/custom/chrome',
);

console.log('\n[2] 探测结果');
ok(
  '按顺序返回第一个存在的路径',
  findChrome(fs(['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe']), {}, 'win32') ===
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
);
ok('一个都不存在时返回 null', findChrome(fs([]), {}, 'win32') === null);
ok('Linux 上一个都不存在时返回 null（模拟 CI）', findChrome(fs([]), {}, 'linux') === null);

console.log('\n[3] 关键回归：CHROME_PATH 指向不存在的文件');
ok(
  'CHROME_PATH 无效时**不能**当可用（旧写法在这里是错的）',
  findChrome(fs(['/usr/bin/google-chrome']), { CHROME_PATH: '/nope/chrome' }, 'linux') ===
    '/usr/bin/google-chrome',
  String(findChrome(fs(['/usr/bin/google-chrome']), { CHROME_PATH: '/nope/chrome' }, 'linux')),
);
ok(
  'CHROME_PATH 无效且无其它候选时返回 null',
  findChrome(fs([]), { CHROME_PATH: 'C:\\nonexistent\\chrome.exe' }, 'win32') === null,
  String(findChrome(fs([]), { CHROME_PATH: 'C:\\nonexistent\\chrome.exe' }, 'win32')),
);
ok(
  'CHROME_PATH 有效时优先采用它',
  findChrome(fs(['/custom/chrome', '/usr/bin/google-chrome']), { CHROME_PATH: '/custom/chrome' }, 'linux') ===
    '/custom/chrome',
);

console.log(`\n通过 ${pass} 项，失败 ${fails.length} 项`);
if (fails.length > 0) {
  console.log('失败项：\n  - ' + fails.join('\n  - '));
  process.exit(1);
}
console.log('Chrome 探测逻辑符合预期');
