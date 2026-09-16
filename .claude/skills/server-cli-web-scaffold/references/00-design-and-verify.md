# 00 · 设计思想与依赖图校验

> 归属主文档 [[server-cli-web-scaffold]]。本文件回答两件事：
> **这套骨架为什么这么分层**，以及 **怎么用机器把分层钉死**。

## 一、驱动关系

```
        ┌──────────────────────────────────────────┐
        │  serve（唯一常驻入口）                     │
        └───────────────┬──────────────────────────┘
                        │ 静态面板 + /api
        ┌───────────────┴──────────────┬────────────┐
        ▼                              ▼            │
   Web 面板                        HTTP API         │
        └──────────────┬───────────────┘            │
                       ▼                            │
              action 声明（唯一真相源）               │
                       ▼                            │
                service 层（业务）                    │
                       ▼                            │
         core（存储 / 错误 / 文件 / 算法）             │
                                                    │
   CLI ───────────────┘（与 Web 走同一条链）           │
        │                                           │
        └──► skill install ──► ~/.claude/skills ──► agent
```

三条驱动链，一条比一条向上一级：

1. **serve 驱动 CLI 与 Web**——三者共享同一份 action 声明与 service 层，
   不存在"Web 一套业务、CLI 另一套业务"。
2. **CLI/Web 驱动 skill**——工具自己会 `skill install`，把使用说明装给 agent。
3. **skill 驱动 agent**——agent 学会用这套 CLI，于是这套工具对 agent 是可编程的。

第 3 条是这个骨架跟普通 CLI 工具的分水岭：**工具不只是给人用的，也是给 agent 用的**。
一旦承认这点，`--json` 的稳定性、错误码、幂等性就从"锦上添花"变成硬契约。

## 二、action 机制的四个文件

```
runtime/registry.js   汇总所有模块的 action；装载期自检重名/缺字段
runtime/spec.js       规格解析：校验、强转、路由编译、用法串生成
runtime/cli.js        通用 CLI 运行器：解析 → 匹配 → 校验 → 渲染 → help
runtime/api.js        HTTP 路由：由 action.http 编译，与 CLI 同源
```

业务侧只需要：

```
modules/<域>/index.js     actions 声明（cli + http + args/flags + run）
modules/<域>/service.js   业务逻辑（不认识 argv，也不认识 HTTP）
modules/<域>/view.jsx     面板视图
```

### action 的完整字段

```js
{
  id: 'skill.sync',                    // 全局唯一，测试与调试用
  cli: ['skill', 'sync'],              // 或 [['a','b'],['c','d']] 表别名
  http: ['POST', '/api/skills/sync'],  // 或显式 null = 纯 CLI 命令
  summary: '中心 -> 项目同步',          // 进 help
  args: ['name'],                      // 位置参数；{name, required:false} 可空
  flags: {
    project: { type: 'string', required: true },
    mode:    { type: 'string', enum: ['symlink', 'copy'] },
    force:   { type: 'boolean' },
    names:   { type: 'array' },        // 逗号分隔
    depth:   { type: 'number', default: 3 },
  },
  run: (ctx, meta) => service.syncSkill(ctx),
  render: (data, ctx) => `已同步 -> ${data.path}`,   // 可 async
}
```

**关键约定**：`cli` 必填，`http` 可为 `null`。方向刻意不对称——
保证"Web 能做的 CLI 都能做"，但不要求反向（CLI 可以有额外命令）。

### 为什么 flag 要声明而不用全局白名单

早期版本用一个全局 `BOOL_FLAGS` 白名单判断哪些 flag 不取值。
问题：`skill install --force demo` 会把 `force` 解析成字符串 `'demo'`，
而 `demo` 本该是位置参数。**只有 action 自己知道哪些 flag 是布尔型**，
所以规格必须随 action 走。

