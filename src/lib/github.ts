/**
 * 浏览器直连 GitHub 的极简客户端。
 *
 * 为什么不用 @octokit/rest：整包 100KB+，而这里只需要 5 个端点。
 * 直接 fetch 只有几 KB，且行为完全透明——出问题一眼能看出是哪个请求。
 *
 * 关于 token 的安全性（重要，写在最前面）：
 *  - token 只存在**你这台浏览器的 localStorage**，不会提交进仓库、不会发给任何第三方；
 *  - 请求直连 api.github.com，不经过本站（本站是静态页，没有后端能转发）；
 *  - 强烈建议创建 **Fine-grained token**，权限只给这一个仓库的 Contents: Read and write，
 *    这样即使泄露，影响面也只限于这个博客仓库。
 */
import { GITHUB } from '@/consts';

/** 默认走真实 GitHub；可覆盖成假服务器，这样"面板的读写链路"能在不碰真仓库的情况下被测。 */
let API = 'https://api.github.com';

export const setApiBase = (base: string) => {
  API = base.replace(/\/$/, '');
};
export const getApiBase = () => API;

export interface TreeEntry {
  path: string;
  name: string;
  sha: string;
  /** GitHub 的 git tree API 里文件叫 `blob`、目录叫 `tree`；这里保留原值以便直接比对 */
  type: 'blob' | 'tree';
}

export interface FileContent {
  path: string;
  sha: string;
  text: string;
}

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
}

const b64encode = (s: string) => {
  // 中文必须走 UTF-8 再 base64，否则 GitHub 收到的内容会乱码
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
};

