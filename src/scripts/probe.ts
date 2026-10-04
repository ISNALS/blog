/**
 * 网络探针：显示本站的访问人数与访客来自哪些国家。
 *
 * ## 为什么是纯前端
 * 站点托管在 GitHub Pages，**没有服务端**，所以拿不到访客 IP（拿 IP 本来就是
 * 服务端才能做的事）。能走的路只有一条：让**浏览器自己**去问一个公共地理定位
 * 接口"我是哪儿的"，再把结果上报给计数服务。这里的取舍要讲清楚：
 *
 *  · 地理定位接口会看到访客的 IP（这是它的工作原理，绕不开）。选的是
 *    `ipwho.is` / `geojs.io` 这类**无需注册、不要求把数据关联到个人**的公共服务，
 *    而且本站**只取国家码**，不取城市、不取经纬度、不落任何日志。
 *  · **页面上只展示聚合结果**（总数 + 各国多少人次），不显示"此刻谁在哪"。
 *    少这一个功能，换来的是访问自己的人不会被公开定位。
 *  · 广告拦截器大概率会拦掉这个请求 —— 所以失败时必须优雅降级，不能留个空框。
 *
 * ## 计数怎么存
 * 用已有的 Abacus（同一套服务，不引入新依赖）：一个总数键 + 每国一个键。
 * Abacus 对同一访客 24 小时内只计一次，所以数字读作"约多少个读者"而不是 PV。
 *
 * ## 硬约束
 * Abacus 只能**按键读取**，没有"列出所有 key"的接口。所以能显示哪些国家，
 * 取决于 `PROBE.knownCountries` 里列了什么 —— 那是手动维护的。新国家即使
 * 有访客也读不出来，但**计数不会丢**（仍在累加），加进清单就会出现。
 */

import { COUNTER, PROBE } from '@/consts';

const cacheKey = (k: string) => `probe:${COUNTER.namespace}:${k}`;

const readCache = (k: string): number | null => {
  try {
    const v = localStorage.getItem(cacheKey(k));
    return v === null ? null : Number(v);
  } catch {
    return null;
  }
};

const writeCache = (k: string, n: number) => {
  try {
    localStorage.setItem(cacheKey(k), String(n));
  } catch {
    /* 隐私模式写不了，忽略 */
  }
};

/** 读一个计数器的当前值（不自增） */
async function getCount(key: string): Promise<number | null> {
  try {
    const res = await fetch(`${COUNTER.endpoint}/get/${encodeURIComponent(COUNTER.namespace)}/${encodeURIComponent(key)}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    // 键还没被创建时 Abacus 返回 404 —— 那是 0，不是错误
    if (res.status === 404) return 0;
    if (!res.ok) return null;
    const json = (await res.json()) as { value?: number };
    return typeof json.value === 'number' ? json.value : null;
  } catch {
    return null;
  }
}

/** 自增一个计数器并返回新值 */
async function hitCount(key: string): Promise<number | null> {
  try {
    const res = await fetch(`${COUNTER.endpoint}/hit/${encodeURIComponent(COUNTER.namespace)}/${encodeURIComponent(key)}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { value?: number };
    return typeof json.value === 'number' ? json.value : null;
  } catch {
    return null;
  }
}

/**
 * 问出访客自己的国家码。
 * 依次尝试多个公共服务：任何一个挂了或被墙都不至于让探针失效。
 * 只取 `country_code` 两个字母，其余字段全部丢掉。
 */
async function detectCountry(): Promise<string | null> {
  const sources: Array<[string, (j: Record<string, unknown>) => unknown]> = [
    ['https://ipwho.is/', (j) => j.country_code],
    ['https://get.geojs.io/v1/ip/geo.json', (j) => j.country_code],
  ];
  for (const [url, pick] of sources) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) continue;
      const json = (await res.json()) as Record<string, unknown>;
      const cc = pick(json);
      if (typeof cc === 'string' && /^[A-Za-z]{2}$/.test(cc)) return cc.toUpperCase();
    } catch {
      /* 换下一个源 */
    }
  }
  return null;
}

/** 国家码 → 中文国名（用浏览器内置的 Intl，不用自己维护一张表） */
function countryName(cc: string): string {
  try {
    const dn = new Intl.DisplayNames(['zh-CN'], { type: 'region' });
    return dn.of(cc) ?? cc;
  } catch {
    return cc;
  }
}

/** 国家码 → 国旗 emoji（区域指示符号，两个字母各偏移 127397） */
function flag(cc: string): string {
  if (!/^[A-Z]{2}$/.test(cc)) return '';
  return String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

export function initProbe(root: ParentNode = document) {
  const el = root.querySelector<HTMLElement>('[data-probe]');
  if (!el || el.dataset.probeDone === '1') return;
  el.dataset.probeDone = '1';

  const totalEl = el.querySelector<HTMLElement>('[data-probe-total]');
  const listEl = el.querySelector<HTMLElement>('[data-probe-countries]');
  const stateEl = el.querySelector<HTMLElement>('[data-probe-state]');

  const paintTotal = (n: number) => {
    if (totalEl) totalEl.textContent = n.toLocaleString('zh-CN');
  };
  const paintState = (s: string) => {
    if (stateEl) stateEl.textContent = s;
  };

  // 先用缓存值渲染：接口慢或失败时也有数字，不会闪一个空白
  const cached = readCache(PROBE.totalKey);
  if (cached !== null) paintTotal(cached);

  void (async () => {
    // 1) 问国家（失败就只统计总数，不阻塞其余部分）
    const cc = await detectCountry();

    // 2) 上报：总数 + 该国。两者可以并行
    const [total] = await Promise.all([
      hitCount(PROBE.totalKey),
      cc ? hitCount(`${PROBE.countryPrefix}${cc}`) : Promise.resolve(null),
    ]);
    if (total !== null) {
      paintTotal(total);
      writeCache(PROBE.totalKey, total);
      paintState('');
    } else if (cached === null) {
      paintState('计数服务暂时联系不上');
    }

    // 3) 读各国计数（含这次上报的那个国家，所以要把 cc 并进待查清单）
    const wanted = [...new Set([...PROBE.knownCountries, ...(cc ? [cc] : [])])];
    const counts = await Promise.all(
      wanted.map(async (code) => [code, await getCount(`${PROBE.countryPrefix}${code}`)] as const),
    );
    const rows = counts
      .filter((r): r is readonly [string, number] => typeof r[1] === 'number' && r[1] > 0)
      .sort((a, b) => b[1] - a[1]);

    if (!listEl) return;
    if (rows.length === 0) {
      listEl.textContent = cc ? '' : '（地区信息暂不可用）';
      return;
    }
    listEl.innerHTML = rows
      .map(
        ([code, n]) =>
          `<li><span class="probe-flag" aria-hidden="true">${flag(code)}</span>` +
          `<span class="probe-name">${countryName(code)}</span>` +
          `<span class="probe-n">${n.toLocaleString('zh-CN')}</span></li>`,
      )
      .join('');
  })();
}
