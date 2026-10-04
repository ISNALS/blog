/**
 * 导航当前项高亮：换页后重新计算。
 *
 * 为什么需要这个脚本（真踩过的坑）：
 * 头上有 `transition:persist`——这是刻意的，让换页时导航不闪、不动。
 * 但它的副作用是**头部 DOM 会被原样复用**，而 `aria-current="page"` 是
 * **构建期由服务器渲染进去的静态值**。于是从首页点进「归档」后，
 * 内容换了、下划线却还停在「首页」——因为那个 DOM 根本没被重新渲染。
 * 表现就是"点哪儿都停在首页"。
 *
 * 所以换页后必须自己重算一次。判定用 `pathname` 精确比对（去掉结尾斜杠），
 * 不用前缀匹配——否则 `/blog/` 会匹配上 `/blog/admin`。
 */

/**
 * 只作用于**主导航**（`[data-main-nav]`）。
 *
 * 为什么要显式标记而不是 `nav[aria-label]`：文章页的**目录**也是个带 aria-label
 * 的 nav。虽然目录本身不用 `aria-current`（全仓只有主导航在用），但用一个
 * 语义模糊的选择器去"猜"哪个是主导航是隐患——哪天目录加上当前章节高亮，
 * 这段脚本就会把它清掉。顺带一提：我最初的端到端测试就用 `nav[aria-label]`
 * 读高亮，结果在文章页读到的是目录、误报了一次失败。**选元素要精确。**
 */
const NAV_SELECTOR = '[data-main-nav]';

const linkPath = (a: HTMLAnchorElement) => {
  try {
    return new URL(a.href, location.origin).pathname.replace(/\/+$/, '') || '/';
  } catch {
    return '';
  }
};

export function updateNavCurrent(root: ParentNode = document) {
  const here = location.pathname.replace(/\/+$/, '') || '/';
  const nav = root.querySelector<HTMLElement>(NAV_SELECTOR);
  if (!nav) return;

  let matched = false;
  for (const a of nav.querySelectorAll<HTMLAnchorElement>('a')) {
    // 后台入口（「写」）不参与高亮：它不在主导航集合里，也不该抢当前项
    if (a.classList.contains('nav-admin')) continue;
    if (linkPath(a) === here) {
      a.setAttribute('aria-current', 'page');
      matched = true;
    } else {
      a.removeAttribute('aria-current');
    }
  }
  // 没有任何一项匹配（文章页、404）时不要留下陈旧高亮
  if (!matched) {
    for (const a of nav.querySelectorAll<HTMLAnchorElement>('a[aria-current]')) {
      a.removeAttribute('aria-current');
    }
  }
}
