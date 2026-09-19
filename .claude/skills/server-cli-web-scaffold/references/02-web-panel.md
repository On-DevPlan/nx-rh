# 02 · Web 端要求（面板规范 + 视觉设计）

> 归属主文档 [[server-cli-web-scaffold]]。读它当你要**写面板**、**加一个视图**、或**改现有 UI 的密度与样式**时。
> 这是 Web 端的**完整要求**：交互规范（弹窗 / 复制 / 错误边界 / 注册表）与视觉规范（密度 / 立体感 / 分隔）在同一份里，因为写一个视图时两套规则要**同时**满足。
> 共同目标不是审美——是「让人一眼看懂、一次点对、不用记」。

## 一、什么时候读这个

- 要**写**一个新的视图（`modules/X/view.jsx`）
- 要**改**现有面板的密度、按钮、卡片布局
- 团队里有人反馈"这个页面岛屿感太重" / "按钮找不到"——来确认是不是哪条规则破了

不适用：从零建项目的骨架（走主文档「创建流程」阶段 1–6 + [[01-bootstrap-serve-first]]）；
dev 模式怎么跑（走 [[07-framework-runtime]]）。

## 二、三条核心不变量（整个 Web 端的地基）

写任何样式前先理解这三条。**违反任何一条都会让界面变成一堆岛屿或一坨噪音**。

### 1. 单色 + 无 emoji

面板、CLI 输出、代码注释**全程无 emoji**。用文字和颜色区分状态。
原因：emoji 在等宽终端里宽度不定、跨平台渲染不一、屏幕阅读器读法各异，
且会把"专业工具"变成"聊天窗口"。

```css
:root {
  --ink: #14161a;   /* 主文字 */
  --paper: #fff;    /* 卡片底 */
  --soft: #f5f6f7;  /* 浅底、hover */
  --soft-2: #ebedf0;/* 分隔线、禁用 */
  --mid: #8b9096;   /* 次要文字 */
}
body {
  background: var(--paper);
  color: var(--ink);
  font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
}
/* 路径、命令、diff、任何标识符用等宽 */
.mono, code { font-family: ui-monospace, Consolas, monospace; }
```

**唯一允许的彩色是语义红**（危险操作、冲突、失败），只用一种：`#b3261e`。
彩色一旦超过一种，就开始变成装饰，用户就不再把它当信号读。

### 2. 状态用标签而不是颜色块

```jsx
<span className="tag">仅中心</span>          {/* 中性灰 */}
<span className="tag strong">一致</span>       {/* 加粗黑底 */}
<span className="tag bad">冲突</span>          {/* 语义红 */}
```

### 3. 立体感只给**可被按 / 可被填**的元素

**核心规则**：页面看上去要**平**。立体感（双向明暗阴影）只给**正在等用户操作**的**交互件**——
按钮 / 选中态 / 输入框。**容器**（卡片、行、表格、标签、提示条、面包屑）**不带任何 box-shadow**，
靠底色变化 / 边框 / 文字层级做区分。

**为什么不能给容器立体感**：本机工具的板子要让用户 0.3 秒定位一个按钮。立体感会
**占用视觉带宽**——卡片浮起来了，眼睛被它**截留**，还要花心思排除干扰才能找到要按的按钮。
立体感的本质是「这个东西和它周围的东西不一样」——但**面板的绝大部分内容都是无关干扰**，
不需要被特意强调「我在这里」。

**立体感的四个落点**：

| 元素 | 默认态 | 交互态 |
|---|---|---|
| `.btn`（所有按钮） | 凸起（双向明暗阴影） | 按下：阴影内嵌 + 下沉 1px；hover：阴影 + 一圈淡光晕 |
| `.btn:disabled` | **内凹**底——视觉上与可按按钮**彻底区隔** | （无 hover） |
| `.tab.active` | **单层**立体阴影（凸起），不叠 `--shadow`——叠两层变岛屿 | — |
| `input:focus` / `select:focus` | 内凹底——视觉是「进入槽位」而非「画了条线」 | — |

