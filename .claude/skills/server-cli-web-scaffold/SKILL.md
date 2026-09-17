---
name: server-cli-web-scaffold
description: 快速初始化标准 server-cli-web 结构的项目——serve 驱动 CLI 与 Web 面板、CLI 与 API 同源、随包分发可安装 skill、带状态存储与 GitHub Actions 发版。当用户要求"新建一个 xxx 管理工具/面板"、"起一个 cli+web 项目"、"按脚手架模式建项目"、"搭一个带 web 面板的命令行工具"、"给我做个本机 xxx 管理器"，或需要给已有项目补齐 Web 面板、skill install 命令、状态存储、发版流水线时使用。触发词：脚手架、建项目、起个项目、server-cli-web、带面板的 CLI、管理面板、npx 工具、初始化项目。
---

# server-cli-web 脚手架

给"本机工具类项目"的标准骨架：**serve 驱动 CLI 与 Web，CLI 与 API 同源，skill 驱动 agent**。

参考实现：`nx-rh`（npx-repo-hub）。本 skill 的每条规范都在该项目上验证过，
包括踩过的坑——所以宁可照抄，不要即兴发挥。

## 什么时候用

- 要从零建一个"既有命令行、又有浏览器面板"的本机工具
- 已有 CLI，要补一个 Web 面板，且**不是**重写一遍业务逻辑
- 要做一个 `npx xxx` 可分发的工具，且希望 agent 能自己学会用它

不适用：纯 Web 应用、纯 CLI 脚本、需要多用户/远程部署的服务。

## 核心不变量（整个骨架的地基）

这三条决定了所有后续设计。**先理解，再动手。**

### 1. 一条 action 定义，三端同时暴露

不要在 CLI 里写一份命令表、在 API 里再写一份路由表——那就是两份会分叉的清单。
每个功能域声明一组 action，**每条同时声明 CLI 路径与 HTTP 路由**：

```js
{
  id: 'repo.add',
  cli: ['repo', 'add'],           // → xxx repo add <path>
  http: ['POST', '/api/repos'],   // → POST /api/repos
  summary: '登记一个仓库',         // → 自动进入 help
  args: ['path'],
  flags: { name: { type: 'string' } },
  run: (ctx) => service.addRepo(ctx),
  render: (r) => `已登记: ${r.name}`,   // CLI 人读模式；--json 走序列化
}
```

CLI 命令表、HTTP 路由表、`help` 文本全部由此派生。
**"Web 上能做的，CLI 都必须能做"** 由结构保证，不靠人记。

### 2. 依赖只能向下：`core ← modules ← runtime`

```
core/       零业务语义的基础设施（常量、存储、错误、文件、算法）
modules/    功能域，每个自包含：index.js(声明) + service.js(业务) + view.jsx(面板)
runtime/    装配层：把 action 表编译成 CLI 命令表与 HTTP 路由表，不写业务
web/        React 壳，只 import 各模块的 view.jsx
```

跨模块要共享的东西**一律下沉到 core**，不允许模块之间互相 import。
这条必须用 lint 强制，否则三次提交之后就没人记得了。

### 3. 失败抛异常，业务结果返回 `{ status }`

判定标准是**「调用方要不要处理它」**：

| 情形 | 表达 | 例子 |
|---|---|---|
| 失败：调用方无从处理，只能中断上报 | `throw` | 参数非法、目标不存在、外部命令挂掉 |
| 业务结果：调用方要拿它做决策 | `return { status: 'ok' \| 'skipped' \| 'conflict' \| 'blocked' }` | 冲突等待用户选侧、幂等跳过 |

冲突**不是错误**——界面要拿它弹窗让用户决策，所以不能抛。这个边界想不清楚，
上层就只能靠字符串匹配猜，agent 也没法可靠分支。

详细展开见 [[00-design-and-verify]]。

## 创建流程

按顺序做，每阶段做完能跑再进下一阶段。**不要一次性铺完再调**。