同理，`type: 'number'` 让 `--depth 3` 在两端都变成数字 3，
不必在两处各写一遍 `parseInt(x, 10) || 3`——那正是分叉的起点。

## 三、ctx 契约（最容易各写各的地方）

`run(ctx, meta)` 的 `ctx` 是一个**扁平对象**——`ctx.ref`，不是 `ctx.args.ref`。
两端各自把它拼出来，再喂给**同一个** `applySpec` 做校验与强转。

| 输入来源 | 映射到 | 说明 |
| --- | --- | --- |
| CLI 位置参数 | 按 `args` 声明的**顺序**逐个具名 | `args:['id']` + `repo resolve abc` → `ctx.id='abc'` |
| CLI `--flag v` | 同名 | `--file a.txt` → `ctx.file` |
| HTTP 路由占位符 `:id` | **同名** | `/api/repos/:id` → `ctx.id` |
| HTTP query（GET/HEAD） | 同名 | `?side=central` → `ctx.side` |
| HTTP body（POST/PATCH/DELETE） | 同名 | `{file:'a.txt'}` → `ctx.file` |

合并顺序即优先级：**路径占位符 → query → body**，后写的覆盖先写的。

```js
// runtime/api.js 的拼装
const raw = {};
route.keys.forEach((k, i) => { raw[k] = decodeURIComponent(m[i + 1]); }); // 路径占位符
if (method === 'GET' || method === 'HEAD') {
  for (const [k, v] of url.searchParams) raw[k] = v;                       // query
} else {
  Object.assign(raw, await readBody(req).catch(() => ({})));               // body
}
const data = await action.run(applySpec(action, raw), { transport: 'http' });
```

**两条必须记住的推论**（漏了会静默出错）：

1. **`args` 与路由占位符是两份独立声明，靠「同名」绑定。**
   `args: ['ref']` + `http: ['DELETE','/api/images/:ref']` 都产出 `ctx.ref`。
   名字对不上就绑不上，而且**不会报错**——只会把 `undefined` 传进 service。
   写完一条 action 后，对照检查：`args` 里的每个名字，在 `http` 路径或 `flags` 里有没有对应。
2. **不要写成「只有 body 里有才覆盖」。** 无 body 的 `DELETE` 会永远绑不上参数。
   正确做法是上表那样**无条件合并**，让 `applySpec` 去做 `required` 校验。

`meta` 只有 `{ transport: 'cli' | 'http' }`。它只用于**两端形态确实不同**的少数场景
（例如合并工具：CLI 收文件路径、HTTP 收文本内容）。能用扁平 ctx 表达的就别用 meta 分叉，
否则你会得到两条只测了一条的调用路径。

## 四、模块要 runtime 的数据怎么办

`system` 模块（bootstrap / routes）天然需要**命令表**，而命令表在 `runtime/registry.js`；
分层规则又说模块不能向上依赖 runtime。这不是矛盾，用**函数体内的动态 import** 破环：

```js
// modules/system/index.js
async function commandTable() {
  const { ALL_COMMANDS, commandEntry } = await import('../../runtime/cli.js');
  return ALL_COMMANDS.map(commandEntry);
}
```

动态 import 不在模块求值期执行，所以不构成循环——调用发生在启动完成后，
registry 早已求值完毕。**静态 import 会成环，动态 import 不会**，这是本骨架里
唯一需要用到它的地方。

除 `ctx` 与 `meta` 外，模块**不应期望运行时注入任何别的东西**。
需要别的东西就动态 import，或把它下沉到 `core/`。

## 五、平台命令与模块 action 是同一张表

`serve` / `help` / `version` 这类**平台命令**（不属于任何业务域）与模块 action 形状相同，
只是定义在 `runtime/cli.js`：

