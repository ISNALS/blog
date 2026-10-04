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
      const msg = (data as { message?: string } | undefined)?.message ?? `HTTP ${res.status}`;
      return { ok: false, status: res.status, error: msg, data };
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

/** 上传图片：二进制走 base64，路径固定在 public/images 下 */
export async function uploadImage(
  file: File,
  token: string,
  onProgress?: (pct: number) => void,
  /** 站点 base（决定返回的图片 URL 前缀）。默认取 Vite 注入的 BASE_URL；
   *  在非 Vite 环境（测试脚本）里由调用方传入，避免依赖 import.meta.env。 */
  baseUrl?: string,
): Promise<ApiResult<{ path: string; url: string }>> {
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
