/**
 * 后台面板：发布 / 编辑 / 删除文章，上传图片，查看每篇热度。
 *
 * 设计取舍（为什么不做一个"全功能 CMS"）：
 *  - 这个站是纯静态托管，**仓库就是数据库**。面板的全部职责就是把一次
 *    「提交一个 markdown 文件」变成一个填表动作，其余交给 git 与 GitHub Actions。
 *  - 因此面板不做草稿自动保存（那是 git 的活）、不做定时发布（那是 Actions 的活）。
 *    少一层状态，就少一类"面板里的数据和仓库不一致"的 bug。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { animate } from 'motion/mini';
import { EASE_OUT } from '@/scripts/motion';
import { GITHUB, COUNTER } from '@/consts';
import {
  EMPTY_FRONTMATTER as EMPTY,
  mdToHtml,
  parsePost,
  serializePost as serialize,
  slugify,
  type Frontmatter,
} from '@/lib/post-format';
import {
  deleteFile,
  listDir,
  listImages,
  readFile,
  uploadImage,
  verifyToken,
  writeFile,
  type TreeEntry,
} from '@/lib/github';

type View = 'list' | 'editor' | 'views';

/** 令牌与草稿状态的本地存储键。只存在这台浏览器，不进仓库、不发第三方。 */
const TOKEN_KEY = 'blog:gh-token';

/** 编辑器入场的属性表：提成常量，避免内联字面量触发 motion 的 excess property 检查 */
const EDITOR_IN = { opacity: [0, 1], filter: ['blur(12px)', 'blur(0px)'], y: [16, 0] };

/* ── 面板 ─────────────────────────────────────────────────────────────────── */