```js
const BUILTINS = [
  { id: 'serve', cli: ['serve'], summary: '启动 Web 面板',
    flags: { port: { type: 'number', default: 7800 }, 'no-open': { type: 'boolean' } },
    run: (ctx) => cmdServe(ctx) },
  { id: 'help', cli: ['help'], args: [{ name: 'topic', required: false }],
    run: (ctx) => helpEntries(ctx.topic), render: (entries, ctx) => renderHelp(entries, ctx.topic) },
  { id: 'version', cli: ['version'], run: () => VERSION, render: (v) => v },
];

export const ALL_COMMANDS = [...BUILTINS, ...ACTIONS];
```

**判据**：业务能力 → 模块 action；纯 CLI 运行时关注点（起服务、帮助、版本）→ 平台命令。
两者合进同一张 `ALL_COMMANDS`，所以 `help` 与 `routes` 不会漏掉它们，
**也不会出现两张长度不同的「命令表」**。

`serve` 要起 server，server 又 import api，api 又 import registry——这一环同样靠动态 import 打破：

```js
async function cmdServe(ctx) {
  const { startServer } = await import('./server.js');   // 避开 api → registry → cli 成环
  const { openBrowser } = await import('../core/open.js');
  ...
}
```

## 六、依赖图校验（本文件的重点）

分层规则写在文档里活不过三次提交。**必须让机器检查**。一共三道闸：

### 闸 1：lint 禁止越层 import

**整份可用**，照抄即可——这里必须给全，因为少一行就会让所有 JSX 文件解析失败：

```js
// eslint.config.js
import { defineConfig } from 'eslint/config';

const BASE = {
  'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  'no-undef': 'off',          // 浏览器/Node 全局混用，靠运行时暴露
  eqeqeq: ['error', 'smart'],
  'prefer-const': 'error',
  'no-var': 'error',
};

export default defineConfig([
  { ignores: ['src/web/public/**', 'node_modules/**', 'assets/**'] },
  {
    files: ['**/*.{js,mjs,jsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      // ⚠️ 少了这一行，所有 .jsx 都会 Parsing error: Unexpected token '<'
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: BASE,
  },

  // core 是最底层
  { files: ['src/core/**/*.js'], rules: { 'no-restricted-imports': ['error', { patterns: [
    { group: ['../modules/**', '../runtime/**', '../web/**'],
      message: 'core 是最底层，不得依赖 modules / runtime / web。' },
  ]}]}},

  // 模块之间不得互相依赖：**枚举所有兄弟模块**，
  // 「例外」的实现方式就是**不把它列进来**（settings 故意不在禁列）。
  { files: ['src/modules/**/*.js'], rules: { 'no-restricted-imports': ['error', { patterns: [
    { group: ['../<域A>/*', '../<域B>/*', '../<域C>/*'],
      message: '模块之间不得互相依赖；共享逻辑下沉 core/。唯一例外：../settings/service.js（基础模块）。' },
  ]}]}},

  // 聚合模块是刻意的例外（它要读各模块状态）
  { files: ['src/modules/system/**/*.js'], rules: { 'no-restricted-imports': 'off' } },

  // 前后端边界——价值最高的一条。files 必须**同时覆盖 view.jsx**，
  // 否则真正写视图的那个文件反而不受约束。
  { files: ['src/web/frontend/**/*.{js,jsx}', 'src/modules/**/view.jsx'],
    rules: { 'no-restricted-imports': ['error', { patterns: [
      { group: ['node:*'], message: '前端不能引用 Node 内置模块。' },
      { group: ['**/modules/*/index.js', '**/modules/*/service.js', '**/runtime/**', '**/core/**'],
        message: '前端只能 import 模块的 view.jsx，以及 web/frontend 下的组件与 api 客户端。' },
    ]}]}},
]);
```

**注意**：`no-restricted-imports` 的 patterns 匹配 import **源字符串**，所以要用相对路径前缀
（`../modules/**`）而不是绝对路径。

### 反向规则也要写清

分层图只说了正向（web 壳 import 各模块的 `view.jsx`）。**反向也必须明确**，
否则每个人都会猜，而两种猜法都能跑：

