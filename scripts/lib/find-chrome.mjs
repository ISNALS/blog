/**
 * 找可用的 Chrome/Chromium 可执行文件。
 *
 * 抽成独立模块是为了**能被测试**：这段逻辑踩过一次坑——
 * 第一版写成 `[process.env.CHROME_PATH, ...].filter(Boolean).find(existsSync)`，
 * 看起来没问题，但 `filter(Boolean)` 只剔除 empty/undefined，**不会剔除"设了值但文件不存在"**
 * 的环境变量。于是当 CHROME_PATH 指向一个不存在的路径时，代码仍然认为浏览器可用，
 * 只是没去校验它——跳过逻辑形同虚设。（那次"模拟 CI"的验证因此给出了假的安全感。）
 * 现在改成：候选列表 → **逐个 existsSync** → 没有就明确返回 null。
 */

/** 与平台无关的候选路径；用 process.platform 选一组，避免把 Windows 路径带到 Linux 上 */
export function chromeCandidates(env = process.env, platform = process.platform) {
  const list = [];
  if (env.CHROME_PATH) list.push(env.CHROME_PATH);
  if (platform === 'win32') {
    list.push(
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    );
  } else {
    list.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
    );
  }
  return list;
}

/** 返回第一个**真实存在**的可执行文件路径，都没有则返回 null */
export function findChrome(exists, env = process.env, platform = process.platform) {
  return chromeCandidates(env, platform).find((p) => exists(p)) ?? null;
}
