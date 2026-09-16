# 02 · Web 面板规范

> 归属主文档 [[server-cli-web-scaffold]]。读它当你要**写面板**或**加一个视图**时。
> 这些不是审美偏好——它们的共同目标是「让人一眼看懂、一次点对、不用记」。

## 一、硬规定

### 无 emoji

面板、CLI 输出、代码注释**全程无 emoji**。用文字和颜色区分状态。

原因：emoji 在等宽终端里宽度不定、跨平台渲染不一、屏幕阅读器读法各异，
且会把"专业工具"变成"聊天窗口"。一个项目里只要有一个人加了 emoji，标准就破了。

### 主题色只用黑白灰

单色 CSS，靠**对比与边框**建立层级，不靠色相：

```css
:root {
  --ink: #111;      /* 主文字 */
  --mid: #666;      /* 次要文字、说明 */
  --soft: #f2f2f2;  /* 浅底、hover */
  --soft-2: #e2e2e2;/* 分隔线、禁用 */
  --paper: #fff;    /* 卡片底 */
  --shadow: 0 1px 2px rgba(0,0,0,.08);
}
body {
  background: var(--paper);
  color: var(--ink);
  font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
}
/* 路径、命令、diff、任何标识符用等宽 */
.mono, code { font-family: ui-monospace, Consolas, monospace; }
```

**唯一允许的彩色是语义红**（危险操作、冲突、失败），且只用一种：
`#b3261e`。彩色一旦超过一种，就开始变成装饰，用户就不再把它当信号读。

### 状态用标签而不是颜色块

```jsx
<span className="tag">仅中心</span>          {/* 中性灰 */}
<span className="tag strong">一致</span>       {/* 加粗黑边 */}
<span className="tag bad">冲突</span>          {/* 语义红 */}
```

## 二、响应式与布局

不做移动端适配，但**窗口变窄不能塌**。用 flex + wrap，不写死宽度：

```css
.toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.cols    { display: flex; gap: 14px; align-items: flex-start; }
.col     { flex: 1; min-width: 0; }   /* min-width:0 是关键：否则内容撑破容器 */
```

`min-width: 0` 这条经常忘——没有它，flex 子项里的长路径会把整个布局撑出屏幕。
长文本一律配 `overflow: hidden; text-overflow: ellipsis; white-space: nowrap`。

## 三、状态：该持久化的必须持久化

**凡是「刷新后不该丢」的用户选择，一律走 localStorage。**

```js
const LS_KEY = 'nx-rh-ui';

// 只持久化「选择」，不持久化「数据」——数据永远从 /api 拉，避免陈旧缓存
const DEFAULT_UI = {
  view: 'repos',      // 当前 tab
  central: '',        // 各页选中的路径
  project: '',
  selCentral: [],     // 多选勾选
  selProject: [],
};

function loadUi() {
  try { return { ...DEFAULT_UI, ...JSON.parse(localStorage.getItem(LS_KEY) || '{}') }; }
  catch { return { ...DEFAULT_UI }; }
}
```

要点：

- **字段级合并兜底**：`{ ...DEFAULT_UI, ...saved }`，这样新增字段不会让老数据失效，
  也不需要写版本迁移。
- **数据不持久化**：只存"用户选了什么"，不存"接口返回了什么"。否则界面会显示陈旧数据。
- **勾选对账**：数据刷新后，把已不存在的名字从勾选里剔除。但**必须等数据真的到手再做对账**——
  首次挂载时先到的空响应会把持久化的勾选全清掉（这个坑很隐蔽）。

## 四、点击即复制（所有路径与标识）

这是本类工具**最高频的操作**——用户看到路径/ID/命令，下一步就是去别处粘贴它。
所以：**凡是路径、ID、命令、标识符，点击即复制。**

```jsx
export function Copyable({ text, className = '', title, children }) {
  const toast = useToast();
  const copy = async () => {
    const v = String(text ?? '');
    try {
      await navigator.clipboard.writeText(v);
      toast('已复制: ' + (v.length > 60 ? v.slice(0, 57) + '...' : v));
    } catch {
      // 非安全上下文（http://非 localhost）下 clipboard API 不可用，退回 execCommand
      const ta = document.createElement('textarea');
      ta.value = v; ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove();
      toast('已复制');
    }
  };
  return <span className={'copyable ' + className} title={title || '点击复制'} onClick={copy}>
    {children !== undefined ? children : text}
  </span>;
}
```

配套 CSS 给一个手型光标与 hover 反馈：

```css
.copyable { cursor: pointer; }
.copyable:hover { background: var(--soft); }
```

**复制成功必须有反馈**（toast），否则用户会连点三次。

## 五、不用浏览器原生弹窗

`alert` / `confirm` / `prompt` **一律不用**。页内实现：

| 需求 | 用什么 |
| --- | --- |
| 轻提示（已复制、已保存） | 页内 toast，2–3 秒自动消失 |
| 确认（危险操作） | 页内 dialog，Promise 风格 |
| 输入（路径、名称） | 同上，带 input 的 dialog |
| 大块内容（diff、日志、命令输出） | Modal |