- ✅ `modules/<域>/view.jsx` **可以** import `web/frontend/components/*`、`web/frontend/store.jsx`、
  `web/frontend/api/client.js` —— 视图要用 `Copyable`、toast、`api()`，这些就在那里
- ❌ `view.jsx` **不可以** import `core/` 与 `runtime/` —— 那会把 Node 侧代码拖进浏览器包
- ❌ `core/`、`runtime/`、`service.js` **不可以** import 任何 `.jsx`

上面那份配置已经把这些编码进去了：前端的禁列里有 `**/core/**` 与 `**/runtime/**`，
但没有 `web/frontend/**`。

### 验证规则真的会触发

写完配置**立刻各造一次违规**，确认报错，再删掉：

```bash
echo "import { x } from '../modules/<域>/service.js';" >> src/core/__probe.js
echo "import 'node:fs';" >> src/modules/<域>/view.jsx
pnpm run lint      # 必须报错
rm src/core/__probe.js src/modules/<域>/view.jsx 的追加行
```

一条从不报错的规则等于没有规则。

### 闸 2：装载期自检（最快的反馈）

在 registry 里，模块加载时就检查：

```js
for (const a of ACTIONS) {
  if (seenIds.has(a.id)) throw new Error('action id 重复: ' + a.id);
  if (!cliPathsOf(a).length) throw new Error(`action 没有 CLI 命令: ${a.id}`);
  if (a.http && seenHttp.has(key)) throw new Error(`路由重复: ${key}`);
  if (!a.run) throw new Error(`action 缺少 run: ${a.id}`);
}
```

启动瞬间失败，而不是等某个用户敲到那条命令才发现。

### 闸 3：一致性测试（覆盖跨文件的四张表）

```
模块目录  ↔  后端注册表  ↔  前端视图注册表  ↔  视图里实际调用的接口
```

`tests/unit/registry.test.mjs` 应断言：

- 每个 `src/modules/*/` 都在 `runtime/registry.js` 登记（反向也要查）
- 带 `view` 的模块都在 `web/frontend/registry.js` 登记，且无孤儿
- 每条 action 的 CLI 路径都能被运行器**解析回它自己**（零副作用，只走匹配）
- **视图里调用的每个 `/api/...` 都有对应路由**（正则抽取视图源码里的路径，
  模板变量归一成 `:param` 再匹配）——这条能抓住"前端写错路径，用户点了才 404"
- 每条 HTTP 路由都能由某条 CLI 命令触达

**反面对照**：如果只靠人维护，`help` 文本、路由表、视图注册表三处迟早不同步，
而不同步的后果是"面板上有个按钮，点了 404"或"某个 CLI 命令 help 里没有"。

### 闸 4（可选但推荐）：文档漂移防护

`assets/` 里的 skill 文档会随包发到用户机器上指导 agent。断言其中出现的
每条 `xxx <子命令>` 都能被解析——命令改名而文档没跟上，agent 就会照着敲一条不存在的命令。

## 七、CRUD 完备性：资源型模块的验收标准

### 先判断：这个模块该不该是 CRUD

**不是所有模块都该有 CRUD。** 硬套只会得到语义别扭的命令——
`system add`、`github update` 这种一看就知道是凑的。先分类：

| 模块类型 | 判断依据 | 例子 | 该提供什么 |
| --- | --- | --- | --- |
| **集合资源** | 一组同级实体，每条有标识，用户会想改其中一条或删其中一条 | repos、images、tasks | **完整 CRUD 五操作**（本节断言的对象） |
| 单例配置 | 全局只有一份，读出来改回去 | settings | 退化为 `X get` / `X set` |
| 动作集合 | 对已有对象做操作，本身不产生实体 | skills（同步 / 比较 / 推送） | 按动作命名 |
| 外部连接器 | 包装外部 CLI 或服务，没有本地状态 | github（包 gh） | 查询类命令 |
| 聚合 / 工具 | 只读聚合、或纯函数集合 | system、bundled | 命令即可，不必有视图 |