```css
:root {
  --shadow-relief:        -1px -1px 2px rgba(255,255,255,.85), 2px 2px 6px rgba(20,22,26,.07);
  --shadow-relief-press:   inset  1px  1px 2px rgba(20,22,26,.10), inset -1px -1px 2px rgba(255,255,255,.7);
  --shadow-relief-inset:  inset  1px  1px 2px rgba(20,22,26,.06), inset -1px -1px 2px rgba(255,255,255,.9);
}

.btn {
  height: var(--btn-h);
  border: 0;
  background: var(--ink);
  color: var(--paper);
  border-radius: var(--radius-btn);
  box-shadow: var(--shadow-relief);
  transition: box-shadow 0.12s, transform 0.08s, background 0.12s;
}
.btn:active:not(:disabled) {
  box-shadow: var(--shadow-relief-press);
  transform: translateY(1px);
}
.btn:disabled {
  background: var(--soft);
  color: var(--mid);
  box-shadow: var(--shadow-relief-inset);
  cursor: not-allowed;
}

.tab.active { box-shadow: var(--shadow-relief); }   /* 单层 */
input:focus, select:focus {
  outline: none;
  border-color: var(--soft-2);
  box-shadow: var(--shadow-relief-inset);
}
```

## 三、密度：核心显示 28px 行 + 12px 字号，按钮 32px

视觉密度是**两个层级**——不堆 padding 撑高、不升 font-size，每一行都得**算过**：

| 区域 | 高度 | 字号 | 说明 |
|---|---|---|---|
| `.row` / 表格 `td` / `input` / `select` | **28px** | **12px** | 核心显示部分——一行 = 一份数据，密集、连续 |
| `.btn` / `.tab` | **32px** | 12px | 交互件，比 row 厚 **4px**——视觉上明确「这是可以按的」 |
| `.card .colhead` / 卡片标题 `h3` | 28px | 13px | 与行同高，但字号略大；不靠 padding / 投影强调 |
| `.pill` / `.tag` | 22px | 11px | 次级标签，比 row 更紧凑 |

```css
:root {
  --row-h: 28px;
  --btn-h: 32px;
  --fs-core: 12px;
}
.row, td, th, input, select { height: var(--row-h); font-size: var(--fs-core); }
.btn, .tab { height: var(--btn-h); font-size: var(--fs-core); }
```

**为什么是 4px 差**：行与按钮差 4px，让按钮在视觉密度上和"数据"明确区分——
按钮是**唯一**可以改变状态的东西，4px 厚度差就是它该得的强调。**别让按钮和行同高**。

**为什么不上更大字号**：本机工具的板子信息密度高。13–14px 是 SaaS 那种内容稀疏的节奏。
12px 是「认真看才看得清」的语义——要操作它，就得看它。

## 四、分隔：1px 浅底线，不用 margin / 投影

主体是**连续的流**，不是一摞岛屿。**所有分隔靠 1px 极浅底线** `var(--border)`：

| 位置 | 怎么分隔 |
|---|---|
| `header` 与 `main` | 顶栏 `border-bottom` |
| `.card` 与 `.card` | 下一个 card 用 `border-top`（`.card + .card` 选择器） |
| `.colhead` 与 `.list` | `.colhead` 用 `border-bottom` |
| `.row` 与 `.row` | 每个 row `border-bottom`，最后一个 `border-bottom: 0` |
| 表格行 | `tbody tr border-bottom`，表头 `th border-bottom` |
| 设置页 label/value | `dt` `dd` 都 `border-bottom` |
| `.modal-title` 与 body | `border-bottom` |

**禁止**：用 `margin-top` / `margin-bottom` / `box-shadow` / 大量 `padding` 把容器之间撑出空间。
那些是**岛屿**做法，会让界面断裂成堆。

```css
.row {
  height: var(--row-h);
  padding: 0 12px;            /* 水平 padding 给文本留呼吸；竖直 padding = 0，高度由 height 锁 */
  border-bottom: var(--border);
}
.row:last-child { border-bottom: 0; }    /* 最后一行不留尾线 */
.card + .card { border-top: var(--border); }
```

## 五、响应式与布局

不做移动端适配，但**窗口变窄不能塌**。用 flex + wrap，不写死宽度：

```css
.toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.cols    { display: flex; gap: 14px; align-items: flex-start; }
.col     { flex: 1; min-width: 0; }   /* min-width:0 是关键：否则内容撑破容器 */
```

`min-width: 0` 这条经常忘——没有它，flex 子项里的长路径会把整个布局撑出屏幕。
长文本一律配 `overflow: hidden; text-overflow: ellipsis; white-space: nowrap`。

## 六、状态：该持久化的必须持久化

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

- **字段级合并兜底**：`{ ...DEFAULT_UI, ...saved }`，新增字段不让老数据失效，也不需要版本迁移。
- **数据不持久化**：只存"用户选了什么"，不存"接口返回了什么"。否则界面会显示陈旧数据。
- **勾选对账**：数据刷新后，把已不存在的名字从勾选里剔除。但**必须等数据真的到手再做对账**——
  首次挂载时先到的空响应会把持久化的勾选全清掉（这个坑很隐蔽）。