Promise 风格让调用处读起来是同步的：

```js
const ok = await dialog({ message: `删除「${name}」？`, danger: true });
if (!ok) return;
```

**别用 `document.querySelector` 去读 dialog 里的输入框**——用 ref。
页面上出现第二个同名 class 时，`querySelector` 会读错元素。

## 六、错误边界

```jsx
<ErrorBoundary key={current.id}>
  <Suspense fallback={<div className="muted">加载中…</div>}>
    <current.component />
  </Suspense>
</ErrorBoundary>
```

视图都是懒加载的，**没有这层兜底时，一个视图崩掉就是整页白屏**——
用户连切到别的 tab 自救都做不到。边界放在 Suspense **外层**，
这样 chunk 加载失败也由它接管。

## 七、视图注册表

```js
// web/frontend/registry.js —— 新增面板 = 写组件 + 登记一行
export const VIEWS = [
  { id: 'repos',  title: '仓库',   component: lazy(() => import('../../modules/repos/view.jsx')) },
  { id: 'skills', title: 'Skill', component: lazy(() => import('../../modules/skills/view.jsx')) },
];
```

`App.jsx` 的 tab 导航、hash 路由、懒加载全部由这张表驱动，改面板不用动壳。
**用显式字面量 `lazy(() => import('...'))`，不要用变量拼路径**——Vite 静态分析不了，
会失去代码分割。

### 「这个模块有没有面板」由谁判定

**由模块自己在 index.js 里声明**，不要靠扫文件系统：

```js
export default {
  id: 'repos', title: '仓库', order: 10,
  view: () => import('./view.jsx'),   // 有面板
  // view: null,                      // 无面板（如 system / bundled 这类纯后端模块）
  actions: [...],
};
```

理由：`view` 是**声明**，扫描文件系统是**推断**。声明可以被一致性测试直接对账
（"带 view 的模块 ↔ 前端注册表"），推断则要在测试里复刻一遍文件系统规则。
而且有的模块天生没有面板（聚合、工具类），显式 `null` 比"没有那个文件"更能表达意图。

两个 `registry.js` 因此都要显式写，并由测试保证对齐：

```
runtime/registry.js        MODULES 列表（后端）
web/frontend/registry.js   VIEWS 列表（前端，只登记 view 非 null 的模块）
```

### hash 路由 + 持久化双写

当前视图既写 `location.hash`（可分享、可后退）也写 localStorage（下次进来停在原位）：

```js
useEffect(() => {
  const fromHash = viewFromHash();
  if (fromHash && fromHash !== ui.view) patchUi({ view: fromHash });
  else if (!location.hash) location.hash = '#/' + ui.view;
}, []);   // 只在挂载时对齐一次，后续交给 hashchange
```

## 八、API 客户端

```js
const DEFAULT_TIMEOUT_MS = 30000;

export async function api(path, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'content-type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: ctrl.signal,
    });
    const json = await res.json().catch(() => { throw new Error(`HTTP ${res.status}`); });
    if (!json.ok) {
      const err = new Error(json.error || '请求失败');
      err.code = json.code;          // 调用方可据此区分冲突与参数错误
      throw err;
    }
    return json.data;
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('请求超时（本地服务无响应）');
    throw e;
  } finally { clearTimeout(timer); }
}
```

配一个操作守卫，失败自动 toast，调用处不必写 try/catch：

```js
const guard = useGuard();
onClick={() => guard(async () => { await api('/api/...', {...}); await refresh(); })}
```

## 九、提示「CLI 等价」——由数据派生，不要手写

面板上每个操作都有等价 CLI 命令。在页面底部提示这一点很有价值，
但**提示必须是派生的**：

```jsx
export function CliHints({ module }) {
  const { boot } = useStore();
  const cmds = (boot?.commands || []).filter((c) => c.module === module);
  return <div className="cli-hint">
    {cmds.map((c) => <Copyable key={c.id} className="cli-cmd" text={c.command}>{c.command}</Copyable>)}
  </div>;
}
```

手写提示会与实际命令悄悄漂移——而它恰恰是用户核对"这个按钮有没有 CLI 等价"的依据。
提示说"有"而实际没有，比没有提示更糟。

## 十、踩过的坑

| 坑 | 后果 | 正确做法 |
| --- | --- | --- |
| `.cli-hint` 之类的提示手写 | 与真实命令脱节，误导用户 | 从 bootstrap 下发的命令表渲染 |
| flex 子项没写 `min-width: 0` | 长路径把布局撑出屏幕 | 所有 flex 子项加 `min-width: 0` |
| `querySelector` 读弹窗输入框 | 有同名元素时读错 | 用 ref |
| 懒加载视图没有错误边界 | 整页白屏 | ErrorBoundary 包在 Suspense 外 |
| 首次挂载就用空响应修剪勾选 | 持久化的勾选被清空 | 等数据真的到手再对账 |
| 用变量拼 `lazy(() => import(x))` | 失去代码分割，全部打进主包 | 字面量路径 |
| 只用一种颜色区分状态 | 用户不把颜色当信号读 | 标签文字优先，颜色（唯一语义红）辅助 |