判据一句话：**问「用户会不会想改其中一条，或删其中一条」**。会 → 集合资源。

**「不勉强」不等于「可以随便」**：上面每一类都有它该满足的底线——
**两端可达**（CLI 与 HTTP 都能调用）对**所有** action 都成立，不只是 CRUD 资源。
CRUD 断言只是对集合资源额外加了「五操作齐备」这一层。

### 五操作对照表

| 操作 | action id | CLI | HTTP |
| --- | --- | --- | --- |
| 查（列表） | `X.list` | `X list` | `GET /api/X` |
| 查（单条） | `X.get` | `X get <id>` | `GET /api/X/:id` |
| 增 | `X.add` | `X add …` | `POST /api/X` |
| 改 | `X.update` | `X update <id> …` | `PATCH /api/X/:id` |
| 删 | `X.remove` | `X remove <id>` | `DELETE /api/X/:id` |

**HTTP 方法要符合语义**。方法用错不会让功能立刻失效，但会让接口语义混乱，
也让 agent 无法从端点推断行为。

### 五个操作的语义（容易做错的地方）

| 操作 | 要点 |
| --- | --- |
| `list` | 返回**全部**（本机工具数据量小，别急着分页）；可带筛选 flag。路由里**不能有 `:param`**——那说明它是"查单条"而不是"列表" |
| `get` | **定位方式要宽**：内部 id 与用户手上的路径 / 名称都接受。agent 拿到一条记录时，手里往往是人读的路径（`D:/code/x`）而不是内部 id（`r_abc123`） |
| `add` | 重复必须**报 `CONFLICT`**——不要静默 upsert，也不要再插一条。用户的"我以为没加过"要靠这个错误来纠正 |
| `update` | **PATCH 语义**：只改传入的字段，未传的保持原值。做成"整体替换"的话，调用方每次都得先读一遍再写全量，很容易把并发修改覆盖掉 |
| `remove` | 幂等还是报错，**选一个并写进 summary / 文档**。默认推荐报 `NOT_FOUND`（能帮用户发现打错字）；但若调用方天然会传入"本就不存在"的值（例如从动态列表里选一个），就改成幂等静默成功——两种都对，**不一致才不对** |

另外两条跨操作的纪律：

- **两端的参数名必须一致**。CLI 的 `--project P` 与 HTTP body 的 `{project}` 是同一个名字，
  这是 ctx 扁平化的前提（见第三节）。名字对不上就会静默传 `undefined`。
- **两端的错误码必须一致**。不能 CLI 报 `NOT_FOUND` 而 HTTP 报 400——那样同一个失败
  在两个入口下要写两套处理。

### 为什么必须显式声明 + 断言

「这个模块该有哪些操作」是人脑里的意图——**不写下来就没有东西可以检查**。
在模块描述符里声明一行：

```js
export default {
  id: 'repos',
  resource: 'repo',      // 声明：本模块管理的是一组 repo 实体
  actions: [...],
};
```

测试据此断言五个操作齐备、且两端都能调用：

```js
const CRUD_VERB = { list: 'list', get: 'get', create: 'add', update: 'update', remove: 'remove' };

test('声明了 CRUD 资源的模块，五个操作齐备且两端可调用', () => {
  const resources = MODULES.filter((m) => m.resource);
  // 没有模块声明 resource 时，这条检查会静默地什么都不查 —— 必须钉住
  assert.ok(resources.length > 0, '没有任何模块声明 resource，检查形同虚设');

  const problems = [];
  for (const m of resources) {
    for (const [op, verb] of Object.entries(CRUD_VERB)) {
      const a = ACTIONS.find((x) => x.id === `${m.resource}.${verb}`);
      if (!a) { problems.push(`${m.id}: 缺 ${op}（应为 ${m.resource}.${verb}）`); continue; }
      if (!cliPathsOf(a).length) problems.push(`${m.id}: ${a.id} 缺 CLI 命令`);
      if (!a.http) problems.push(`${m.id}: ${a.id} 缺 HTTP 路由（面板调不到）`);
    }
  }
  assert.deepEqual(problems, [], `CRUD 不完备:\n${problems.join('\n')}`);
});
```