export default function Admin() {
  const [token, setToken] = useState<string>('');
  const [tokenInput, setTokenInput] = useState('');
  const [who, setWho] = useState<{ login: string; canWrite: boolean } | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const [view, setView] = useState<View>('list');
  const [posts, setPosts] = useState<TreeEntry[]>([]);
  const [images, setImages] = useState<TreeEntry[]>([]);

  const [editing, setEditing] = useState<{ path?: string; sha?: string; fm: Frontmatter; body: string }>({
    fm: { ...EMPTY },
    body: '',
  });
  const [preview, setPreview] = useState(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const say = useCallback((kind: 'ok' | 'err', text: string) => {
    setToast({ kind, text });
    setTimeout(() => setToast(null), 4200);
  }, []);

  /* 启动：读本地 token 并校验 */
  useEffect(() => {
    const saved = localStorage.getItem(TOKEN_KEY);
    if (!saved) return;
    setToken(saved);
    verifyToken(saved).then((r) => {
      if (r.ok && r.data) setWho(r.data);
      else {
        localStorage.removeItem(TOKEN_KEY);
        setToken('');
      }
    });
  }, []);

  const refresh = useCallback(
    async (tk = token) => {
      if (!tk) return;
      setBusy('加载仓库…');
      const [p, im] = await Promise.all([listDir(GITHUB.postsDir, tk), listImages(tk)]);
      if (p.ok && p.data) setPosts(p.data.sort((a, b) => b.name.localeCompare(a.name)));
      else if (!p.ok) say('err', `读文章目录失败：${p.error}`);
      if (im.ok && im.data) setImages(im.data);
      setBusy(null);
    },
    [token, say],
  );

  useEffect(() => {
    if (who) void refresh();
  }, [who, refresh]);

  const connect = async () => {
    const tk = tokenInput.trim();
    if (!tk) return;
    setBusy('校验 token…');
    setAuthError(null);
    const r = await verifyToken(tk);
    setBusy(null);
    if (!r.ok || !r.data) {
      setAuthError(r.error ?? 'token 无效');
      return;
    }
    if (!r.data.canWrite) {
      setAuthError('这个 token 对该仓库没有写权限，请确认 Contents 权限为 Read and write。');
      return;
    }
    localStorage.setItem(TOKEN_KEY, tk);
    setToken(tk);
    setWho(r.data);
    setTokenInput('');
  };

  const disconnect = () => {
    localStorage.removeItem(TOKEN_KEY);
    setToken('');
    setWho(null);
    setPosts([]);
  };

  const loadPost = async (entry: TreeEntry) => {
    if (!token) return;
    setBusy(`打开 ${entry.name}`);
    const r = await readFile(entry.path, token);
    setBusy(null);
    if (!r.ok || !r.data) return say('err', `读取失败：${r.error}`);
    const { fm, body } = parsePost(r.data.text);
    setEditing({ path: r.data.path, sha: r.data.sha, fm, body });
    setView('editor');
    // 编辑器出现时给一次模糊化开（motion 的字符串选择器在这个 TS 版本里不参与重载，
    // 所以显式取 DOM 节点再动画，行为一样但不牺牲类型）
    const card = document.getElementById('editor-card');
    if (card) {
      animate(card, EDITOR_IN, { duration: 0.5, ease: EASE_OUT });
    }
  };

  const newPost = () => {
    setEditing({ fm: { ...EMPTY }, body: '在这里写正文。\n\n## 小标题\n\n支持 **加粗**、`代码`、列表和图片。\n' });
    setView('editor');
  };

  const save = async () => {
    if (!token) return;
    if (!editing.fm.title.trim()) return say('err', '标题不能为空');
    const isNew = !editing.path;
    const path = editing.path ?? `${GITHUB.postsDir}/${slugify(editing.fm.title, editing.fm.pubDate)}.md`;
    const body = serialize(editing.fm, editing.body);
    const msg = isNew ? `post: ${editing.fm.title}` : `post: update ${editing.fm.title}`;

    setBusy(isNew ? '发布中…' : '保存中…');
    let r = await writeFile(path, body, msg, token, editing.sha);

    /**
     * 409 = 我们手里那个文件的 sha 已过期。
     *
     * 为什么会过期：任何在 GitHub 侧改动过这个文件的操作都会换掉它的 sha——
     * 在网页上编辑过、别人改过，或者**本地做过 rebase / amend**（rebase 会重写提交，
     * blob 的 sha 跟着变）。我自己就制造过一次：为了合并面板发出的提交做了 rebase，
     * 结果面板里一保存就 409，而当时的代码只能把错误甩给用户、让他自己刷新页面。
     *
     * 既然 409 明确表示"我的版本旧了"，那就自动取回最新 sha 再试一次。
     * 单人博客不存在并发编辑，这一次重试是安全的；正文以**编辑器里的内容**为准，
     * 所以"文件在别处被改过"的担心不适用。
     */
    let recovered = false;
    if (!r.ok && r.status === 409) {
      setBusy('文件指纹已更新，正在重试…');
      const fresh = await readFile(path, token);
      if (fresh.ok && fresh.data?.sha) {
        r = await writeFile(path, body, msg, token, fresh.data.sha);
        recovered = r.ok;
      }
    }

    setBusy(null);
    if (!r.ok) {
      return say(
        'err',
        `提交失败：${r.error}` +
          (r.status === 409 ? '（文件刚被其它操作改动过，请重新打开这篇文章再保存）' : ''),
      );
    }
    say(
      'ok',
      (isNew ? '已提交，站点重建中（约 1 分钟）' : '已保存') +
        (recovered ? '（文件指纹已自动更新后重试成功）' : ''),
    );
    setView('list');
    void refresh();
  };

  const remove = async (entry: TreeEntry) => {
    if (!token) return;
    if (!confirm(`删除《${entry.name}》？\n会提交一次删除，历史上仍可恢复。`)) return;
    setBusy('删除中…');
    const r = await deleteFile(entry.path, entry.sha, `post: delete ${entry.name}`, token);
    setBusy(null);
    if (!r.ok) return say('err', `删除失败：${r.error}`);
    say('ok', '已删除');
    void refresh();
  };

  const onPickImage = async (file: File) => {
    if (!token) return;
    setBusy('上传图片…');
    const r = await uploadImage(file, token, (p) => setBusy(`上传图片… ${p}%`));
    setBusy(null);
    if (!r.ok || !r.data) return say('err', `上传失败：${r.error}`);
    const md = `\n![${file.name}](${r.data.url})\n`;
    const ta = textareaRef.current;
    if (ta) {
      const pos = ta.selectionStart ?? editing.body.length;
      setEditing((e) => ({ ...e, body: e.body.slice(0, pos) + md + e.body.slice(pos) }));
    } else {
      setEditing((e) => ({ ...e, body: e.body + md }));
    }
    say('ok', `图片已上传：${r.data.path}`);
    void refresh();
  };

  const insertImageUrl = (url: string) => {
    const md = `\n![](${url})\n`;
    const ta = textareaRef.current;
    if (!ta) return setEditing((e) => ({ ...e, body: e.body + md }));
    const pos = ta.selectionStart ?? editing.body.length;
    setEditing((e) => ({ ...e, body: e.body.slice(0, pos) + md + e.body.slice(pos) }));
  };

  const previewHtml = useMemo(() => mdToHtml(editing.body), [editing.body]);

  /* ── 未连接：token 门 ─────────────────────────────────────────────────── */
  if (!who) {
    return (
      <div className="gate" data-reveal>
        <h1 className="gate-title">写文章</h1>
        <p className="gate-lead">
          这个面板直接往 GitHub 仓库提交文件，因此需要一个
          <strong> 只属于这个仓库 </strong>的访问令牌。
        </p>
        <ol className="gate-steps">
          <li>
            打开 GitHub → Settings → Developer settings →{' '}
            <a
              href="https://github.com/settings/personal-access-tokens/new"
              target="_blank"
              rel="noreferrer"
            >
              Fine-grained tokens
            </a>
          </li>
          <li>
            Repository access 只勾 <code>{GITHUB.user}/{GITHUB.repo}</code>
          </li>
          <li>
            Permissions → Repository permissions → <code>Contents: Read and write</code>
          </li>
          <li>生成后粘贴到下面（只存在这台浏览器本地）</li>
        </ol>
        <div className="gate-row">
          <input
            type="password"
            value={tokenInput}
            placeholder="github_pat_… 或 ghp_…"
            onChange={(e) => setTokenInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && connect()}
            autoComplete="off"
            spellCheck={false}
          />
          <button onClick={connect} disabled={!!busy || !tokenInput.trim()}>
            {busy ?? '连接'}
          </button>
        </div>
        {authError && <p className="gate-err">{authError}</p>}
        <p className="gate-note">
          令牌只保存在浏览器 localStorage，不会写进仓库、也不会发给任何第三方；
          请求直连 api.github.com。
        </p>
      </div>
    );
  }

  /* ── 已连接 ──────────────────────────────────────────────────────────── */
  return (
    <div className="admin">
      <header className="bar">
        <div className="bar-left">
          <span className="who mono">
            @{who.login} · {GITHUB.user}/{GITHUB.repo}
          </span>
        </div>
        <nav className="tabs">
          <button className={view === 'list' ? 'on' : ''} onClick={() => setView('list')}>
            文章
          </button>
          <button className={view === 'views' ? 'on' : ''} onClick={() => setView('views')}>
            热度
          </button>
          <button className={view === 'editor' ? 'on' : ''} onClick={() => (editing.path || editing.body ? setView('editor') : newPost())}>
            编辑
          </button>
        </nav>
        <div className="bar-right">
          <button className="ghost" onClick={newPost}>
            ＋ 新文章
          </button>
          <button className="ghost" onClick={disconnect} title="清除本地令牌">
            断开
          </button>
        </div>
      </header>

      {busy && <div className="busy mono">{busy}</div>}

      {view === 'list' && (
        <section className="list" data-group>
          {posts.length === 0 && (
            <p className="none">
              仓库里还没有文章。点右上「＋ 新文章」发布第一篇。
            </p>
          )}
          {posts.map((p) => (
            <div className="row" key={p.path}>
              <div className="row-main">
                <span className="row-name">{p.name.replace(/\.md$/, '')}</span>
                <span className="row-path mono">{p.path}</span>
              </div>
              <div className="row-actions">
                <button onClick={() => loadPost(p)}>编辑</button>
                <button className="danger" onClick={() => remove(p)}>
                  删除
                </button>
              </div>
            </div>
          ))}
        </section>
      )}

      {view === 'views' && <ViewsPanel posts={posts} token={token} />}

      {view === 'editor' && (
        <section className="editor" id="editor-card">
          <div className="fields">
            <label>
              <span>标题</span>
              <input
                value={editing.fm.title}
                onChange={(e) => setEditing((s) => ({ ...s, fm: { ...s.fm, title: e.target.value } }))}
                placeholder="文章标题"
              />
            </label>
            <label className="wide">
              <span>摘要（列表页与分享卡片用）</span>
              <input
                value={editing.fm.description}
                onChange={(e) => setEditing((s) => ({ ...s, fm: { ...s.fm, description: e.target.value } }))}
                placeholder="一句话说清这篇讲什么"
              />
            </label>
            <label>
              <span>日期</span>
              <input
                type="date"
                value={editing.fm.pubDate}
                onChange={(e) => setEditing((s) => ({ ...s, fm: { ...s.fm, pubDate: e.target.value } }))}
              />
            </label>
            <label>
              <span>标签（逗号分隔）</span>
              <input
                value={editing.fm.tags}
                onChange={(e) => setEditing((s) => ({ ...s, fm: { ...s.fm, tags: e.target.value } }))}
                placeholder="前端, 随笔"
              />
            </label>
            <label className="wide">
              <span>封面图 URL（可留空）</span>
              <div className="cover-row">
                <input
                  value={editing.fm.cover}
                  onChange={(e) => setEditing((s) => ({ ...s, fm: { ...s.fm, cover: e.target.value } }))}
                  placeholder="/blog/images/xxx.jpg"
                />
                <select
                  value=""
                  onChange={(e) => e.target.value && setEditing((s) => ({ ...s, fm: { ...s.fm, cover: e.target.value } }))}
                >
                  <option value="">从已上传图片选…</option>
                  {images.map((im) => (
                    <option key={im.path} value={`${import.meta.env.BASE_URL.replace(/\/$/, '')}/images/${im.name}`}>
                      {im.name}
                    </option>
                  ))}
                </select>
              </div>
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={editing.fm.draft}
                onChange={(e) => setEditing((s) => ({ ...s, fm: { ...s.fm, draft: e.target.checked } }))}
              />
              <span>草稿（不在线上显示）</span>
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={editing.fm.featured}
                onChange={(e) => setEditing((s) => ({ ...s, fm: { ...s.fm, featured: e.target.checked } }))}
              />
              <span>首页置顶大卡</span>
            </label>
          </div>

          <div className="body-head">
            <span className="mono">正文 · Markdown</span>
            <div className="body-tools">
              <button className="ghost" onClick={() => fileRef.current?.click()}>
                插入图片
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void onPickImage(f);
                  e.target.value = '';
                }}
              />
              <button className="ghost" onClick={() => setPreview((v) => !v)}>
                {preview ? '只看编辑' : '显示预览'}
              </button>
              <button className="primary" onClick={save} disabled={!!busy}>
                {editing.path ? '保存' : '发布'}
              </button>
            </div>
          </div>

          <div className={preview ? 'body-grid' : 'body-grid single'}>
            <textarea
              ref={textareaRef}
              value={editing.body}
              onChange={(e) => setEditing((s) => ({ ...s, body: e.target.value }))}
              spellCheck={false}
              placeholder="正文…"
            />
            {preview && (
              <div className="preview">
                <div className="prose" dangerouslySetInnerHTML={{ __html: previewHtml }} />
                {images.length > 0 && (
                  <details className="imgpick">
                    <summary className="mono">已上传图片（点击插入）</summary>
                    <div className="imgpick-grid">
                      {images.map((im) => {
                        const url = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/images/${im.name}`;
                        return (
                          <button key={im.path} onClick={() => insertImageUrl(url)} title={im.name}>
                            <img src={url} alt={im.name} loading="lazy" />
                          </button>
                        );
                      })}
                    </div>
                  </details>
                )}
              </div>
            )}
          </div>
        </section>
      )}

      {toast && <div className={`toast ${toast.kind}`}>{toast.text}</div>}
      <AdminStyles />
    </div>
  );
}

/* ── 热度面板 ─────────────────────────────────────────────────────────────── */

function ViewsPanel({ posts, token }: { posts: TreeEntry[]; token: string }) {
  const [data, setData] = useState<Record<string, number | null>>({});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (posts.length === 0) return;
    let alive = true;
    setLoading(true);
    const slugs = posts.map((p) => p.name.replace(/\.md$/, ''));
    Promise.all(
      slugs.map(async (s) => {
        try {
          const r = await fetch(`${COUNTER.endpoint}/get/${COUNTER.namespace}/${encodeURIComponent(s)}`);
          if (!r.ok) return [s, null] as const;
          const j = (await r.json()) as { value?: number };
          return [s, typeof j.value === 'number' ? j.value : null] as const;
        } catch {
          return [s, null] as const;
        }
      }),
    ).then((rows) => {
      if (!alive) return;
      setData(Object.fromEntries(rows));
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [posts, token]);

  const rows = posts
    .map((p) => ({ name: p.name.replace(/\.md$/, ''), views: data[p.name.replace(/\.md$/, '')] ?? null }))
    .sort((a, b) => (b.views ?? -1) - (a.views ?? -1));
  const total = rows.reduce((s, r) => s + (r.views ?? 0), 0);

  return (
    <section className="views">
      <div className="views-head">
        <div className="stat">
          <span className="stat-label">合计阅读</span>
          <span className="stat-value">{loading ? '…' : total.toLocaleString('zh-CN')}</span>
        </div>
        <p className="mono views-note">
          计数源：{COUNTER.endpoint.replace('https://', '')} · 同一访客 24 小时只计一次
        </p>
      </div>
      <div className="list">
        {rows.map((r) => {
          const max = Math.max(1, ...rows.map((x) => x.views ?? 0));
          const pct = ((r.views ?? 0) / max) * 100;
          return (
            <div className="vrow" key={r.name}>
              <span className="vname mono">{r.name}</span>
              <span className="vbar">
                <i style={{ width: `${pct}%` }} />
              </span>
              <span className="vnum mono">{r.views === null ? '—' : r.views.toLocaleString('zh-CN')}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/* ── 样式（面板是独立的"工作台"，比博客正文更冷、更工具化）────────────────── */

function AdminStyles() {
  return (
    <style>{`
      .admin, .gate { display: grid; gap: 1.25rem; }

      .gate { max-width: 44rem; }
      .gate-title { font-size: var(--step-3); margin: 0; }
      .gate-lead { color: var(--ink-2); margin: 0; max-width: 46ch; }
      .gate-steps { color: var(--ink-2); display: grid; gap: .5rem; padding-left: 1.2rem; margin: 0; }
      .gate-steps code { font-family: var(--mono); font-size: .84em; background: var(--bg-soft); border: 1px solid var(--line); padding: .1em .35em; }
      .gate-steps a { border-bottom: 1px solid var(--accent); }
      .gate-row { display: flex; gap: .6rem; flex-wrap: wrap; }
      .gate-row input {
        flex: 1 1 22rem; font-family: var(--mono); font-size: .84rem;
        background: var(--bg-soft); border: 1px solid var(--line-2); color: var(--ink);
        padding: .7rem .9rem;
      }
      .gate-row input:focus { outline: none; border-color: var(--accent); }
      .gate-err { color: #ff8f7a; margin: 0; font-size: .88rem; }
      .gate-note { color: var(--ink-3); font-size: .82rem; margin: 0; }

      .bar { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap;
             border: 1px solid var(--line); padding: .6rem .8rem; background: var(--bg-soft); }
      .bar-left, .bar-right { display: flex; gap: .5rem; align-items: center; }
      .who { color: var(--ink-3); text-transform: none; letter-spacing: .04em; }
      .tabs { display: flex; gap: .25rem; }
      .tabs button, .bar button, .row-actions button, .body-tools button {
        font: inherit; font-size: .82rem; color: var(--ink-2); background: transparent;
        border: 1px solid transparent; padding: .4rem .75rem; cursor: pointer;
        transition: color var(--dur-1) var(--ease-out), background var(--dur-1) var(--ease-out), border-color var(--dur-1) var(--ease-out);
      }
      .tabs button:hover, .bar button:hover, .row-actions button:hover { color: var(--ink); border-color: var(--line-2); }
      .tabs button.on { color: var(--ink); background: var(--bg); border-color: var(--line-2); }
      .ghost { border: 1px solid var(--line-2) !important; }
      .primary { background: var(--accent) !important; color: #fff !important; border-color: var(--accent) !important; }
      .primary:disabled { opacity: .5; cursor: default; }
      .danger:hover { color: #ff8f7a !important; border-color: #ff8f7a !important; }

      .busy { color: var(--accent); }

      .list { border: 1px solid var(--line); }
      .row { display: flex; align-items: center; justify-content: space-between; gap: 1rem;
             padding: .7rem .9rem; border-bottom: 1px solid var(--line); }
      .row:last-child { border-bottom: 0; }
      .row-main { display: grid; gap: .15rem; min-width: 0; }
      .row-name { font-family: var(--serif); font-size: 1.02rem; }
      .row-path { color: var(--ink-3); text-transform: none; letter-spacing: .02em; font-size: .7rem;
                  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .row-actions { display: flex; gap: .25rem; flex: none; }
      .none { color: var(--ink-2); margin: 0; }

      .fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); gap: .9rem;
                border: 1px solid var(--line); padding: 1rem; background: var(--bg-soft); }
      .fields label { display: grid; gap: .35rem; }
      .fields label.wide { grid-column: 1 / -1; }
      .fields span { font-family: var(--mono); font-size: .68rem; letter-spacing: .08em;
                     text-transform: uppercase; color: var(--ink-3); }
      .fields input[type='text'], .fields input:not([type]), .fields input[type='date'] {
        font: inherit; font-size: .92rem; background: var(--bg); border: 1px solid var(--line-2);
        color: var(--ink); padding: .55rem .7rem;
      }
      .fields input:focus { outline: none; border-color: var(--accent); }
      .cover-row { display: flex; gap: .5rem; }
      .cover-row input { flex: 1; }
      .cover-row select { font: inherit; font-size: .82rem; background: var(--bg); color: var(--ink-2);
                          border: 1px solid var(--line-2); padding: .55rem .6rem; max-width: 14rem; }
      .check { grid-auto-flow: column; justify-content: start; align-items: center; gap: .5rem; }
      .check span { text-transform: none; letter-spacing: .02em; font-family: var(--sans); font-size: .86rem; color: var(--ink-2); }

      .body-head { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
      .body-tools { display: flex; gap: .4rem; }
      .body-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; align-items: start; }
      .body-grid.single { grid-template-columns: 1fr; }
      @media (max-width: 60rem) { .body-grid { grid-template-columns: 1fr; } }
      .body-grid textarea {
        font-family: var(--mono); font-size: .86rem; line-height: 1.75;
        background: var(--bg-soft); border: 1px solid var(--line-2); color: var(--ink);
        padding: 1rem; min-height: 32rem; resize: vertical;
      }
      .body-grid textarea:focus { outline: none; border-color: var(--accent); }
      .preview { border: 1px solid var(--line); padding: 1rem 1.2rem; max-height: 32rem; overflow: auto; }
      .preview .prose { font-size: .95rem; }
      .preview h1 { font-size: 1.5rem; } .preview h2 { font-size: 1.25rem; margin-top: 1.4em; }
      .preview h3 { font-size: 1.1rem; margin-top: 1.2em; }
      .preview p { margin: 0 0 .9em; color: var(--ink-2); }
      .preview img { border: 1px solid var(--line); }
      .preview code { font-family: var(--mono); font-size: .84em; background: var(--bg-soft);
                      border: 1px solid var(--line); padding: .1em .3em; }
      .preview pre { background: var(--bg-soft); border: 1px solid var(--line); padding: .8rem; overflow: auto; }
      .preview blockquote { margin: 0 0 .9em; padding-left: .9rem; border-left: 2px solid var(--accent); color: var(--ink-2); }

      .imgpick { margin-top: 1rem; border-top: 1px solid var(--line); padding-top: .8rem; }
      .imgpick summary { cursor: pointer; color: var(--ink-3); }
      .imgpick-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(5rem, 1fr)); gap: .4rem; margin-top: .6rem; }
      .imgpick-grid button { padding: 0; border: 1px solid var(--line-2); background: none; cursor: pointer; overflow: hidden; }
      .imgpick-grid img { width: 100%; height: 3.5rem; object-fit: cover; display: block;
                          transition: transform var(--dur-2) var(--ease-out); }
      .imgpick-grid button:hover img { transform: scale(1.08); }

      .views-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
      .views-note { color: var(--ink-3); text-transform: none; letter-spacing: .02em; margin: 0; }
      .stat { display: grid; gap: .3rem; }
      .stat-label { font-family: var(--mono); font-size: .68rem; letter-spacing: .08em;
                    text-transform: uppercase; color: var(--ink-3); }
      .stat-value { font-family: var(--serif); font-size: var(--step-2); line-height: 1; font-variant-numeric: tabular-nums; }
      .vrow { display: grid; grid-template-columns: minmax(0, 1fr) 8rem 4rem; align-items: center; gap: 1rem;
              padding: .6rem .9rem; border-bottom: 1px solid var(--line); }
      .vrow:last-child { border-bottom: 0; }
      .vname { color: var(--ink-2); text-transform: none; letter-spacing: .02em; font-size: .74rem;
               overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .vbar { height: 4px; background: var(--line); display: block; overflow: hidden; }
      .vbar i { display: block; height: 100%; background: var(--accent); width: 0;
                transition: width 700ms var(--ease-out); }
      .vnum { text-align: right; color: var(--ink-2); }

      .toast { position: fixed; left: 50%; bottom: 1.5rem; transform: translateX(-50%);
               padding: .65rem 1rem; font-size: .86rem; z-index: 80; border: 1px solid var(--line-2);
               background: var(--bg-soft); animation: toast-in 420ms var(--ease-out) both; }
      .toast.ok { border-color: var(--accent); }
      .toast.err { border-color: #ff8f7a; color: #ff8f7a; }
      @keyframes toast-in { from { opacity: 0; transform: translate(-50%, 12px); filter: blur(8px); } }
    `}</style>
  );
}