| 阶段 | 做什么 | 详读 |
| --- | --- | --- |
| 1. 定骨架 | 目录结构、`bin/` 唯一入口、`core/` 三件套（paths/store/errors） | [[01-bootstrap-serve-first]] |
| 2. 起 serve | `xxx serve` 能起一个只服务静态页的空壳面板 | [[01-bootstrap-serve-first]] |
| 3. 立 action 机制 | registry + spec + 通用 CLI 运行器 + 路由装配 | [[00-design-and-verify]] |
| 4. 写第一个功能域 | 一个真实的 modules/&lt;域&gt;，端到端跑通 CLI + API + 面板 | [[02-web-panel]] · [[03-cli-surface]] |
| 5. 接状态 | `~/&lt;主题名&gt;/store.json`，原子写 + 环境变量覆盖 | [[04-state-storage]] |
| 6. 上发布 | GitHub Actions，tag 幂等 + npm provenance | [[05-release-actions]] |

**阶段 3 是关键**：action 机制没立起来就写业务，后面每加一个功能都要改四处，
很快会退化成"两份清单"——那正是这个脚手架要避免的。

项目建起来之后，**每次加/改一个功能域**都是同一套动作的重复。
具体要碰哪几个文件、漏了哪一个会静默失效，见 [[06-extension-loop]]。

## ref 路由表（按需加载）

| ref | 何时读取 |
| --- | --- |
| [[00-design-and-verify]] | **立 action 机制时必读**——尤其第三节的 ctx 契约（CLI 参数与 HTTP 路由怎么合并成同一个 ctx，漏了会静默出错）。第七节讲 CRUD 完备性：一个模块该不该是 CRUD、五个操作各自的语义陷阱、以及怎么用断言钉住。其余讲项目自检：用 lint + 测试把依赖图和三端一致性钉死 |
| [[01-bootstrap-serve-first]] | 定工程骨架时；`serve` 到底该驱动什么、dev/prod 两种模式怎么分 |
| [[02-web-panel]] | 写面板时：视觉规范、状态持久化、点击复制、错误边界 |
| [[03-cli-surface]] | 定 CLI 对外契约时：`serve` 参数、`skill install`、`--json` 格式 |
| [[04-state-storage]] | 定存储时：放哪、怎么写不坏、怎么让测试不污染用户目录 |
| [[05-release-actions]] | 配发版流水线时：**用 gh 建仓库（默认公开）**、gh secret、npm token、tag 幂等；以及 push 之后怎么用 gh 盯住流水线 |
| [[06-extension-loop]] | **每次新增/修改一个功能域时必读**——闭环落点表（12 处，逐个标注「漏了会怎样、谁会发现」）、三处**没有任何断言**的静默失效点（`src/index.js` 导出 / eslint 互依禁列 / `assets/` 文档单向漂移）、以及怎么验证闸门本身真的会触发 |

## 验收清单

零知识开工前对照，交付前逐条确认：

- [ ] `bin/<name>.mjs` 是唯一可执行入口，其余全是模块
- [ ] `pnpm start` 能一条命令起面板；`serve` 支持 `--port` 与 `--no-open`
- [ ] 面板：无 emoji、黑白灰、响应式、状态持久化、路径/标识可点击复制
- [ ] CLI：有 `skill install`（装到 `~/.claude/skills`）、`assets/` 内有 skill、`--json` 输出纯 JSON
- [ ] 每个 Web 操作都有等价 CLI 命令，且有测试断言这条等价性
- [ ] 管理实体集合的模块声明了 `resource`，**CRUD 五操作齐备且两端都可调用**（见 [[00-design-and-verify]] 第七节）
- [ ] 非集合模块（配置 / 动作集合 / 外部连接器 / 聚合）**没有**被硬套成 CRUD，但仍满足两端可达
- [ ] 状态存 `~/<主题名>/`，可用环境变量覆盖（否则测试会写脏用户目录）
- [ ] 分层规则由 lint 强制，不是写在文档里的君子协定
- [ ] GitHub Actions 能在 push 后发版；secrets 缺失时**提示用户补**而不是静默失败
- [ ] 远端仓库由 `gh repo create` 建好（默认公开，且**执行前已告知用户**）
- [ ] push 之后用 `gh run watch --exit-status` 确认流水线真的成功，不留"发出去了吗"的悬念

**每次新增 / 修改一个功能域时**，按 [[06-extension-loop]] 第六节的闭环清单逐条过。
其中下面三处**没有任何断言会替你发现**，是最容易漏的：

- [ ] `src/index.js` 已导出新 service
- [ ] `eslint.config.js` 互依禁列已加 `../<新模块>/*`（枚举式，漏补静默）
- [ ] `assets/<skill>/` 已补新场景（**文档→代码有断言，代码→文档没有**）

