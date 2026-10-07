/**
 * 动效引擎 —— 全站唯一的动效入口。
 *
 * 设计约束（为什么这么写）：
 *  1. **一套缓动管全站**：模糊化开 → 上浮 → 放大到位 → 淡入，四个动作在任何位置
 *     出现都用同一组时值（见 global.css 的 --dur-* / --ease-*）。混用两套缓动会读作"拼盘"。
 *  2. **只做可中断的入场**：所有揭示都是"进入视口触发一次"，不逐帧跟随滚动——
 *     跟随滚动的视差在移动端和触控板上全是抖动源。
 *  3. **尊重 prefers-reduced-motion**：命中就直接给终态，不挂任何动画。
 *  4. **确定性**：错峰延迟由元素在文档中的顺序派生，不用随机数，保证同一页每次刷新一致。
 *  5. **失败模式要退化成"没有动画"而不是"内容不可见"**：初始态写在 CSS 的
 *     @starting-style 里（见 global.css 的长注释），这里的 JS 只负责挂 .is-in。
 */
import { inView } from 'motion';

/**
 * 全站唯一的缓动：out-expo 族，CSS 里的 --ease-out 与它是同一条曲线。
 * 这里导出是给动效工作台/演示页复用的；揭示本身走 CSS 过渡，不再从 JS 传缓动。
 */
export const EASE_OUT = [0.16, 1, 0.3, 1] as const;

const REDUCED = () =>
  typeof window !== 'undefined' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** 把元素置为"已揭示"终态（并清掉内联的动效变量，避免残留） */
const settle = (el: HTMLElement) => {
  el.classList.add('is-in');
  el.style.removeProperty('--blur');
  el.style.removeProperty('--rise');
  el.style.removeProperty('--scale');
  el.style.removeProperty('--delay');
};

/**
 * 初始化整页动效。在任何页面 mount 后调用一次即可。
 * Astro 的 ClientRouter 每次换页都会重新执行，所以函数必须是幂等的。
 */
