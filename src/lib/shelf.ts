/**
 * 「关于我」的收藏清单：看过的番剧、听过的音乐。
 *
 * 数据存在 `public/shelf.json`，而不是内容集合（content collection）里，
 * 原因是这份数据要**同时**被两边读：
 *   · 构建期（首页渲染出列表）
 *   · 运行时（Admin 面板通过 GitHub API 直接读写这个文件）
 * 放在 public/ 下天然就有一个可访问的 URL，面板读写也不经过构建，改完刷新即见。
 *
 * 图片/音频只存**路径或外链**，文件本体在 public/images、public/audio 里。
 * 番剧封面推荐填外链（Bangumi / AniList 的图床），既省仓库体积，
 * 也不必把别人的封面图下载进自己的仓库。
 */
import rawShelf from '../../public/shelf.json';

export interface ShelfItem {
  /** 条目标题 */
  title: string;
  /** 副标题：番剧可填放送年份，音乐可填歌手 */
  sub?: string;
  /** 封面：仓库内路径（/blog/images/x.jpg）或外链 URL */
  cover?: string;
  /** 评分/推荐度（1–5），可选，用星号显示 */
  stars?: number;
  /** 一句短评 */
  note?: string;
}

export interface Track {
  /** 曲名 */
  title: string;
  /** 艺术家 */
  artist?: string;
  /** 音频地址：仓库内路径（/blog/audio/x.mp3）或外链 */
  src: string;
  /** 封面（可选） */
  cover?: string;
}

export interface Shelf {
  /** 这一段的小标题与说明，可在面板里改 */
  animeTitle: string;
  animeNote: string;
  anime: ShelfItem[];
  musicTitle: string;
  musicNote: string;
  music: Track[];
}

export const EMPTY_SHELF: Shelf = {
  animeTitle: '看过的番',
  animeNote: '',
  anime: [],
  musicTitle: '在听的歌',
  musicNote: '',
  music: [],
};

/** shelf.json 的仓库内路径（面板读写用） */
export const SHELF_PATH = 'public/shelf.json';

/** 站点上的可访问路径（构建期 fetch 用）。带 base，所以是 /blog/shelf.json */
export const shelfUrl = (base: string) => `${base.replace(/\/$/, '')}/shelf.json`;

/** 容错解析：字段缺了就补默认值，坏数据不该让整个首页挂掉 */
export function normalizeShelf(raw: unknown): Shelf {
  const o = (raw ?? {}) as Partial<Shelf>;
  const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback);
  const items = Array.isArray(o.anime) ? o.anime : [];
  const tracks = Array.isArray(o.music) ? o.music : [];
  return {
    animeTitle: str(o.animeTitle, EMPTY_SHELF.animeTitle),
    animeNote: str(o.animeNote),
    anime: items
      .filter((i): i is ShelfItem => !!i && typeof (i as ShelfItem).title === 'string')
      .map((i) => ({
        title: i.title,
        sub: str(i.sub),
        cover: str(i.cover),
        stars: typeof i.stars === 'number' ? Math.min(5, Math.max(1, Math.round(i.stars))) : undefined,
        note: str(i.note),
      })),
    musicTitle: str(o.musicTitle, EMPTY_SHELF.musicTitle),
    musicNote: str(o.musicNote),
    music: tracks
      .filter((t): t is Track => !!t && typeof (t as Track).src === 'string' && (t as Track).src !== '')
      .map((t) => ({
        title: str(t.title, '未命名'),
        artist: str(t.artist),
        src: t.src,
        cover: str(t.cover),
      })),
  };
}

/**
 * 构建期读取。
 *
 * 刻意用 `import` 而不是运行时 fetch：Astro 会在构建期把 JSON 直接打进来，
 * 于是首页的列表是**静态 HTML**——没有加载闪动、不依赖额外请求、
 * 也不会有"JS 挂了列表就空着"的问题。代价是改完清单要等一次重建（本来也要）。
 */
export const loadShelf = (): Shelf => normalizeShelf(rawShelf);
