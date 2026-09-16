# 04 · 状态存储

> 归属主文档 [[server-cli-web-scaffold]]。读它当你要**定存储位置**或**接持久化**时。

## 一、放哪

```
~/.<主题名>/store.json
```

用户目录下一级，以**项目主题名**命名（`~/.nx-rh/`、`~/.k6-report/`…）。
不要用 `~/.config/<name>/` 这种多层路径——本机工具的用户不会去翻它，
而"就在 home 下、一眼能找到、能手动改"反而是优点（出问题时可手工修复）。

```js
// core/paths.js —— 路径的唯一定义处
import { homedir } from 'node:os';
import { join } from 'node:path';

export const APP_NAME = '<主题名>';
export const APP_DIR = join(homedir(), `.${APP_NAME}`);
export const STORE_PATH = join(APP_DIR, 'store.json');

// 允许测试与多实例覆盖存储位置：环境变量优先
export function storePathFromEnv() {
  return process.env.<NAME>_STORE || STORE_PATH;
}
```

**环境变量覆盖不是可选项。** 没有它，测试会写脏用户的真实数据——
而且问题不会当场暴露，是在用户发现自己的配置被测试改乱时才暴露。

启动横幅里把生效路径打出来，用户才知道数据在哪：

```
面板:   http://127.0.0.1:7800
存储:   ~/.nx-rh/store.json
```

## 二、单一 JSON 文件 vs 分片

**先用单一文件。** 本机工具的数据量小（几百条记录），一个 JSON 文件最好调试、最好备份、
最容易手工修。

只有出现下面任一情况才考虑分片：

- 单文件超过几 MB，每次读全量都慢
- 有大量非结构化内容（文件副本、二进制）

分片时按业务分区，例如 `store.json` + `cache/<key>.json`，而不是按字段拆散。

## 三、写得不能坏：原子写

**永远不要直接覆写**。进程在写到一半时被杀（Ctrl+C、断电、OOM），
用户的数据文件就永久损坏了。

```js
await fsp.mkdir(dirname(p), { recursive: true });
const tmp = p + '.tmp';
await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
await fsp.rename(tmp, p);      // rename 在同一文件系统上是原子的
```

`rename` 是关键：它让"新内容完整落盘"与"替换旧文件"成为一个不可分割的动作。
用户要么看到旧数据，要么看到新数据，永远不会看到半截。

## 四、读得要新：缓存 + 失效检测

CLI 进程改了数据，正在运行的 Web 服务必须立刻看到。做法是**按 mtime 失效**：

```js
let cache = null;
let cacheMtime = -1;

export async function loadStore(explicitPath) {
  const p = explicitPath || storePathFromEnv();
  try {
    const st = await fsp.stat(p);
    if (cache && cacheMtime === st.mtimeMs) return cache;   // 未变，直接返回
    const raw = await fsp.readFile(p, 'utf8');
    cache = normalize(JSON.parse(raw));
    cacheMtime = st.mtimeMs;
    return cache;
  } catch {
    // 文件不存在或损坏：返回空结构（首次运行；也允许外部修好后自动恢复）
    cache = normalize(null);
    cacheMtime = -1;
    return cache;
  }
}

export async function saveStore(next, explicitPath) {
  const p = explicitPath || storePathFromEnv();
  const data = normalize(next);
  /* …原子写… */
  cache = data;
  cacheMtime = (await fsp.stat(p)).mtimeMs;   // 自己写入后主动刷新 mtime，
  return data;                                 // 避免「自己触发自己重读」
}
```

两个容易漏的点：

1. **自己写完要主动刷新缓存的 mtime**，否则下一次 `loadStore` 会因为
   mtime 变了而白读一遍（无害但浪费），更糟的是可能读到中间态。
2. **读失败要降级返回空结构，而不是抛错**。文件损坏时用户还能打开界面去修，
   而不是面对一个"启动即崩"的工具。

## 五、读-改-写事务

多步修改必须包在一个事务里，否则中途抛错会留下写了一半的状态：

```js
export async function mutateStore(fn, explicitPath) {
  const cur = structuredClone(await loadStore(explicitPath));
  const result = fn(cur);          // fn 直接改传入的深拷贝；抛错则不落盘
  await saveStore(cur, explicitPath);
  return result === undefined ? cur : result;
}
```

用法：