再补一条**路由形状**的检查——形状不对时功能可能还能跑，但语义已经错了：

```js
test('CRUD 路由的形状对得上语义', () => {
  const segs = (p) => p.split('/').filter(Boolean);
  const hasParam = (p) => segs(p).some((s) => s.startsWith(':'));

  for (const m of MODULES.filter((m) => m.resource)) {
    const http = (op) => ACTIONS.find((a) => a.id === `${m.resource}.${CRUD_VERB[op]}`).http;

    // list 是集合路由；带 :param 说明它其实是"查单条"
    assert.equal(hasParam(http('list')[1]), false, `${m.id}: list 路由不应含 :param`);

    // 其余四个必须能定位到单条。update 没有 :id 的话，它其实是"改全部"——调用方一定会用错
    for (const op of ['get', 'update', 'remove']) {
      assert.ok(hasParam(http(op)[1]), `${m.id}: ${op} 路由必须含 :param（要能定位单条）`);
    }
  }
});
```

### 这个检查为什么值得写

漏掉一个 CRUD 操作**不会自己冒出来**：模块照样能跑、别的测试照样绿，
直到某个用户想改一条记录时才发现"没这个功能"。
而「只在 CLI 有、HTTP 没有」（或反过来）更隐蔽——**一端验证过就以为做完了**。

顺带一个必须遵守的次序：`GET /api/X/:id` 与 `GET /api/X/status` 这类**字面量路径会互相遮蔽**。
别指望"先声明字面量"——那是靠人记住顺序。让路由**按「字面量段优先」排序**，
使声明顺序不影响匹配（见下节坑表）。

## 八、错误契约

```js
// core/errors.js
export const CODES = { INVALID_INPUT, NOT_FOUND, CONFLICT, BLOCKED, EXTERNAL, INTERNAL };
export class AppError extends Error { constructor(code, message, details) {...} }
export function httpStatusOf(code) { ... }   // 400 / 404 / 409 / 409 / 502 / 500
export function exitCodeOf(code) { ... }     // 统一 exit 1
```

**映射只写一处**。API 层按 code 出 HTTP 状态（不要一律 400），
CLI 层按 code 出退出码。上层拿 `err.code` 分支，而不是对错误文本做字符串匹配。

`--json` 的错误对象要**向后兼容**：`error` 保持字符串，`code` 是新增字段。

### 六个错误码的使用边界

`CODES` 里几个容易混的，各给一个判据和例子：

| code | 判据 | 例子 | HTTP |
| --- | --- | --- | --- |
| `INVALID_INPUT` | 输入本身不合法（格式、范围、缺失） | `--side` 传了 `oursx`；路径含 `..` | 400 |
| `NOT_FOUND` | 指定的目标不存在 | repo id 查不到；skill 不在中心仓库 | 404 |
| `CONFLICT` | **目标存在且与期望状态冲突，需要用户选一侧** | 同步时两侧都有且内容不同；重复登记同一路径 | 409 |
| `BLOCKED` | **操作本身合法，但被业务规则/前置条件挡住** | 删掉最后一个实体 skill 会导致项目内无实体，主动阻止 | 409 |
| `EXTERNAL` | 外部命令失败（git / gh / docker…） | `git fetch` 网络失败；`gh` 未登录 | 502 |
| `INTERNAL` | 兜底，未归类的异常 | —— | 500 |

