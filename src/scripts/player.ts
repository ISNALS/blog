/**
 * 悬浮音乐播放器。
 *
 * ## 关于自动播放，先把话说清楚
 * 浏览器**普遍禁止**网页在没有用户交互的情况下出声（Chrome / Safari / Firefox 都有
 * 这条策略，是自动播放拦截，不是 bug）。能自动播的只有两种情况：静音播放，
 * 或者访问者此前在这个站点有过交互、被浏览器判定为"常来"。
 *
 * 所以这里的策略是：**先试着播；播不动就安静地变成一个按钮**，
 * 而不是弹一个对话框去讨点击。用户点了按钮，音乐开始，同一会话内换页也继续放
 * （播放器用 transition:persist 挂在布局上，不会因为换页被重建）。
 *
 * ## 状态放在 sessionStorage
 * 记住"这次会话里是否正在播、放到第几首"，这样换页回来是接着放，
 * 而不是每次导航都从头开始——那会让人立刻去关掉它。
 */

export interface Track {
  title: string;
  artist?: string;
  src: string;
  cover?: string;
}

const KEY_PLAYING = 'player:playing';
const KEY_INDEX = 'player:index';
const KEY_MUTED = 'player:muted';

const read = (k: string) => {
  try {
    return sessionStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string) => {
  try {
    sessionStorage.setItem(k, v);
  } catch {
    /* 隐私模式写不了，忽略 */
  }
};

export function initPlayer(root: ParentNode = document) {
  const el = root.querySelector<HTMLElement>('[data-player]');
  if (!el || el.dataset.playerBound === '1') return;
  el.dataset.playerBound = '1';

  const audio = el.querySelector<HTMLAudioElement>('[data-player-audio]');
  const coverEl = el.querySelector<HTMLElement>('[data-player-cover]');
  const titleEl = el.querySelector<HTMLElement>('[data-player-title]');
  const artistEl = el.querySelector<HTMLElement>('[data-player-artist]');
  const toggleBtn = el.querySelector<HTMLButtonElement>('[data-player-toggle]');
  const prevBtn = el.querySelector<HTMLButtonElement>('[data-player-prev]');
  const nextBtn = el.querySelector<HTMLButtonElement>('[data-player-next]');
  const listBtn = el.querySelector<HTMLButtonElement>('[data-player-list-toggle]');
  const listEl = el.querySelector<HTMLElement>('[data-player-list]');
  const volEl = el.querySelector<HTMLInputElement>('[data-player-vol]');
  const stateEl = el.querySelector<HTMLElement>('[data-player-state]');
  if (!audio) return;

  let tracks: Track[] = [];
  try {
    tracks = JSON.parse(el.dataset.tracks ?? '[]') as Track[];
  } catch {
    tracks = [];
  }
  if (tracks.length === 0) return;

  let index = Math.min(Math.max(Number(read(KEY_INDEX) ?? 0) || 0, 0), tracks.length - 1);

  const setState = (s: string) => {
    if (stateEl) stateEl.textContent = s;
  };

  const paint = () => {
    const t = tracks[index];
    if (!t) return;
    if (titleEl) titleEl.textContent = t.title;
    if (artistEl) artistEl.textContent = t.artist ?? '';
    if (coverEl) {
      const img = coverEl.querySelector('img');
      if (t.cover && img) {
        img.src = t.cover;
        img.alt = '';
        coverEl.hidden = false;
      } else {
        coverEl.hidden = true;
      }
    }
    // 高亮当前曲目
    el.querySelectorAll<HTMLElement>('[data-player-item]').forEach((li, i) => {
      li.setAttribute('aria-current', i === index ? 'true' : 'false');
    });
  };

  const load = (play: boolean) => {
    const t = tracks[index];
    if (!t) return;
    audio.src = t.src;
    paint();
    write(KEY_INDEX, String(index));
    if (play) void audio.play().then(onPlaying).catch(onBlocked);
  };

  const onPlaying = () => {
    el.dataset.playing = 'true';
    write(KEY_PLAYING, '1');
    setState('');
    if (toggleBtn) toggleBtn.setAttribute('aria-label', '暂停');
  };

  /**
   * 播放被拦截。**不弹窗、不报错**，只把按钮变成显眼的"点击播放"提示——
   * 用户自己决定要不要听，这也是浏览器策略的本意。
   */
  const onBlocked = () => {
    el.dataset.playing = 'false';
    write(KEY_PLAYING, '0');
    setState('点一下播放');
    if (toggleBtn) toggleBtn.setAttribute('aria-label', '播放');
  };

  const toggle = () => {
    if (audio.paused) {
      void audio.play().then(onPlaying).catch(onBlocked);
    } else {
      audio.pause();
      el.dataset.playing = 'false';
      write(KEY_PLAYING, '0');
      if (toggleBtn) toggleBtn.setAttribute('aria-label', '播放');
    }
  };

  const step = (delta: number) => {
    index = (index + delta + tracks.length) % tracks.length;
    load(true);
  };

  audio.addEventListener('play', onPlaying);
  audio.addEventListener('pause', () => {
    el.dataset.playing = 'false';
  });
  audio.addEventListener('ended', () => step(1));
  audio.addEventListener('error', () => {
    setState('这首歌加载失败，试试下一首');
    el.dataset.playing = 'false';
  });

  toggleBtn?.addEventListener('click', toggle);
  prevBtn?.addEventListener('click', () => step(-1));
  nextBtn?.addEventListener('click', () => step(1));

  listBtn?.addEventListener('click', () => {
    const open = el.dataset.listOpen === 'true';
    el.dataset.listOpen = open ? 'false' : 'true';
    // 音量与曲目列表一起折叠：收起时播放器只有一条，展开才给控制项
    const extra = el.querySelector<HTMLElement>('[data-player-extra]');
    if (extra) extra.hidden = open;
    if (listEl) listEl.hidden = open;
    listBtn.setAttribute('aria-expanded', String(!open));
  });

  // 点列表里的某首
  listEl?.querySelectorAll<HTMLElement>('[data-player-item]').forEach((li, i) => {
    li.addEventListener('click', () => {
      index = i;
      load(true);
    });
  });

  if (volEl) {
    const saved = Number(read(KEY_MUTED));
    audio.volume = Number.isFinite(saved) && saved > 0 ? saved : 0.7;
    volEl.value = String(audio.volume);
    volEl.addEventListener('input', () => {
      audio.volume = Number(volEl.value);
      write(KEY_MUTED, String(audio.volume));
    });
  }

  paint();

  // 换页回来时接着放：sessionStorage 说"之前在播"，就试着恢复
  if (read(KEY_PLAYING) === '1') {
    load(true);
  } else {
    load(false);
    // 首次进入也主动试一次：能播就播，播不动就退化成按钮（不打扰用户）
    if (read(KEY_PLAYING) === null) {
      void audio.play().then(onPlaying).catch(onBlocked);
    }
  }
}