export function initMotion(root: ParentNode = document) {
  const reduced = REDUCED();

  /* ── 1. 纯 CSS 揭示：按文档顺序错峰，读起来像"一口气铺开" ─────────────── */
  const reveals = Array.from(root.querySelectorAll<HTMLElement>('[data-reveal]'));
  reveals.forEach((el, i) => {
    // 已显式给 delay 的元素不参与自动错峰（比如封面图要与标题同拍）
    if (!el.style.getPropertyValue('--delay') && !el.hasAttribute('data-delay-fixed')) {
      el.style.setProperty('--delay', `${Math.min(i * 70, 560)}ms`);
    }
    if (reduced) return settle(el);
    inView(
      el,
      () => {
        el.classList.add('is-in');
      },
      { margin: '0px 0px -12% 0px' },
    );
  });

  /* ── 2. 图片揭示：从放大+模糊收进清晰 ─────────────────────────────────── */
  root.querySelectorAll<HTMLElement>('[data-img-reveal]').forEach((el) => {
    if (reduced) return settle(el);
    inView(
      el,
      () => {
        el.classList.add('is-in');
      },
      { margin: '0px 0px -22% 0px' },
    );
  });

  /* ── 3. 逐词揭示：标题与导语按词/字错峰（文章内的文字过渡） ───────────── */
  root.querySelectorAll<HTMLElement>('[data-split]').forEach((el) => {
    if (!el.dataset.splitDone) {
      splitText(el);
      el.dataset.splitDone = '1';
    }
    if (reduced) return settle(el);
    inView(
      el,
      () => {
        el.classList.add('is-in');
      },
      { margin: '0px 0px -10% 0px' },
    );
  });

  /* ── 4. 强调词下划线：滚动到位才画出来 ─────────────────────────────────── */
  root.querySelectorAll<HTMLElement>('.hl').forEach((el) => {
    if (reduced) return el.classList.add('is-in');
    inView(el, () => el.classList.add('is-in'), { margin: '0px 0px -18% 0px' });
  });

  /* ── 4b. 板块分隔线：滚到这里才画出来（从中心向两边展开）────────────────
     页面上原来只有"元素淡入"一种入场，而板块本身没有动作 ——
     内容一少（比如现在只有三篇文章），整页在首屏就全部动完了，
     滚动时就是一片静止。加这条线的意义不在于多一个效果，
     而在于给"你刚刚进入了下一个板块"这件事一个明确的读数。
     触发点比元素淡入稍早（-12%），这样线先画、内容再浮起，读起来像一次呼吸。 */
  root.querySelectorAll<HTMLElement>('[data-rule]').forEach((el) => {
    if (reduced) return el.classList.add('is-in');
    inView(el, () => el.classList.add('is-in'), { margin: '0px 0px -12% 0px' });
  });

  /* ── 5. 首屏刊头：一次"呼吸式放大"。这一处用自带终态的 keyframes（见 global.css），
     所以触发器一挂上就必然落到清晰帧，不存在被打断后停在模糊态的可能。 ── */
  root.querySelectorAll<HTMLElement>('[data-hero-title]').forEach((hero) => {
    hero.classList.add('is-in');
  });

  /* ── 6. 文章页阅读进度条 ──────────────────────────────────────────────── */
  const bar = root.querySelector<HTMLElement>('.progress');
  if (bar && !bar.dataset.bound) {
    bar.dataset.bound = '1';
    const onScroll = () => {
      const h = document.documentElement;
      const max = h.scrollHeight - h.clientHeight;
      bar.style.width = `${max > 0 ? Math.min(100, (h.scrollTop / max) * 100) : 0}%`;
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  /* ── 7. 列表卡片的"成组入场"：同一栅格里的卡片一起动，不各动各的 ───────
     初始态在 CSS 的 @starting-style 里；这里只负责按组内序号写 --delay，
     让错峰"按栅格顺序"而不是"按全页元素顺序"发生。 */
  root.querySelectorAll<HTMLElement>('[data-group]').forEach((group) => {
    if (group.dataset.groupDone) return;
    group.dataset.groupDone = '1';
    const kids = Array.from(group.children) as HTMLElement[];
    kids.forEach((k, i) => k.style.setProperty('--delay', `${Math.min(i * 75, 520)}ms`));
    inView(
      group,
      () => {
        kids.forEach((k) => k.classList.add('is-in'));
      },
      { margin: '0px 0px -15% 0px' },
    );
    if (reduced) kids.forEach((k) => k.classList.add('is-in'));
  });
}

/**
 * 按"词"切分文本并包一层 <span class="w">，用于错峰揭示。
 *
 * 中日韩没有空格分词，逐字切最容易读成"噪音"；因此策略是：
 *   - 拉丁词 / 数字算一个单位（保持整词不拆）
 *   - 每个 CJK 字符算一个单位（标题短，逐字反而是它最好看的形态）
 *   - 标点跟随前一个单位，避免标点单独占一拍
 */
export function splitText(el: HTMLElement) {
  const raw = el.textContent ?? '';
  if (!raw.trim()) return;

  const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;
  const tokens: string[] = [];
  let buf = '';

  for (const ch of Array.from(raw)) {
    if (ch === ' ') {
      if (buf) tokens.push(buf);
      buf = '';
      tokens.push(' ');
      continue;
    }
    if (CJK.test(ch)) {
      if (buf) tokens.push(buf);
      buf = '';
      tokens.push(ch);
    } else {
      buf += ch;
    }
  }
  if (buf) tokens.push(buf);

  el.textContent = '';
  const frag = document.createDocumentFragment();
  tokens.forEach((tok, i) => {
    if (tok === ' ') {
      frag.appendChild(document.createTextNode(' '));
      return;
    }
    const span = document.createElement('span');
    span.className = 'w';
    span.style.setProperty('--i', String(i));
    span.textContent = tok;
    frag.appendChild(span);
  });
  el.appendChild(frag);
}

/** 供文章页调用：把正文的直接子元素逐个挂上揭示（段落之间的过渡） */
export function hydrateArticle(root: ParentNode = document) {
  const body = root.querySelector<HTMLElement>('[data-article-body]');
  if (!body) return;
  const kids = Array.from(body.children) as HTMLElement[];
  kids.forEach((el, i) => {
    if (el.hasAttribute('data-reveal')) return;
    el.setAttribute('data-reveal', '');
    // 段落之间错峰更小：读的时候是"一段接一段浮起来"，不是逐块弹
    el.style.setProperty('--delay', `${Math.min(i * 40, 240)}ms`);
    el.style.setProperty('--rise', '14px');
    el.style.setProperty('--blur', '10px');
  });
  initMotion(root);
}
