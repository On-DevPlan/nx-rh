// 应用壳：顶栏 + tab 导航（注册表驱动）+ hash 路由。
// 路由即持久化：当前视图写进 location.hash 与 store，刷新/分享链接都停在原页面。
import { Suspense, useEffect } from 'react';
import { useStore } from './store.jsx';
import { ErrorBoundary } from './components/ui.jsx';
import { VIEWS } from './registry.js';

function viewFromHash() {
  const h = (location.hash || '').replace(/^#\/?/, '');
  return VIEWS.some((v) => v.id === h) ? h : '';
}

export default function App() {
  const { boot, ui, patchUi } = useStore();

  // 初始进入：hash 优先，否则用持久化的上次视图
  useEffect(() => {
    const fromHash = viewFromHash();
    if (fromHash && fromHash !== ui.view) patchUi({ view: fromHash });
    else if (!location.hash) location.hash = '#/' + ui.view;
    // 只在挂载时对齐一次：后续 hash 变化由下面的 hashchange 监听接管
  }, []);

  // hash 变化（浏览器前进后退）→ 同步 store
  useEffect(() => {
    const onHash = () => {
      const v = viewFromHash();
      if (v) patchUi({ view: v });
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [patchUi]);

  const current = VIEWS.find((v) => v.id === ui.view) || VIEWS[0];

  const switchTo = (id) => {
    patchUi({ view: id });
    location.hash = '#/' + id;
  };

  return (
    <>
      <header>
        <div className="brand">nx-rh<span className="sub">npx-repo-hub</span></div>
        <nav>
          {VIEWS.map((v) => (
            <button
              key={v.id}
              className={'tab' + (v.id === current.id ? ' active' : '')}
              onClick={() => switchTo(v.id)}
            >
              {v.title}
            </button>
          ))}
        </nav>
        <div className="meta">{boot?.storePath || ''}</div>
      </header>

      <main>
        {/* 边界放在 Suspense 外层：懒加载 chunk 拉取失败也由它接管，
            否则一个视图崩掉就是整页白屏 */}
        <ErrorBoundary key={current.id}>
          <Suspense fallback={<div className="muted" style={{ padding: 24 }}>加载中…</div>}>
            <section className="panel active"><current.component /></section>
          </Suspense>
        </ErrorBoundary>
      </main>

      <footer>
        每个按钮都有同构的 CLI 命令<span className="fsep"> · </span>
        命令表见 <code>nx-rh help</code>
        <span className="fsep"> · </span>
        agent 可加 <code>--json</code> 获取机器可读输出
      </footer>
    </>
  );
}
