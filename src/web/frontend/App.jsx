// 应用壳：顶栏 + tab 导航（注册表驱动）+ hash 路由。
// 路由即持久化：当前视图写进 location.hash 与 store，刷新/分享链接都停在原页面。
import { Suspense, useEffect } from 'react';
import { useStore } from './store.jsx';
import { ErrorBoundary, useDialog, useToast } from './components/ui.jsx';
import { VIEWS } from './registry.js';

function viewFromHash() {
  const h = (location.hash || '').replace(/^#\/?/, '');
  // 取首段做模块匹配：模块内部可有子路由（如 skills/platform/claude-code）
  const first = h.split('/')[0];
  return VIEWS.some((v) => v.id === first) ? first : '';
}

export default function App() {
  const { boot, ui, patchUi, switchScope, registerDir, scopeTick, refreshBoot } = useStore();
  const { toast } = useToast();
  const { dialog, node: dlgNode } = useDialog();

  // 窗口聚焦时刷新 bootstrap：别的终端跑 nx-rh serve 登记了新目录，这里能看到
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === 'visible') refreshBoot().catch(() => {}); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [refreshBoot]);

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

  // header 当前作用域展示：激活了最近目录显示它的末段，否则显示服务进程目录
  const activePath = ui.activeScope?.path || boot?.projectRoot || '';
  const activeLabel = String(activePath).split(/[\\/]/).filter(Boolean).pop() || activePath;

  // 主动登记目录：登记即切换（项目级信息立刻指向它）
  const addDir = async () => {
    const p = await dialog({
      title: '注册项目目录',
      message: '登记后立即可切换：项目级信息只针对该目录。',
      input: true,
      placeholder: 'D:/code/my-project',
      okText: '登记并切换',
    });
    if (!p) return;
    const entry = await registerDir(p).catch(() => null);
    if (!entry) { toast('登记失败'); return; }
    await switchScope(entry);
    toast('已登记并切换');
  };

  const recents = boot?.recents || [];

  return (
    <>
      <header>
        <div className="brand"><img src="/logo-rounded.png" alt="" />nx-rh<span className="sub">npx-repo-hub</span></div>
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
        <div className="meta" title={activePath}>{activeLabel}</div>
        <details className="recents">
          <summary title="最近的项目目录。每个目录启动 serve 时自动登记；点击切换后，项目级信息只针对该目录">
            最近目录 {recents.length}
          </summary>
          <ul>
            <li>
              <button
                className={'muted' + (!ui.activeScope ? ' active' : '')}
                title={boot?.projectRoot ? `服务进程目录：${boot.projectRoot}\n点击切回（取消激活）` : '点击切回服务进程目录'}
                onClick={() => switchScope(null)}
              >
                （服务进程目录）{!ui.activeScope ? ' ✓' : ''}
              </button>
            </li>
            {recents.map((r) => (
              <li key={r.scope}>
                <button
                  className={'muted' + (ui.activeScope?.scope === r.scope ? ' active' : '')}
                  title={`${r.path}\n点击切换：之后的查看 / 迁移都落到这个目录`}
                  onClick={() => switchScope(ui.activeScope?.scope === r.scope ? null : r)}
                >
                  {String(r.path).split(/[\\/]/).filter(Boolean).pop()}
                  {ui.activeScope?.scope === r.scope ? ' ✓' : ''}
                </button>
              </li>
            ))}
            <li>
              <button className="muted" title="主动登记一个目录（登记即切换）" onClick={addDir}>＋ 注册其他目录…</button>
            </li>
          </ul>
        </details>
      </header>

      <main>
        {/* 边界放在 Suspense 外层：懒加载 chunk 拉取失败也由它接管，
            否则一个视图崩掉就是整页白屏 */}
        <ErrorBoundary key={current.id}>
          <Suspense fallback={<div className="muted" style={{ padding: 24 }}>加载中…</div>}>
            {/* scopeTick 进 key：切换激活目录时强制重挂载，视图挂载期的请求会带上新 scope 头 */}
            <section className="panel active" key={scopeTick}><current.component /></section>
          </Suspense>
        </ErrorBoundary>
      </main>

      <footer>
        <code>nx-rh help</code> 查看全部命令
        <span className="fsep"> · </span>
        agent 可加 <code>--json</code> 获取机器可读输出
      </footer>

      {/* 页内弹窗（规范禁用 alert/confirm/prompt） */}
      {dlgNode}
    </>
  );
}
