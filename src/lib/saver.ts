/**
 * 串行保存器：把「读 sha → 写 → 409 恢复 → 刷新 sha」这套动作收在一个队列里。
 *
 * ## 为什么需要它（真实故障）
 * 写作面板里每个输入框的 onBlur 都会提交一次，所以"改标题→改年份→改短评"是
 * **连续多次写入**。最初每处各自调用 API、各自拿着闭包里的旧 sha，于是：
 *   · 第二个开始必然 409（错误信息形如 `is at 475a2e3 but expected 127269a`
 *     ——两个 sha 刚好差一个版本，这就是并发的指纹）
 *   · "409 就重取 sha 再试一次"也救不了：两次并发请求会同时重试、再次撞车
 * 抽成这个模块之后，"同一时刻只有一个在途写入""每次写入都用最新 sha"
 * 这两条不再是散落在组件里的约定，而是**代码结构本身**保证的，也就能被测试。
 *
 * ## 用法
 * ```ts
 * const saver = createSaver({ path, token, read, write });
 * await saver.save(body, 'shelf: 改短评');   // 内部排队，可放心连续调用
 * ```
 */

export interface SaverDeps {
  /** 仓库内路径 */
  path: string;
  token: string;
  /** 读文件（用来拿当前 sha） */
  read: (path: string, token: string) => Promise<{ ok: boolean; status: number; data?: { sha?: string } }>;
  /** 写文件 */
  write: (
    path: string,
    body: string,
    message: string,
    token: string,
    sha?: string,
  ) => Promise<{ ok: boolean; status: number; error?: string }>;
  /** 每次写入完成后的回调（成功/失败都调），供 UI 显示状态 */
  onChange?: (state: { saving: boolean; label?: string; error?: string }) => void;
}

export interface Saver {
  /** 排队写入。返回的 Promise 在**这一次**写完后 resolve */
  save: (body: string, message: string) => Promise<{ ok: boolean; error?: string }>;
  /** 用刚读到的 sha 初始化（组件加载后调用一次） */
  setSha: (sha: string | undefined) => void;
  /** 当前内部的 sha（测试用） */
  currentSha: () => string | undefined;
}

export function createSaver(deps: SaverDeps): Saver {
  let sha: string | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  /** 刷新内部 sha：写成功后必须调用，否则下一次写入会用过期值 */
  const refreshSha = async () => {
    const r = await deps.read(deps.path, deps.token);
    if (r.ok && r.data?.sha) sha = r.data.sha;
    return sha;
  };

  const runOne = async (body: string, message: string) => {
    deps.onChange?.({ saving: true, label: message });

    let r = await deps.write(deps.path, body, message, deps.token, sha);

    // 409＝手里的 sha 过期。取当前的重写一次（此时队列保证没有别人在写，
    // 所以这一次重试是决定性的，不会像并发时那样再次撞车）
    if (!r.ok && r.status === 409) {
      await refreshSha();
      r = await deps.write(deps.path, body, message, deps.token, sha);
    }

    if (r.ok) await refreshSha();

    deps.onChange?.({ saving: false, error: r.ok ? undefined : r.error });
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  };

  return {
    save(body, message) {
      // 关键：串行。后一次写入必须等前一次完成，否则两者会抢同一个 sha。
      const next = queue.then(
        () => runOne(body, message),
        () => runOne(body, message),
      );
      // 链上吞掉异常，避免一次失败把后续保存全部卡死
      queue = next.catch(() => undefined);
      return next;
    },
    setSha(v) {
      sha = v;
    },
    currentSha: () => sha,
  };
}