const b64decode = (s: string) => {
  const bin = atob(s.replace(/\s/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
};

async function req<T>(
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<ApiResult<T>> {
  try {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
    });
    if (res.status === 204) return { ok: true, status: 204 };
    const text = await res.text();
    const data = text ? (JSON.parse(text) as T) : undefined;
    if (!res.ok) {
      // 把状态码与 GitHub 的说明一起带上。踩过的坑：原来只取 `message`，
      // 而 422（文件过大）这类响应里常常**没有 message**，只有一句 documentation_url，
      // 于是面板显示一个干巴巴的"上传失败"，看不出是权限、体积还是网络问题。
      const body = data as { message?: string; errors?: Array<{ message?: string }> } | undefined;
      const detail = body?.message ?? body?.errors?.[0]?.message ?? text.slice(0, 200).trim();
      return {
        ok: false,
        status: res.status,
        error: `HTTP ${res.status}${detail ? ` · ${detail}` : ''}`,
        data,
      };
    }
    return { ok: true, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : '网络错误' };
  }
}

const repoPath = () => `/repos/${GITHUB.user}/${GITHUB.repo}`;

/** 校验 token 并确认对仓库有写权限 */
export async function verifyToken(token: string): Promise<ApiResult<{ login: string; canWrite: boolean }>> {
  const user = await req<{ login: string }>('/user', token);
  if (!user.ok) return { ok: false, status: user.status, error: user.error ?? 'token 无效' };
  const repo = await req<{ permissions?: { push?: boolean } }>(repoPath(), token);
  return {
    ok: true,
    status: 200,
    data: { login: user.data!.login, canWrite: Boolean(repo.data?.permissions?.push) },
    error: repo.ok ? undefined : `读不到仓库 ${GITHUB.user}/${GITHUB.repo}：${repo.error}`,
  };
}

export async function listDir(dir: string, token: string): Promise<ApiResult<TreeEntry[]>> {
  const r = await req<{ tree: TreeEntry[] }>(
    `${repoPath()}/git/trees/${GITHUB.branch}?recursive=1`,
    token,
  );
  if (!r.ok) return { ok: false, status: r.status, error: r.error };
  const prefix = dir.endsWith('/') ? dir : `${dir}/`;
  const files = (r.data?.tree ?? [])
    .filter((e) => e.type === 'blob' && e.path.startsWith(prefix))
    .map((e) => ({ ...e, name: e.path.slice(prefix.length) }))
    .filter((e) => !e.name.includes('/'));
  return { ok: true, status: 200, data: files };
}

export async function readFile(path: string, token: string): Promise<ApiResult<FileContent>> {
  const r = await req<{ content: string; sha: string }>(
    `${repoPath()}/contents/${encodeURI(path)}?ref=${GITHUB.branch}`,
    token,
  );
  if (!r.ok) return { ok: false, status: r.status, error: r.error };
  return { ok: true, status: 200, data: { path, sha: r.data!.sha, text: b64decode(r.data!.content) } };
}

/** 新建或覆盖文件；不传 sha 即新建 */
export async function writeFile(
  path: string,
  content: string,
  message: string,
  token: string,
  sha?: string,
  isBase64 = false,
): Promise<ApiResult<{ commit: string }>> {
  const r = await req<{ commit: { sha: string } }>(`${repoPath()}/contents/${encodeURI(path)}`, token, {
    method: 'PUT',
    body: JSON.stringify({
      message,
      content: isBase64 ? content : b64encode(content),
      branch: GITHUB.branch,
      ...(sha ? { sha } : {}),
    }),
  });
  if (!r.ok) return { ok: false, status: r.status, error: r.error };
  return { ok: true, status: 200, data: { commit: r.data!.commit.sha } };
}

export async function deleteFile(
  path: string,
  sha: string,
  message: string,
  token: string,
): Promise<ApiResult<null>> {
  const r = await req<null>(`${repoPath()}/contents/${encodeURI(path)}`, token, {
    method: 'DELETE',
    body: JSON.stringify({ message, sha, branch: GITHUB.branch }),
  });
  return r.ok ? { ok: true, status: 200 } : { ok: false, status: r.status, error: r.error };
}

/** 图片文件名安全化：保留中英文与数字，其余折成单个短横线，并去掉首尾短横线。
 *
 *  这里踩过一次：最初的写法是 `.replace(/[^\w.\-]+/g, '-')`，结果是
 *  `我的 图 (1).PNG` → `--1-.png`——中文被整段吃掉、还留下连字符叠在一起，
 *  作者拿到的路径完全看不出是哪张图（测试 script/test-github-client.mts 抓到）。
 *  现在按 base/ext 分开处理，短横线用 + 折叠，并显式保留 CJK。 */
const safeImageName = (name: string) => {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot + 1) : '';
  const clean = (s: string) =>
    s
      .trim()
      .replace(/[^\w\u4e00-\u9fff\u3400-\u4dbf.\-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .toLowerCase();
  const b = clean(base) || 'image';
  const e = clean(ext) || 'png';
  return `${b}.${e}`;
};

/** GitHub Contents API 的单文件上限是 1 MB（超过要用 Git Data API 分块）。
 *  这里留一点余量：base64 会把体积放大约 1/3，所以按原始字节数卡在 950KB 更稳。 */
const SIZE_LIMIT = 950 * 1024;

/** 音频走 Git Data API，单文件上限 100 MB；这里卡在 24 MB —— 再大的文件
 *  对阅读型的个人站点来说只是负担（访客要等它下载），不如让他先压一下。 */
const AUDIO_LIMIT = 24 * 1024 * 1024;

/** 把 Uint8Array 转成紧凑的 base64（不能用 btoa 直接处理二进制） */
const bytesToBase64 = (buf: Uint8Array) => {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  }
  return btoa(bin);
};

/**
 * 用 **Git Data API** 上传二进制文件（音频用这条通道）。
 *
 * 为什么不能用 Contents API：它单文件上限 1 MB，一首 MP3 至少 3–8 MB，必然失败。
 * Git Data API 的三步是 GitHub 的官方做法：
 *   1. `POST /git/blobs`      —— 上传内容，拿到 blob sha
 *   2. `POST /git/trees`      —— 基于当前 tree 造一棵新 tree，把 blob 挂到指定路径
 *   3. `POST /git/commits`    —— 用新 tree 造一个提交（父提交 = 当前 HEAD）
 *   4. `PATCH /git/refs/heads/<branch>` —— 把分支挪到新提交
 *
 * 代价是**没有原子性**：中间任一步失败，前面已创建的 blob/tree 会变成悬空对象
 * （GitHub 会回收，不影响仓库可用性）。所以错误信息要带上"哪一步失败"。
 */
export async function uploadViaGitData(
  bytes: Uint8Array,
  repoPathInRepo: string,
  message: string,
  token: string,
): Promise<ApiResult<{ path: string; commit: string }>> {
  // 1) blob
  const blob = await req<{ sha: string }>(`${repoPath()}/git/blobs`, token, {
    method: 'POST',
    body: JSON.stringify({ content: bytesToBase64(bytes), encoding: 'base64' }),
  });
  if (!blob.ok || !blob.data?.sha) {
    return { ok: false, status: blob.status, error: `上传内容失败 · ${blob.error ?? ''}` };
  }

  // 取当前分支指向的提交，作为父提交与基准 tree
  const head = await req<{ object: { sha: string } }>(`${repoPath()}/git/ref/heads/${GITHUB.branch}`, token);
  if (!head.ok || !head.data?.object?.sha) {
    return { ok: false, status: head.status, error: `读取分支失败 · ${head.error ?? ''}` };
  }
  const parent = head.data.object.sha;

  const parentCommit = await req<{ tree: { sha: string } }>(`${repoPath()}/git/commits/${parent}`, token);
  if (!parentCommit.ok || !parentCommit.data?.tree?.sha) {
    return { ok: false, status: parentCommit.status, error: `读取父提交失败 · ${parentCommit.error ?? ''}` };
  }

  // 2) tree
  const tree = await req<{ sha: string }>(`${repoPath()}/git/trees`, token, {
    method: 'POST',
    body: JSON.stringify({
      base_tree: parentCommit.data.tree.sha,
      tree: [{ path: repoPathInRepo, mode: '100644', type: 'blob', sha: blob.data.sha }],
    }),
  });
  if (!tree.ok || !tree.data?.sha) {
    return { ok: false, status: tree.status, error: `创建 tree 失败 · ${tree.error ?? ''}` };
  }

  // 3) commit
  const commit = await req<{ sha: string }>(`${repoPath()}/git/commits`, token, {
    method: 'POST',
    body: JSON.stringify({ message, tree: tree.data.sha, parents: [parent] }),
  });
  if (!commit.ok || !commit.data?.sha) {
    return { ok: false, status: commit.status, error: `创建提交失败 · ${commit.error ?? ''}` };
  }

  // 4) 移动分支
  const ref = await req<unknown>(`${repoPath()}/git/refs/heads/${GITHUB.branch}`, token, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commit.data.sha, force: false }),
  });
  if (!ref.ok) {
    return { ok: false, status: ref.status, error: `更新分支失败 · ${ref.error ?? ''}` };
  }

  return { ok: true, status: 200, data: { path: repoPathInRepo, commit: commit.data.sha } };
}