## 七、点击即复制（所有路径与标识）

```css
.copyable { cursor: copy; }
.copyable:hover { background: var(--soft); }
```

**复制成功必须有反馈**（toast），否则用户会连点三次。

## 八、不用浏览器原生弹窗

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

## 九、错误边界

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

## 十、视图注册表

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

### hash 路由 + 持久化双写

当前视图既写 `location.hash`（可分享、可后退）也写 localStorage（下次进来停在原位）：

```js
useEffect(() => {
  const fromHash = viewFromHash();
  if (fromHash && fromHash !== ui.view) patchUi({ view: fromHash });
  else if (!location.hash) location.hash = '#/' + ui.view;
}, []);   // 只在挂载时对齐一次，后续交给 hashchange
```

## 十一、API 客户端

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

## 十二、提示「CLI 等价」——由数据派生，不要手写

面板上每个操作都有等价 CLI 命令。页面底部提示这一点很有价值，但**提示必须是派生的**，
且文案要**通顺**——命令之间用间隔点分开，别让它们粘成一坨：

```jsx
export function CliHints({ module }) {
  const { boot } = useStore();
  const cmds = (boot?.commands || []).filter((c) => c.module === module);
  if (!cmds.length) return null;
  return <div className="cli-hint">
    <span className="cli-hint-label">这个页面上的每个按钮都有一条同构的 CLI 命令</span>
    {cmds.map((c, i) => (
      <Fragment key={c.id}>
        {i > 0 && <span className="cli-hint-sep"> · </span>}
        <Copyable className="cli-cmd" text={c.command} title={`点击复制：${c.usage}`}>{c.command}</Copyable>
      </Fragment>
    ))}
    <span className="cli-hint-tail">。加 <code className="cli-hint-flag">--json</code> 得机器可读输出。</span>
  </div>;
}
```

手写提示会与实际命令悄悄漂移——而它恰恰是用户核对"这个按钮有没有 CLI 等价"的依据。
提示说"有"而实际没有，比没有提示更糟。

## 十三、实操：从 token 到落地

### 怎么写一个 .row

```jsx
<div className="row">
  <div className="name">{name}</div>
  <div className="desc">{description}</div>
  <div className="acts">
    <button className="btn small ghost" onClick={onEdit}>编辑</button>
    <button className="btn small ghost" onClick={onDelete}>删除</button>
  </div>
</div>
```

```css
.row {
  display: flex;
  align-items: center;
  height: var(--row-h);
  padding: 0 12px;
  border-bottom: var(--border);
  font-size: var(--fs-core);
  transition: background 0.12s;
}
.row:hover { background: var(--soft); }
.row:last-child { border-bottom: 0; }
.row .name { font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row .desc { color: var(--mid); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row .acts { margin-left: auto; display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
```

**关键**：
- `height: var(--row-h)` 锁死高度，`padding: 0 12px` 让内容垂直居中
- `border-bottom` 用 `last-child: 0` 去掉尾线
- 子元素 `.name` / `.desc` 都加 `min-width: 0` 防止撑破容器

### 怎么写一个 .btn

```jsx
<button className="btn" onClick={onSave}>保存</button>
<button className="btn ghost" onClick={onCancel}>取消</button>
<button className="btn danger" onClick={onDelete}>删除</button>
<button className="btn small ghost" onClick={onEdit}>编辑</button>
```

```css
.btn {
  font: inherit;
  font-size: var(--fs-core);
  cursor: pointer;
  height: var(--btn-h);          /* 32px */
  padding: 0 12px;
  border: 0;
  border-radius: var(--radius-btn);
  background: var(--ink);
  color: var(--paper);
  box-shadow: var(--shadow-relief);
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.btn.ghost { background: var(--soft); color: var(--ink); }
.btn.small { height: 22px; padding: 0 8px; font-size: 11px; border-radius: 6px; }
.btn.danger { background: #b3261e; color: #fff; }
```

**关键**：
- `height` 是**精确数字**，**不**让 padding 撑
- 主按钮 (`.btn`)、危险 (`.danger`)、次级 (`.ghost`)、紧凑 (`.small`) 四种规格
- `:hover` 加光晕、`:active` 加内嵌阴影 + `translateY(1px)` —— 立体感四态都到位

### 不该改什么