## 错误案例

| 错误操作 | 实际后果 | 正确做法 |
| --- | --- | --- |
| 先写业务，后面再"补" action 机制 | 每加一个功能要改 4 处（flag 白名单 / help 文本 / switch / 渲染），很快退化成两份清单 | 阶段 3 先立机制，再写第一个功能域 |
| CLI 与 Web 各写一份命令/接口清单 | 必然分叉；面板上有按钮、CLI 里没命令，且没人发现 | 一条 action 同时声明 `cli` 与 `http` |
| 分层只写在 README 里 | 三次提交后失效，模块互相 import 成网 | 写成 eslint `no-restricted-imports` + 一致性测试 |
| 存储直接用默认路径 | 测试写脏用户的真实数据目录 | 存储路径支持环境变量覆盖，测试必须指向临时目录 |
| 面板与 CLI 传参形态不同（CLI 用 `--off`、面板传 `enabled:false`） | 同一语义两条调用路径，只测了一条 → 另一条静默失效 | 两条入口必须有**对照测试**断言走同一分支 |
| 声明了 `args:['ref']` 却没检查它与 `http` 的 `:ref` 同名 | 参数静默变成 `undefined` 传进 service（无 body 的 DELETE 尤其容易中招） | 写完一条 action 就对照名字，见 [[00-design-and-verify]] 的 ctx 契约表 |
| 用「目录名」的校验规则去卡文件路径 | 拒绝 `.gitignore` 这类正常文件 | 名称与路径分开校验；路径允许前导点 |
| 直接把 node 侧代码 import 进视图 | Vite 把 `node:` 内置模块打进浏览器包 | 前端只能 import 各模块的 `view.jsx`，用 lint 拦住 |
| 新模块忘补 eslint 的互依禁列 | **静默**：新模块变成「谁都可以依赖」，而那条禁列是逐模块枚举的，规则随模块数增加持续衰减 | 把「加模块必补禁列」写进 [[06-extension-loop]] 的闭环表；禁列旁留注释说明漏补是静默的 |
| 读命令的 flag 照抄写命令的 `default` | 参数层无条件注入默认值，「不传 = 全部」的分支**永远走不到**——不报错、不崩，只是永远返回半个结果 | 写命令的 flag 可带 `default`，读命令的过滤 flag 一律不带 |
| 加了命令但没写进 `assets/<skill>/` | **单向断言**只保证「文档提到的命令一定存在」，反方向不强制 → 漏写没有任何测试会红，而 agent 侧该命令等于不存在 | 更新 `assets/` 是闭环的**必做项**，不是「有空再补」 |
| lint 规则从没红过就当它没问题 | 规则写错（路径 glob 不匹配、files 没覆盖到 `view.jsx`）不会报错，只会永远通过——**一个从没红过的规则等于不存在** | 加/改 lint 规则后做一次反向测试：临时写个违例文件，确认退出码非 0 |

_最后更新：2026-09-17_

## 操作记录（key_board_3）

### 2026-09-17 · 新增 [[06-extension-loop]]

| 错误操作 | 实际后果 | 正确做法 |
| --- | --- | --- |
| 把「扩展闭环」当成创建流程的第 7 阶段，写进主文档的阶段表 | 主文档重新长出一块**场景级内容**——正是本 skill 自己列的「演化反模式」：主文档兼具原理与场景，此后每次扩展都会加深混乱 | 场景级内容一律下沉 ref；主文档只加**指针句 + 路由表一行**（本次放在「创建流程」表后的一句 + ref 路由表） |
| 把「更新 assets 里的 skill」读成「只改 skill 目录内的文件」 | 这个 skill 是**项目规范**，而它的参考实现就是 nx-rh 本身。只改规范不改参考实现，规范示范的东西在自己的样例里不存在 | 改规范时**同时检查参考实现那一侧**：本次即在 `assets/repo-hub/` 补了 `--dry-run` 契约与「手册不穷举命令、权威命令表看 `help --json`」的自我纠偏路径 |
| 先按散文写好 ref，再跑测试 | 结构断言（回链、路由表登记、章节编号连续、内容量）会一次性报一堆错，返工成本高 | **先读结构测试确定了约束再动笔**——本次先读了 `tests/unit/skill-docs.test.mjs` 的八条断言与 `docs-commands.test.mjs` 的命令/flag 抽取规则，一次通过 |
