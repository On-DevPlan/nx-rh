# nx-rh · npx-repo-hub

本机仓库登记与 Agent Skill 的管理中枢。一个 `npx` 命令起一个 Web 面板，
同时提供同构 CLI——**面板上的每个按钮，底层都是同一条 CLI 命令**，
输出 `--json` 即可被任何 agent 直接消费。

本项目同时用作 **server-web-cli 类项目的标准模板**：三端同源不是靠人维护两份清单，
而是由一份 action 声明派生，并由 lint 与测试强制。见 [架构](#架构action-三端同源)。

## 为什么不管 git

本工具**不做任何 git 操作**：没有 status / diff / pull / push / resolve 冲突。

这不是没做完，是主动砍掉的。上一版做过：把 git 的 porcelain 状态解析成
「分支 · 领先落后 · 变更 · 冲突」显示在面板上，还带行内 diff 与一键 pull/push。
结果是**半吊子**——用户看到「冲突 3 个文件」，点进去只能一行行读原始 diff 文本，
既没有 hunk 级的取舍，也没有 rebase/merge 策略、凭据、进度与失败恢复。
要做成能用的东西就得自己实现一个 git 客户端，而那件事有 IDE、有 git 自己、
有几十个成熟 GUI 在做，**永远做得比这里好**。

真正危险的不是功能少，而是**给出可信外观的错误结论**：面板上显示「干净」，
用户就不再跑 `git status` 了；而那是个只看了 porcelain 首行、没管 stash /
submodule / worktree / 未跟踪目录的实现。「看着像知道，实际不知道」比空白更糟。

所以边界划在这里：**本工具维护「有哪些仓库、在哪、干什么用」这份登记表**，
git 的事交给 git 自己。登记表是 git 给不了的东西——它跨仓库、带标签与描述，
让 agent 不必每次重新问「这个是哪个项目」。

## 快速开始

```bash
# 开发模式（本仓库内）
pnpm install
pnpm run dev          # 前端热更新 :5180（/api 代理到 :7800）
pnpm run dev:serve    # 只起后端 :7800，不自动开浏览器
pnpm run build        # 构建前端到 src/web/public
pnpm start            # 构建 + 起面板

# 发布为 npm 包后
npx nx-rh serve

# 校验：lint + 构建 + 端到端冒烟 + 单元/一致性测试
pnpm test
```

## 架构：action 三端同源

```
┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│  Web 面板     │   │   agent CLI  │   │  HTTP API    │
│ React + Vite │   │   nx-rh ...  │   │  /api/*      │
└───────┬──────┘   └───────┬──────┘   └───────┬──────┘
        │                  │                  │
        └──────────────────┼──────────────────┘
                           ▼
        ┌──────────────────────────────────────────┐
        │  action 声明（每个功能域的 index.js）      │
        │  { cli: [...], http: [...], run, render } │
        └──────────────────┬───────────────────────┘
                           ▼
        ┌──────────────────────────────────────────┐
        │  service 层（唯一业务真相源）              │
        └──────────────────┬───────────────────────┘
                           ▼
        ┌──────────────────────────────────────────┐
        │  core：存储 / diff / 文件树 / 错误         │
        └──────────────────────────────────────────┘
```

**一条 action 同时声明 CLI 命令路径与 HTTP 路由**，二者写在同一处：

```js
// src/modules/repos/index.js
{
  id: 'repo.add',
  cli: ['repo', 'add'],           // → nx-rh repo add <path>
  http: ['POST', '/api/repos'],   // → POST /api/repos
  summary: '登记一个仓库',         // → 自动进入 nx-rh help
  args: ['path'],
  flags: { name: { type: 'string' }, tags: { type: 'array' } },
  run: (ctx) => service.addRepo(ctx),
  render: (r) => `已登记: ${r.name} -> ${r.path}`,
}
```

CLI 命令表、HTTP 路由表、`nx-rh help` 文本全部由此派生。**没有手写的命令清单**，
所以三端不可能分叉，`BOOL_FLAGS` 之类的全局硬编码也无从产生。

### 核心不变量

1. **Web 上的每个操作都必须有 CLI 等价。** 由结构保证，外加
   `tests/unit/registry.test.mjs` 的三张表对齐断言。方向刻意不对称：
   每条 action 必须有 `cli`；`http` 允许为 `null`（纯 CLI 命令），反之不允许。
2. **失败抛异常，业务结果返回 `{ status }`。** 判定标准是「调用方要不要处理它」——
   迁移遇到冲突需要用户决定是否覆盖，所以它返回 `{ status: 'conflict' }` 而不是抛错。
3. **依赖只能向下**：`core ← modules ← runtime`，由 `eslint.config.js` 的
   `no-restricted-imports` 强制，改坏会被 lint 当场拦下。

### 目录结构

```
bin/cli.mjs              # 唯一可执行入口
src/
  index.js               # 库入口（导出各模块 service，供程序化调用）
  core/                  # 零业务语义的基础设施
    paths.js             # 常量、存储路径、名称/路径安全校验
    errors.js            # AppError + code→HTTP/exit 的唯一映射点
    store.js             # JSON 存储：原子写 + mtime 失效检测
    diff.js              # LCS 行级 diff + unified 输出 + diff3-lite 三方合并
    fstree.js            # 存在性、md5、目录树差异
    frontmatter.js       # SKILL.md frontmatter 解析
    link.js              # 目录链接创建与识别（junction / symlink）
    open.js              # 打开浏览器 / 文件管理器
    envvars.js           # 环境变量平台驱动（PowerShell ↔ Windows 注册表；posix 位置已预留）
  modules/               # 功能域，每个自包含
    system/              # bootstrap / health（聚合模块，无视图）
    repos/  skills/  settings/  env/  bundled/
      index.js           #   action 声明（CLI + HTTP + help）
      service.js         #   业务逻辑
      view.jsx           #   面板视图
  runtime/               # 装配层
    registry.js          # 模块注册表 + 装载期自检
    spec.js              # action 规格：校验、强转、路由编译、用法串生成
    cli.js               # 通用 CLI 运行器（解析 → 匹配 → 校验 → 渲染）
    api.js               # HTTP 路由（由 action.http 编译）
    server.js            # node:http 静态 + /api 委派
  web/
    frontend/            # React 源码（Vite root）
      registry.js        # 视图注册表（新增面板 = 写组件 + 登记一行）
      App / store / components / api/client
    public/              # vite build 产物（gitignore）
assets/repo-hub/         # 随包发布的 agent 使用说明
tests/
  smoke.mjs              # 端到端：CLI 全链路 + HTTP API + 静态页
  unit/                  # 单元测试 + 注册表一致性断言
```

前端约定：无 emoji、黑白清晰、正常圆角；不用浏览器原生弹窗（alert/confirm/prompt
一律页内 toast/dialog）；用户选择（当前视图、订阅源/项目路径、多选勾选）全部
localStorage 持久化，刷新不丢。

## 存储

`~/.nx-rh/store.json`（`NX_RH_STORE` 环境变量或 `--store` 可覆盖）：

```json
{
  "version": 2,
  "settings": {
    "skillHubPath": "D:/a_other/md/sl/skills",
    "skillSyncMode": "symlink",
    "platforms": ["claude-code", "workbuddy"],
    "defaultPlatform": "claude-code",
    "skillHubSources": ["D:/a_other/md/sl/skills"],
    "skillProjectCandidates": []
  },
  "repos": [
    {
      "id": "r_xxx",
      "name": "nx-rh",
      "path": "D:/code/js/proj/nx-rh",
      "desc": "仓库登记与 Skill 中枢",
      "tags": ["tool"],
      "notes": "",
      "addedAt": "...",
      "updatedAt": "..."
    }
  ],
  "recents": [
    { "scope": "d:\\a_js\\js_proj\\nx-rh", "path": "D:/a_js/js_proj/nx-rh", "lastUsedAt": "..." }
  ]
}
```

> `recents` 是**全局跨作用域**的「最近项目」列表（最多 20 条，最近在前），
> 与按 cwd 隔离的数据并存——面板的项目下拉由它驱动。

> `version: 1` 的旧键（`skillCentralPath` / `skillCentralCandidates`）在读取时自动平移为
> `skillHubPath` / `skillHubSources`，无需手工迁移。

## CLI 命令总表

全部命令都支持 `--json`（机器可读输出，供 agent 消费）。
这张表与 `nx-rh help` 的输出同源，均自动生成——**不需要手工维护**。

| 命令 | 对应 Web 操作 |
| --- | --- |
| `nx-rh serve [dir] [--port N] [--no-open]` | 启动面板（`dir` = 启动目录，默认当前目录） |
| `nx-rh help [模块]` / `version` / `bootstrap` / `health` | — |
| `nx-rh routes [--module M] [--http "METHOD /api/path"]` | 命令 ↔ 路由对照；`--http` 可由端点反查命令 |
| `nx-rh recents` / `recents add <目录>` / `recents remove <目录>` | 最近项目列表 / 登记 / 移除（面板项目下拉的数据源） |
| `nx-rh repo list` | 仓库页：清单 |
| `nx-rh repo get <id\|path>` | 单条登记信息 |
| `nx-rh repo add <path> [--name N] [--desc D] [--tags a,b] [--notes T]` | 添加仓库 |
| `nx-rh repo update <id> [...]` | 编辑登记（含 `--path` 改路径） |
| `nx-rh repo remove <id>` | 删除登记（不动磁盘） |
| `nx-rh repo scan <root> [--depth 3]` | 扫描目录发现仓库 |
| `nx-rh repo open <id>` | 在文件管理器中打开 |
| `nx-rh skill adapters [--project <目录>]` | 平台清单 + 每平台的**项目级 / 用户级绝对落点** |
| `nx-rh skill list [--source <路径>] [--project <项目根>] [--long]` | 零启动盘点：名称 / 来源目录 / 描述（`--long` 完整）+ 迁移状态 + 未入 Hub |
| `nx-rh skill show <name> [--project <项目根>]` | 完整描述 + 目录 + 各平台落点与形态 |
| `nx-rh skill cat <name> [--ref <相对路径>]` | 输出订阅源 skill 全文，供外部 agent 获取上下文 |
| `nx-rh skill add <name> [--description 文本] [--content 全文]` | 新建 skill（写入当前订阅源；同名 → CONFLICT） |
| `nx-rh skill update <name> --content <全文>` | 改写 SKILL.md（须含 name/description frontmatter） |
| `nx-rh skill remove <name> [--force]` | 删除 skill（目标侧还有引用时 blocked） |
| `nx-rh skill get [name] [ref] [--to DIR]` | 内置手册三段导出（prefix + sentinel + 正文 + install 状态），并顺手安装 |
| `nx-rh skill migrate\|adapt <name...> --to global\|user\|project\|all [--platform P] [--mode symlink\|copy]` | 订阅源 → 平台目录（目的仓库直接覆盖；`--platform` 可用别名 `claude` / `wb` / `cursor`） |
| `nx-rh skill migrate --all [--include 模式] [--exclude 模式] [--match 描述词] [--dry-run]` | 批量迁移：全量 / 取子集 / 排除个别 / 按描述挑；`--dry-run` 只出计划不落盘 |
| `nx-rh skill unmigrate <name...> --to global\|user\|project\|all [--platform P] [--force]` | 撤销迁移（迁移可逆；实体副本需 `--force`）；同样支持 `--all/--exclude/--dry-run` |
| `nx-rh skill submit <name...> [--to project] [--all] [--exclude 模式] [--dry-run]` | 平台副本 → 订阅源；`--all` 一次收掉所有「未入 Hub」的 skill |
| `nx-rh skill submit <name> [--to project] [--platform P] [--force]` | 平台副本 → 订阅源，随后删除目标实文件 |
| `nx-rh skill materialize <name> --to user\|project [--platform P]` | 链接转实体 |
| `nx-rh skill merge --base F --a F --b F` | diff3 合并原语 |
| `nx-rh skill hub list\|add\|remove\|<path>` | 订阅源清单 / 订阅 / 取消订阅 / 切主源 |
| `nx-rh skill hub check` | 来源健康诊断：目录缺失 / 空源 / 嵌套订阅 / 重复根 / 跨源同名冲突 |
| `nx-rh skill project list\|add\|remove <path>` | 项目目录候选 |
| `nx-rh skill platform [ids...]` | 启用的平台范围 / 默认平台 |
| `nx-rh setting get [key]` / `setting set k=v [k2=v2 ...]` | 设置页 |
| `nx-rh env status` | 环境变量页：能力横幅（平台 / 提权 / 两个 scope 可否写） |
| `nx-rh env list [--scope user\|system]` | 变量表（不带 scope 则合并两 scope 并标注遮蔽与拼接） |
| `nx-rh env get <name>` | 单变量详情（两个 scope 的值 + 生效判断） |
| `nx-rh env set <name> [<value>] [--scope S] [--kind string\|expand] [--dry-run] [--no-notify]` | 编辑 / 新增变量 |
| `nx-rh env remove <name> [--scope S] [--dry-run]` | 删除变量 |
| `nx-rh env path list [--scope S]` | PATH 条目列表 |
| `nx-rh env path add <dir> [--scope S] [--first] [--dry-run]` | PATH 追加一行 |
| `nx-rh env path remove <dir> [--scope S] [--dry-run]` | PATH 移除一行 |
| `nx-rh env snapshot list` / `save [label]` / `restore <id> [--dry-run]` | 快照与回滚 |
| `nx-rh bundled list` / `skill install [name] [--to DIR] [--force]` | 内置 skill 包 |

> `env` 模块是唯一改**操作系统状态**而非本仓库状态的模块：它读写 Windows 注册表里的
> 持久化环境变量（用户级 `HKCU\Environment` / 系统级 `HKLM\...\Session Manager\Environment`）。
> 因此它的每条写命令都有 `--dry-run`，且写入前会自动快照到 `~/.nx-rh/env_snapshots/`。
> 系统级写入需要以管理员身份运行；未提权时系统级只读。仅支持 Windows（其余平台返回
> 可分类的 `BLOCKED`，不假装成功）。

REST API 与命令**严格一一对应**：每条路由都由某条 action 的 `http` 字段声明，
而该 action 必然带有 `cli`。例如 `POST /api/skills/migrate` ⇔ `nx-rh skill migrate`。
面板底部的「CLI 等价」提示也是由这张表渲染的，不会与实际命令脱节。

这张对照表**双向可查**，agent 不必靠猜：

```bash
nx-rh routes                              # 全量对照表
nx-rh routes --module repos               # 按模块过滤
nx-rh routes --http "POST /api/skills/migrate"  # 反向：有端点，查该敲哪条命令
nx-rh routes --json                       # 含每条的完整签名（位置参数与 flag）
```

反向查找复用路由编译时的正则，所以带参路由也能匹配具体实例
（`DELETE /api/repos/r_abc` → `nx-rh repo remove`）。
`http: null` 的命令（如 `setting get`）会如实标注为「仅 CLI」。

> `repo` 模块只管登记（路径 / 名称 / 描述 / 标签 / 备注 / 扫描发现），
> 不含任何 git 操作——原因见上面的[「为什么不管 git」](#为什么不管-git)。

> Git Bash 注意：`--http /api/x` 这种以 `/` 开头的值会被 MSYS 改写成 Windows 路径。
> 加上方法前缀（`--http "GET /api/x"`）或设 `MSYS_NO_PATHCONV=1` 即可。

## 如何新增功能域

模板价值最高的部分。下面是完整清单：

```bash
# 1. 建模块目录
src/modules/<name>/
  index.js     # action 声明 + id/title/order/view
  service.js   # 业务逻辑（不认识 argv，也不认识 HTTP）
  view.jsx     # 面板视图（无需面板则 view: null）

# 2. 在后端注册表登记
#    src/runtime/registry.js  → import + 加进 MODULES

# 3. 在前端视图注册表登记
#    src/web/frontend/registry.js → 加一行

# 4. 校验
pnpm test      # 漏登记会被 tests/unit/registry.test.mjs 断言拦下
```

**不需要改**：CLI 分发、help 文本、HTTP 路由表、参数解析。
新增一条操作只需在所属模块的 `actions` 数组里加一项。

## 启动目录与作用域

**在哪个目录运行，哪个目录就是当前项目**——不需要额外配置：

- `nx-rh serve [dir]`：把 `dir`（缺省 = 当前目录）注入为面板的「当前项目」，
  面板首屏就停在那里；`skill migrate` 等命令不传 `--project` 时落点也是它
- `nx-rh recents`：全局跨项目的「最近目录」列表（`recents add` / `recents remove`），
  与按 cwd 隔离的数据并存——**面板的项目下拉由它驱动**，切过的项目自动出现在里面
- **一个面板管所有项目**：`serve` 前先探测该端口上的 `/api/health`，若 `cwdScope` 字段在
  （那是本工具独有的响应形状）说明已是 nx-rh 的面板 → 只把当前目录登记进 recents、
  打开浏览器后退出，**不再起第二个进程**。每个项目开一个端口会让「切项目」变成「切端口」
- **面板右上角「最近目录」**：每次 `serve` 自动登记当前目录，也可手动「＋ 注册其他目录」；
  点击即切换激活目录——**项目级信息只针对激活的那个项目**，切换后面板整页按新作用域重拉。
  写请求带 Origin 校验：浏览器跨站写请求被拒（BLOCKED），本机程序（curl / agent）不受影响
- **作用域零侵入**：面板切换项目时按 `x-nx-rh-scope` 头回传目录，`core/als.js` 用
  `AsyncLocalStorage` 把它铺到整条请求链上，`projectRoot()` 随之改变——业务 action 一行不改

```bash
nx-rh serve D:/code/proj/a      # A 目录起面板
cd D:/code/proj/b && nx-rh serve # 同端口探测到已有面板 → 登记 B 并打开它（不起第二个）
nx-rh recents                   # 两个项目都在列表里，面板上直接切
```

> 与参考实现（脚手架 ref B03）的差异：本项目的业务数据（仓库登记 / 订阅源 / 设置）是
> **全局共享**的，没有「按项目隔离的集合」，所以只落地了 cwd 作用域 + recents + 单面板多项目；
> `store.json` 里没有 `scopes` 分桶。

## 内置 skill：nx-rh

包内自带一个可直接装进 agent 的 skill（**目录名 = 包名**，见脚手架规范 A03 §二），用于让 agent 学会用 nx-rh 管仓库与 skill：

```bash
nx-rh skill install                 # 装到 ~/.claude/skills/nx-rh
nx-rh skill install --to <dir>      # 换目标目录（如项目级 .claude/skills）
nx-rh bundled list                  # 看包内有哪些内置 skill（别名：skill install --list）
nx-rh skill install --force         # 目标已存在且不同时覆盖
nx-rh skill get                     # 三段导出：prefix + sentinel + SKILL.md 全文 + install 状态
nx-rh skill get nx-rh skill-hub     # 裸名 ref → references/skill-hub.md
```

- 安装是**三态**的：不存在 → 安装；存在且一致 → `skipped`；存在且不同 → `conflict` 列文件清单（须显式 `--force`）
- 结构遵循渐进式披露：主 `SKILL.md` 只放**核心原则 + ref-map**，场景细节全部在 `references/`（`repo-registry` / `skill-hub` / `env-manage` / `agent-workflow`）
- 扩展方式：新增 `assets/nx-rh/references/<场景>.md` 并在主文档路由表补一行「何时读取」
- `skill get` 与 `skill install` 是**互补能力**：install 让本机 agent 学得会用，get 让**不读
  `~/.claude/skills` 的外部 agent**一键拿全上下文；`get` 永远给文档，目标端 conflict 只作为附带信息返回
- 旧名 `repo-hub` 仍可作为 `--name` 别名使用
- Web 面板「Skill」页底部「内置手册」区块：导出上下文 / 安装到本机

## Skill 订阅与迁移

**订阅制**：唯一的可信源是订阅源（Skill Hub，即你的 skill 仓库目录）；平台目录（`.claude/skills`、
`.workbuddy/skills` 等）只是被迁移过去的落地副本。方向只有两条——订阅源 → 目标（`migrate`）、
目标 → 订阅源（`submit`）；**不做项目之间互迁**。

```
订阅源（Skill Hub）  <src>/<name>/SKILL.md              ← 唯一实文件
目标（迁移落点）      user:    ~/<platform.globalDir>/<name>
                     project: <启动目录>/<platform.dir>/<name>
```

- **订阅源可多个、可重叠**：`skill hub add/remove/list` 维护；每个 skill 在列表里标注来源
- **启动目录注入**：`nx-rh serve [dir]` 与 CLI 的当前目录即「项目根」，面板默认打开它；`--project` 可覆盖
- **识别**：扫描源与目标目录，解析每个 `SKILL.md` 的 frontmatter（name/description）、算 md5、识别链接形态（symlink / junction / 实体）
- **迁移形态**：
  - `symlink`（默认）——目标放一个指向订阅源的链接。Windows 用 **junction**（无需管理员/开发者模式），POSIX 用**相对路径**符号链接（整目录搬迁不断链）。链接失败自动降级为复制，不中断操作。
  - `copy`——整目录复制（`dereference`，远端软链解引用成实体文件）。
- **冲突检测只在订阅源之间**：订阅源是唯一可信源，来源之间本不该有冲突——同名实文件出现在
  多个订阅源且内容不同 = 订阅配置问题（嵌套订阅 / 重复订阅 / 两个仓库各放一份），`skill hub check`
  诊断（目录缺失 / 空源 / 嵌套 / 重复根 / 跨源冲突），迁移会 `blocked`，可用 `--source <路径>` 指定用哪一份
- **目的仓库不做冲突检测，直接被订阅源覆盖**：目标只是落地副本，hub 里永远有一份，覆盖可恢复；
  删除（unmigrate）才需要 `--force`。来源侧扫描只认**实文件**——源目录里的链接是别处的落地副本，
  不算来源，也不制造假冲突
- **提交**：`skill submit` 把平台目录里的实体 skill 收进订阅源，然后**删除目标实文件**并改回链接——收敛「唯一实文件 = 订阅源」
- **物化**：链接 → 实体副本（断开与订阅源的实时同步）
- **零启动盘点**：`skill list`（`--long` 看完整描述与 skill 目录）/ `skill show <name>`（平台 × 作用域的落点矩阵）/
  `skill adapters`（每个平台的项目级与用户级绝对路径）——不起面板就能判断「这个 skill 能不能在 X 平台上用、该放到哪」
- **平台别名**：`--platform claude` / `wb` / `cursor` / `gemini` / `universal` 等价于对应 id；
  `skill adapt` 是 `skill migrate` 的别名（口语说法：把一个 skill 变成 .cursor）
- **迁移可逆**：`migrate` ⇄ `unmigrate` 参数完全对称；`--to global`（= `user`）与 `--to project` 覆盖全局与项目化两端
- **批量与精筛**：`--all` 全量、`--include <模式>` 取子集、`--exclude <模式>`（支持 `*`）排掉个别、
  `--match <关键词>` 按 **描述** 挑（agent 依业务需求选，而不是翻页手点）；`--dry-run` 先出计划不落盘
- 面板对应：行首勾选 + 「→项目 / →用户 / 撤销勾选 / 提交未入 Hub」，未勾选时前两个即全量（弹窗确认）
- **给外部 agent 上下文**：`skill cat <name>` 输出订阅源 skill 全文（SKILL.md 或某个 ref）；
  内置手册走 `skill get`（三段拼接 + 顺手安装），见下节
- **三方合并**：`skill merge --base --a --b` 暴露 diff3-lite 原语（`core/diff.js`）：仅单侧变更的区域自动采用；双侧相同自动取一；双侧不同输出 `<<<<<<< / ======= / >>>>>>>` 冲突块
- **防护**：skill 名称校验拒绝路径穿越；链接创建前做 realpath 自指检测（防止误删源目录）；父目录为链接时先解析真实父目录再计算相对目标；路径同一性比较走 `realpath`（原因见 `core/link.js` 的 `sameRealPath` 注释）

### 适配器

预设平台目录（`src/modules/skills/adapters.js` 的 `ADAPTERS` 表，表驱动、可加行）：

| 平台 | 项目级目录 | 用户级目录 | universal |
| --- | --- | --- | --- |
| Claude Code | `.claude/skills` | `~/.claude/skills` | |
| WorkBuddy | `.workbuddy/skills` | `~/.workbuddy/skills` | |
| Universal (.agents) | `.agents/skills` | `~/.agents/skills` | 是 |
| CodeBuddy | `.codebuddy/skills` | `~/.codebuddy/skills` | |
| Cursor | `.cursor/skills` | `~/.cursor/skills` | |
| Codex | `.codex/skills` | `~/.codex/skills` | |
| Gemini CLI | `.gemini/skills` | `~/.gemini/skills` | |
| GitHub Copilot | `.copilot/skills` | `~/.copilot/skills` | |
| Windsurf | `.windsurf/skills` | `~/.codeium/windsurf/skills` | |
| iFlow CLI | `.iflow/skills` | `~/.iflow/skills` | |

默认聚焦 claude-code 与 workbuddy；落点规则：`--platform` 指定 > 设置里的平台范围（首个为默认平台）。

## 设计约定

- **三端同源**：一条 action 声明驱动 CLI、HTTP、面板；不写第二份命令清单。
- **划定边界，而不是补齐功能**：砍掉 git 客户端、GitHub 连接器都遵循同一条标准——
  这件事我们做得比现有工具好吗？做不到就不做，半吊子会给用户「可信的错误结论」。
- **无 emoji**：面板、CLI 输出、代码注释全程无 emoji。
- **黑白清晰**：单色 CSS（黑字白底、粗边框、悬停反色），系统字体，路径与 diff 用等宽字体。
- **agent 优先**：所有写操作幂等或显式报错；错误以 `exit code 1 + 可解析文本` 返回；
  `--json` 输出无 ANSI、无多余文本，外层恒为 `{ ok, data }` / `{ ok: false, error, code }`。
- **零运行时依赖**：生产依赖只有 react/react-dom；服务端只用 Node 内置模块，离线可跑。

## 参考项目

- [vercel-labs/skills](https://github.com/vercel-labs/skills) —— skill 链接算法与 85+ 平台适配表（提炼笔记见 `.claude/nx-rh-skill-reference.md`）
- [typicode/json-server](https://github.com/typicode/json-server) —— npx + JSON 文件 + REST 的最小参考
- [javimosch/adminer-node](https://github.com/javimosch/adminer-node) —— node:http 零框架 + 路由注册表 + 用户目录 config 的面板模式

## 路线图

- 订阅源的增量索引缓存（当前每次列表全量扫描，源多时会有重复 stat）
- 上次迁移快照缓存，让 skill 侧也能走真正的三方合并
- 把 `modules/` 的注册从显式列表改为目录扫描（当前保留显式是为了可 grep、可断点，
  且前端受打包约束做不到同等自动）

## License

MIT
