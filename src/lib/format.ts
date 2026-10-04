/**
 * 小工具：日期、阅读时长、路径。
 * 全部是纯函数，构建期调用，不进客户端包。
 */

export const fmtDate = (d: Date | string, style: 'full' | 'short' = 'full') => {
  const date = typeof d === 'string' ? new Date(d) : d;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return style === 'short' ? `${m}.${day}` : `${y}.${m}.${day}`;
};

export const fmtMonth = (d: Date | string) => {
  const date = typeof d === 'string' ? new Date(d) : d;
  return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, '0')}`;
};

/** 中文正文按字数估读：400 字/分钟 */
export const readMinutes = (text: string) => Math.max(1, Math.round(text.replace(/\s/g, '').length / 400));

/** 拼站点内链：自动带上 base（仓库子路径部署时必需） */
export const url = (path: string, base: string) => {
  const b = base.endsWith('/') ? base.slice(0, -1) : base;
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${b}${p}`;
};

export const pad = (n: number, w = 2) => String(n).padStart(w, '0');
