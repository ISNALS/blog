/**
 * 阅读量：原生实现（不用 React）。
 *
 * 为什么值得单独写：文章页是全站最常被打开的页面。把计数器做成 React 岛，
 * 会让每个读者为了"一个数字"下载整个 React 运行时（实测构建产物里 211KB）。
 * 计数器只需要一次 fetch + 一次写文本——用普通元素 + 数据属性做是 1KB 级的事，
 * 换来的是**文章页完全不依赖任何前端框架**。
 *
 * 用法（HTML 里写）：
 *   <span data-views data-slug="文章id" data-count-read>····</span>
 *   data-count-read 表示这次访问要自增（文章页用）；省略则只读（列表页用）。
 *   端点与 namespace 从 data-* 读（由布局统一注入），便于换服务商时只改 consts。
 */

const cacheKey = (ns: string, slug: string) => `views:${ns}:${slug}`;

const readCache = (ns: string, slug: string): number | null => {
  try {
    const v = localStorage.getItem(cacheKey(ns, slug));
    return v === null ? null : Number(v);
  } catch {
    return null;
  }
};

const writeCache = (ns: string, slug: string, n: number) => {
  try {
    localStorage.setItem(cacheKey(ns, slug), String(n));
  } catch {
    /* 隐私模式写不了，忽略 */
  }
};

interface ViewsConfig {
  endpoint: string;
  namespace: string;
}

/** 扫描并填上所有 [data-views]；幂等，可在换页后重复调用 */
export function hydrateViews(root: ParentNode = document, cfg?: ViewsConfig) {
  const nodes = Array.from(root.querySelectorAll<HTMLElement>('[data-views]'));
  if (nodes.length === 0) return;

  for (const el of nodes) {
    if (el.dataset.viewsBound === '1') continue;
    el.dataset.viewsBound = '1';

    const slug = el.dataset.slug;
    const endpoint = cfg?.endpoint ?? el.dataset.endpoint;
    const ns = cfg?.namespace ?? el.dataset.namespace;
    if (!slug || !endpoint || !ns) continue;

    // 先把本地缓存放上去：接口慢或挂掉时也有数字，不会闪一个 0 或空着
    const cached = readCache(ns, slug);
    if (cached !== null) render(el, cached, false);

    const action = el.hasAttribute('data-count-read') ? 'hit' : 'get';
    fetch(`${endpoint}/${action}/${encodeURIComponent(ns)}/${encodeURIComponent(slug)}`, {
      headers: { accept: 'application/json' },
    })
      .then((r) => (r.ok ? (r.json() as Promise<{ value?: number }>) : null))
      .then((j) => {
        if (!j || typeof j.value !== 'number') return;
        render(el, j.value, cached !== j.value);
        writeCache(ns, slug, j.value);
      })
      .catch(() => {
        /* 静默失败：保留缓存值 */
      });
  }
}

function render(el: HTMLElement, value: number, fresh: boolean) {
  el.textContent = value.toLocaleString('zh-CN');
  if (!fresh) return;
  el.dataset.fresh = 'true';
  setTimeout(() => {
    el.dataset.fresh = 'false';
  }, 700);
}