/** 上传音频：路径固定在 public/audio 下，走 Git Data API（可传大文件）。
 *  同名文件直接覆盖为新提交 —— 音频没有"更新必须带 sha"的限制，因为
 *  每一次都是一棵新 tree、一个新提交，不存在 sha 冲突。 */
export async function uploadAudio(
  file: File,
  token: string,
  onProgress?: (pct: number) => void,
  baseUrl?: string,
): Promise<ApiResult<{ path: string; url: string }>> {
  if (file.size > AUDIO_LIMIT) {
    const mb = (file.size / 1024 / 1024).toFixed(1);
    return {
      ok: false,
      status: 413,
      error:
        `音频 ${mb} MB，超过 ${Math.round(AUDIO_LIMIT / 1024 / 1024)} MB 上限。` +
        `建议先用 128kbps 的 MP3 或 Opus 重新导出一遍（一首歌通常能压到 3–5 MB），` +
        `毕竟访客要把它下载下来才能听。`,
    };
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  onProgress?.(50);
  const safe = safeImageName(file.name);
  const path = `${GITHUB.audioDir}/${safe}`;
  const r = await uploadViaGitData(bytes, path, `audio: ${path}`, token);
  if (!r.ok) return { ok: false, status: r.status, error: r.error };
  onProgress?.(100);
  const base = (baseUrl ?? import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');
  return { ok: true, status: 200, data: { path, url: `${base}/audio/${safe}` } };
}


/** 上传图片：二进制走 base64，路径固定在 public/images 下 */
export async function uploadImage(
  file: File,
  token: string,
  onProgress?: (pct: number) => void,
  /** 站点 base（决定返回的图片 URL 前缀）。默认取 Vite 注入的 BASE_URL；
   *  在非 Vite 环境（测试脚本）里由调用方传入，避免依赖 import.meta.env。 */
  baseUrl?: string,
): Promise<ApiResult<{ path: string; url: string }>> {
  // 体积预检：超限时 GitHub 会返回 422，而且**不说原因**（只有一句 documentation_url）。
  // 与其发一个注定失败的 3MB 请求再让用户猜，不如在这里就说清楚该怎么办。
  if (file.size > SIZE_LIMIT) {
    const mb = (file.size / 1024 / 1024).toFixed(1);
    const limit = Math.round(SIZE_LIMIT / 1024);
    return {
      ok: false,
      status: 413,
      error:
        `图片 ${mb} MB，超过 GitHub 接口的 ${limit} KB 上限（Contents API 单文件上限 1 MB）。` +
        `先把图片压小再传：导出时把长边控制在 1600px 左右、或用 TinyPNG / Squoosh 压一下，` +
        `通常能压到 200–400 KB 而肉眼几乎看不出差别。`,
    };
  }

  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  }
  onProgress?.(60);

  const stamp = new Date().toISOString().slice(0, 10);
  const safe = safeImageName(file.name);
  const path = `${GITHUB.imagesDir}/${stamp}-${safe}`;
  const existing = await readFile(path, token);
  const r = await writeFile(path, btoa(bin), `image: ${path}`, token, existing.data?.sha, true);
  if (!r.ok) return { ok: false, status: r.status, error: r.error };
  onProgress?.(100);
  const base = (baseUrl ?? import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');
  return { ok: true, status: 200, data: { path, url: `${base}/images/${stamp}-${safe}` } };
}

/** 仓库里已有的图片（供"插入图片"选择） */
export async function listImages(token: string): Promise<ApiResult<TreeEntry[]>> {
  return listDir(GITHUB.imagesDir, token);
}