```js
export async function addRepo(input) {
  return mutateStore((s) => {
    if (s.repos.some((r) => r.path === abs)) throw conflict('该路径已登记: ' + abs);
    s.repos.push(repo);
    return repo;
  });
}
```

**深拷贝（`structuredClone`）是必需的**——直接改缓存对象会让"抛错不落盘"失效，
因为缓存里已经是脏数据了。

## 六、结构：设置与业务数据分区

```js
const EMPTY = () => ({
  version: 1,
  settings: {                 // 用户可配置项，键值对，需要持续演进
    theme: 'light',
    defaultTarget: '',
  },
  <业务集合>: [],              // 业务数据，结构由项目定
});

function normalize(data) {
  const base = EMPTY();
  if (!data || typeof data !== 'object') return base;
  base.version = data.version ?? 1;
  base.settings = { ...base.settings, ...(data.settings || {}) };   // 字段级合并
  base.<业务集合> = Array.isArray(data.<业务集合>) ? data.<业务集合> : [];
  return base;
}
```

`normalize` 是**向前兼容的兜底**：老版本的数据文件缺少新字段时自动补默认值，
用户不需要手工迁移。只要坚持"新增字段一律有默认值"，`version` 就很少需要真的用上。

## 七、设置项怎么写

设置**必须有唯一归属**。不要把它寄生在某个业务模块里——否则任何模块想加一个设置项，
都得去改另一个模块的代码。

```
modules/settings/service.js    ← 设置的唯一读写入口（导出 getSettings / updateSettings / …）
modules/settings/index.js      ← setting get / set 命令
modules/settings/view.jsx      ← 设置页
```

数组型设置项（候选列表之类）在 `normalize` 里统一归一化，
避免"有时是字符串有时是数组"这种数据。

### 那条例外怎么在 lint 上真正落地

分层规则说"模块之间不得互相依赖"，但 `settings` 是**基础模块**，允许被单向只读依赖。
论文里写一句"这是唯一例外"没用——**lint 不知道什么是例外**。可执行的做法是：

> **枚举所有兄弟模块**，而"例外"就是**不把它列进来**。

```js
// modules/**/*.js 的禁列 —— settings 故意不在里面
{ group: ['../<域A>/*', '../<域B>/*', '../<域C>/*'],
  message: '模块之间不得互相依赖。唯一例外：../settings/service.js。' }
```

于是规则是精确的、可检查的，且新增模块时你**必须手动把它加进禁列**——
这正好是个提醒：你在新增一个可能有依赖的模块。

**允许与禁止**（把边界写死，别让人猜）：

| | 允许 | 禁止 |
| --- | --- | --- |
| 依赖方向 | `<任意模块>` → `settings`（单向） | `settings` → 任何其他模块（会成环） |
| 导入对象 | `../settings/service.js` 的**纯函数** | `../settings/index.js`、`view.jsx`（那是传输层/UI） |
| 用途 | 只读（`getSettings()`、读取某个配置值） | 绕过 settings 直接写它的 store 字段 |

### 零例外的替代方案（不推荐，但要知道代价）

你也可以让各模块**直接从 `core/store.js` 读设置**，这样 lint 不用开口子。
代价是：每个模块都知道设置字段的名字，字段一改名就要全仓库找；
设置的默认值与归一化逻辑也会散开。**为了"零例外"而付出这个代价不划算**——
例外只要写成上面那张表，它就是明确的、可检查的。

## 八、踩过的坑

| 坑 | 后果 | 正确做法 |
| --- | --- | --- |
| 直接覆写文件 | 中断即数据损坏 | 临时文件 + rename |
| 没有环境变量覆盖 | 测试写脏用户真实数据，且不易察觉 | `storePathFromEnv()`，测试必须指向临时目录 |
| 深拷贝缺失 | 抛错后缓存里已是脏数据，"不落盘"名存实亡 | `mutateStore` 用 `structuredClone` |
| 自己写完不刷新 mtime | 下次读取白跑一次，可能读到中间态 | 写入后主动 `stat` 并更新缓存 |
| 读失败直接抛错 | 数据文件损坏时工具启动即崩，用户无法自救 | 降级返回空结构 |
| 新增字段没有默认值 | 老数据文件触发 undefined 崩溃 | `normalize` 做字段级合并 |
| 设置寄生在业务模块 | 任何模块加设置项都要改别人的代码 | 独立的 settings 模块 |
| 数组型设置项类型不定 | 下游到处写 `Array.isArray` 判断 | `normalize` 统一归一化 |