| 行为 | 后果 |
|---|---|
| 给 `.card` 加 `box-shadow` | 卡片浮起来变成岛屿 |
| 把 `.row` 改成 `padding: 10px 0` 让它自己定高 | 高度不可控，行间距不一致 |
| 用 `font-size: 14px` 让文字"看得清" | 破坏 12px 的信息密度节奏 |
| 把 `.btn` 高度改成 36px "更好按" | 破坏 4px 差的密度二元性 |
| 给 `.row` 加 `border-radius: 8px` + 浅底 | 行变成小卡片 |
| 用 `margin-top: 20px` 把卡片分开 | 视觉上断裂成岛屿 |
| 给 `.tab.active` 再加 `--shadow` 叠层 | tab 又变岛屿 |

## 十四、反 AI-default 自检（写完一个面板后必查）

AI 生成的设计最容易冒出**通用模板味**，这里列五条**最常出现的 AI-default**，本项目刻意不踩：

| AI-default 特征 | 本项目对应做法 |
|---|---|
| 1. 暖米色背景 + 衬线字体 + 赤陶口音 | 黑白灰 + system-ui + 中文无衬线 |
| 2. 暗黑背景 + 荧光绿/朱红单点 | 浅底 + 唯一语义红 |
| 3. broadsheet 全宽发丝 + 硬角网格 | **有 1px 浅底线**，但**只有这一种**分隔方式 |
| 4. SaaS 卡片套件（一刀切圆角、统一软阴影、渐变装饰） | 圆角按内容分 4/8/999，阴影按交互件类型分，零渐变 |
| 5. template chrome（间隔点当装饰、数字标签 01/02、全大写 eyebrow、em dash 链接） | 间隔点只用于**命令列表分隔**这一处功能场景，其余不写 |

任何一条漏了，**面板就会从"工具板"变成"产品页"**——这是两个产品目的，两种视觉。
本骨架的产物是**前者**：让用户**完成操作**，不是让用户**看到东西**。

## 十五、踩过的坑

| 坑 | 后果 | 正确做法 |
| --- | --- | --- |
| `.cli-hint` 之类的提示手写 | 与真实命令脱节，误导用户 | 从 bootstrap 下发的命令表渲染 |
| CLI 提示里命令之间无分隔 | `nx-rh env statusnx-rh env list…` 粘成一坨，不可读 | 命令之间用 `<span> · </span>` 分隔；文案写成通顺句子 |
| map 里用无 key 的 Fragment | React key 警告 | `<Fragment key={c.id}>` |
| flex 子项没写 `min-width: 0` | 长路径把布局撑出屏幕 | 所有 flex 子项加 `min-width: 0` |
| `querySelector` 读弹窗输入框 | 有同名元素时读错 | 用 ref |
| 懒加载视图没有错误边界 | 整页白屏 | ErrorBoundary 包在 Suspense 外 |
| 首次挂载就用空响应修剪勾选 | 持久化的勾选被清空 | 等数据真的到手再对账 |
| 用变量拼 `lazy(() => import(x))` | 失去代码分割，全部打进主包 | 字面量路径 |
| 只用一种颜色区分状态 | 用户不把颜色当信号读 | 标签文字优先，颜色（唯一语义红）辅助 |
| 立体感一视同仁加给所有卡片 | 视觉密度被压扁，扫读变慢 | 立体感只给**按钮 / 选中态 / 输入框** |
| `.tab.active` 立体 + `--shadow` 叠层 | tab 浮起来变**岛屿**，抢页面焦点 | tab.active 用**单层** `--shadow-relief` |
| 给 .card 加 box-shadow | 卡片**整体浮起**，变成一堆岛屿 | `.card` 不投影；靠底色 / 边框 / 文字层级 |
| `.card` 用 margin + 圆角 + padding 撑出空间 | 投影没了，padding 和圆角还在，**仍是岛屿** | 圆角 4px、padding 收到 6px 0；card 之间 1px 浅底线 |
| 容器之间用 margin-top 分隔 | 视觉密度被撑断 | 全站 1px `var(--border)` 分隔，**不用任何 margin/投影** |
| 按钮和行同高 | 按钮和数据视觉混淆，眼睛找不到 | 行 28px、按钮 32px——**4px 差** |
| input 聚焦用 `0 0 0 3px` 外发光 | 视觉上是「画了条线」 | 用内凹阴影，视觉上「按进槽位」 |
| 按钮按下用 `transform: scale(.97)` 模拟按动 | 高 DPI 上糊 | 阴影内嵌 + `translateY(1px)` |