`CONFLICT` 与 `BLOCKED` 都映射 409，区别在**用户的下一步动作**：
`CONFLICT` 是"你选哪边"，`BLOCKED` 是"你先去满足某个前置条件"。

### `{ status }` 的四个取值

| status | 含义 | 调用方该做什么 |
| --- | --- | --- |
| `ok` | 成功（含幂等跳过） | 继续 |
| `skipped` | 目标已是期望状态，什么都没做 | 继续（不是错误） |
| `conflict` | 需要用户决策 | 停止自动化，转人工 |
| `blocked` | 被规则挡住 | 报告原因，不做重试 |

CLI 的文本渲染要**分别**给出可读提示——四个取值都渲染成"完成"就失去意义了。

## 九、踩过的坑

| 坑 | 后果 | 正确做法 |
| --- | --- | --- |
| 同层并存 `throw` / `{ok:false}` / `{status}` 四种错误表达 | 上层只能靠字符串猜，agent 无法分支 | 统一为「抛异常 or 返回 status」二选一 |
| 业务冲突用异常表达 | 界面无法弹窗让用户选侧 | 冲突是**业务结果**，正常返回 |
| **路由占位符与 `args` 名字对不上** | 参数静默变成 `undefined` 传进 service（无 body 的 DELETE 尤其容易中招） | 写完一条 action 就对照检查名字；`required` 能兜住但报错位置会很靠后 |
| **「只有 body 里有才覆盖」式的绑定** | 无 body 的请求永远绑不上参数 | 无条件合并 路径 → query → body，再交给 `applySpec` 校验 |
| eslint 只抄了规则、没配 JSX parser | 所有 `.jsx` 直接 `Parsing error: Unexpected token '<'` | 用 [[00-design-and-verify]] 闸 1 的**完整**配置 |
| 前端禁用规则只覆盖 `web/frontend/**` | 真正写视图的 `view.jsx` 反而不受约束 | `files` 里同时列 `src/modules/**/view.jsx` |
| 视图里直接 `document.querySelector` 摸 DOM | 页面上有同名类时读错元素 | 用 ref |
| 懒加载视图没有错误边界 | 一个视图崩掉整页白屏，连切 tab 自救都不行 | ErrorBoundary 包在 Suspense 外 |
| 路由错误一律返回 400 | 前端无法区分 404 与冲突 | code → HTTP 状态唯一映射 |
| **`GET /api/X/status` 被 `GET /api/X/:id` 遮蔽** | 命中哪条取决于**声明顺序**；有人调整 actions 顺序就静默错乱，且只在特定路径上出现 | 路由按「字面量段优先」排序，让声明顺序无关；别靠"记得先声明字面量" |
| 资源模块漏了某个 CRUD 操作 | 模块照跑、测试照绿，直到用户想改一条记录才发现没这功能 | 声明 `resource` + 断言五操作齐备两端可调用（见第七节） |
| 断言写在 `MODULES.filter(m => m.resource)` 上却没有任何模块声明 | 检查静默地什么都不查，比没有检查更危险 | 同时断言 `resources.length > 0` |
| `update` 做成整体替换（PUT 语义） | 调用方每次都得先读全量再写回，并发修改被覆盖 | **PATCH 语义**：只改传入的字段，未传的保持原值 |
| `add` 遇到重复静默 upsert | 用户的"我以为没加过"永远得不到纠正，也无从发现拼错的路径 | 重复报 `CONFLICT`——这是有用的错误 |
| 非资源模块硬凑 CRUD | `system add` / `github update` 这种一看就是凑的，agent 也会困惑 | 先分类：只有「用户会想改/删其中一条」的才是集合资源 |
| CLI 报 NOT_FOUND 而 HTTP 报 400 | 同一个失败要在两个入口写两套处理 | 两端用同一个错误码 |
| `get` 只接受内部 id | agent 手里往往是人读的路径，只能先用 list 再过滤 | 定位方式放宽：id 与路径/名称都接受 |
