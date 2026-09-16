# nx-rh · npx-repo-hub

本机 git 仓库与 Agent Skill 的管理中枢。一个 `npx` 命令起一个 Web 面板，
同时提供同构 CLI——**面板上的每个按钮，底层都是同一条 CLI 命令**，
输出 `--json` 即可被任何 agent 直接消费。

本项目同时用作 **server-web-cli 类项目的标准模板**：三端同源不是靠人维护两份清单，
而是由一份 action 声明派生，并由 lint 与测试强制。见 [架构](#架构action-三端同源)。

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

# 校验：lint + 构建 + 66 项端到端冒烟 + 43 项单元/一致性测试
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
        │  core：存储 / git / diff / 文件树 / 错误   │
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
   同步遇到冲突需要用户选侧，所以它返回 `{ status: 'conflict' }` 而不是抛错。
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
    git.js               # git CLI 封装
    diff.js              # LCS 行级 diff + unified 输出 + diff3-lite 三方合并
    fstree.js            # 存在性、md5、目录树差异
    frontmatter.js       # SKILL.md frontmatter 解析
    link.js              # 目录链接创建与识别（junction / symlink）
    open.js              # 打开浏览器 / 文件管理器
  modules/               # 功能域，每个自包含
    system/              # bootstrap / health（聚合模块，无视图）
    repos/  skills/  settings/  github/  bundled/
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
一律页内 toast/dialog）；用户选择（当前视图、中心/项目路径、多选勾选）全部
localStorage 持久化，刷新不丢。

## 存储

`~/.nx-rh/store.json`（`NX_RH_STORE` 环境变量或 `--store` 可覆盖）：

```json
{
  "version": 1,
  "settings": {
    "skillCentralPath": "D:/skills-central",
    "skillSyncMode": "symlink",
    "platforms": ["claude-code"],
    "defaultPlatform": "claude-code",
    "skillCentralCandidates": [],
    "skillProjectCandidates": []
  },
  "repos": [
    {
      "id": "r_xxx",
      "name": "nx-rh",
      "path": "D:/code/js/proj/nx-rh",
      "tags": ["tool"],
      "notes": "",
      "addedAt": "...",
      "updatedAt": "..."
    }
  ],
  "skillGroups": [{ "id": "ungrouped", "name": "未分组", "skills": [] }]
}
```

## CLI 命令总表

全部命令都支持 `--json`（机器可读输出，供 agent 消费）。
这张表与 `nx-rh help` 的输出同源，均自动生成——**不需要手工维护**。

| 命令 | 对应 Web 操作 |
| --- | --- |
| `nx-rh serve [--port N] [--no-open]` | 启动面板 |
| `nx-rh help [模块]` / `version` / `bootstrap` / `health` | — |
| `nx-rh routes [--module M] [--http "METHOD /api/path"]` | 命令 ↔ 路由对照；`--http` 可由端点反查命令 |
| `nx-rh repo list` | 仓库页：清单 |
| `nx-rh repo get <id>` | 单条登记信息（不跑 git） |
| `nx-rh repo add <path> [--name N] [--desc D] [--tags a,b] [--notes T]` | 添加仓库 |
| `nx-rh repo update <id> [...]` | 编辑登记 |
| `nx-rh repo remove <id>` | 删除登记（不动磁盘） |
| `nx-rh repo scan <root> [--depth 3]` | 扫描目录发现 git 仓库 |
| `nx-rh repo status [id]` | 刷新状态 |
| `nx-rh repo diff <id> [--file F]` | 行内 diff 按钮 |
| `nx-rh repo pull <id>` / `push <id>` | 行内 pull/push 按钮 |
| `nx-rh repo resolve <id> --file F --side ours\|theirs` | 冲突文件落地 |
| `nx-rh repo open <id>` | 在文件管理器中打开 |
| `nx-rh skill adapters` | 适配器清单 |
| `nx-rh skill list --side central\|project [--path P]` | 识别两侧 |
| `nx-rh skill sync <name> --project P [--mode symlink\|copy] [--adapter A] [--force]` | 同步到项目 |
| `nx-rh skill push <name> --project P [--force]` | 推送到中心 |
| `nx-rh skill conflict <name> --project P` | 冲突详情 |
| `nx-rh skill apply <name> --project P --file F --side central\|project` | 冲突弹窗里的「用中心版/用项目版」 |
| `nx-rh skill materialize <name> --project P` | 链接转实体 |
| `nx-rh skill remove <name> --project P` | 删除项目侧 skill |
| `nx-rh skill platform-status <name> --project P` | 单 skill 的平台形态查询 |
| `nx-rh skill platform-set <name> --project P --adapter A [--off]` | 平台小按钮开关 |
| `nx-rh skill compare --project P [--central C] [--names a,b]` | 多选比较 |
| `nx-rh skill merge --base F --a F --b F` | diff3 合并原语 |
| `nx-rh skill central list\|add\|remove\|<path>` | 中心仓库候选与当前项 |
| `nx-rh skill project list\|add\|remove <path>` | 项目目录候选 |
| `nx-rh skill platform [ids...]` | 默认平台范围 / 默认平台 |
| `nx-rh setting get [key]` / `setting set k=v [k2=v2 ...]` | 设置页 |
| `nx-rh gh status` / `view <owner/repo>` / `search <q> [--limit N]` / `mine [--limit N]` | GitHub 页 |
| `nx-rh bundled list` / `skill install [name] [--to DIR] [--force]` | 内置 skill 包 |

REST API 与命令**严格一一对应**：每条路由都由某条 action 的 `http` 字段声明，
而该 action 必然带有 `cli`。例如 `POST /api/skills/sync` ⇔ `nx-rh skill sync`。
面板底部的「CLI 等价」提示也是由这张表渲染的，不会与实际命令脱节。

这张对照表**双向可查**，agent 不必靠猜：

```bash
nx-rh routes                              # 全量对照表
nx-rh routes --module repos               # 按模块过滤
nx-rh routes --http "POST /api/skills/apply"   # 反向：有端点，查该敲哪条命令
nx-rh routes --json                       # 含每条的完整签名（位置参数与 flag）
```

反向查找复用路由编译时的正则，所以带参路由也能匹配具体实例
（`DELETE /api/repos/r_abc` → `nx-rh repo remove`）。
`http: null` 的命令（如 `setting get`）会如实标注为「仅 CLI」。

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

## 内置 skill：repo-hub

包内自带一个可直接装进 agent 的 skill，用于让 agent 学会用 nx-rh 管仓库与 skill：

```bash
nx-rh skill install                 # 装到 ~/.claude/skills/repo-hub
nx-rh skill install --to <dir>      # 换目标目录（如项目级 .claude/skills）
nx-rh bundled list                  # 看包内有哪些内置 skill（别名：skill install --list）
nx-rh skill install --force         # 目标已存在且不同时覆盖
```

- 安装是**三态**的：不存在 → 安装；存在且一致 → `skipped`；存在且不同 → `conflict` 列文件清单（须显式 `--force`）
- 结构遵循渐进式披露：主 `SKILL.md` 只放**核心原则 + ref-map**，场景细节全部在 `references/`（`repo-ops` / `skill-sync` / `agent-workflow`）
- 扩展方式：新增 `assets/repo-hub/references/<场景>.md` 并在主文档路由表补一行「何时读取」
- Web 面板「Skill」页有对应按钮（`安装 repo-hub skill`），等价于上述命令

## Skill 同步

两侧模型：`{中心仓库}/<name>` ⇄ `{项目}/<适配器目录>/<name>`。

- **中心仓库根目录下直接就是 skill**（不再要求 `skills/` 子目录；旧布局仍可读兼容）
- **中心仓库和项目目录都是多选候选**：`skill central add/remove/list`、`skill project add/remove/list`，Web 上下拉切换、多选比较
- **平台开关**：设置里选默认平台，项目侧每个 skill 显示一排平台小按钮，勾选即"给该平台提供这个 skill"（写入对应适配器目录），取消勾选即移除该平台下的副本/链接

- **识别**：扫描两侧目录，解析每个 `SKILL.md` 的 frontmatter（name/description），计算 md5，识别链接形态（symlink / junction / 实体）。
- **同步模式**：
  - `symlink`（默认）——项目侧放一个指向中心目录的链接。Windows 用 **junction**（无需管理员/开发者模式），POSIX 用**相对路径**符号链接（整目录搬迁不断链）。链接失败自动降级为复制，不中断操作。
  - `copy`——整目录复制（`dereference`，远端软链解引用成实体文件）。
- **冲突**：目标为实体且与中心 md5 不一致时返回 `conflict`（逐文件差异 + diff 文本），必须 `--force` 覆盖，或 `skill apply` 按文件选侧。不会静默删改用户目录。
- **物化**：链接 → 实体目录的独立复制（断开与中心的实时同步）。
- **三方合并**：`skill merge --base --a --b` 暴露 diff3-lite 原语（`core/diff.js`）：仅单侧变更的区域自动采用；双侧相同自动取一；双侧不同输出 `<<<<<<< / ======= / >>>>>>>` 冲突块。
- **防护**：skill 名称校验拒绝路径穿越；链接创建前做 realpath 自指检测（防止误删源目录）；父目录为链接时先解析真实父目录再计算相对目标；路径同一性比较走 `realpath`（原因见 `core/link.js` 的 `sameRealPath` 注释）。

### 适配器

预设平台目录（`src/modules/skills/adapters.js` 的 `ADAPTERS` 表，表驱动、可加行）：

| 平台 | 项目级目录 | universal |
| --- | --- | --- |
| Claude Code | `.claude/skills` | |
| Universal (.agents) | `.agents/skills` | 是 |
| Cursor | `.cursor/skills` | |
| Codex | `.codex/skills` | |
| Gemini CLI | `.gemini/skills` | |
| GitHub Copilot | `.copilot/skills` | |
| Windsurf | `.windsurf/skills` | |
| CodeBuddy | `.codebuddy/skills` | |
| iFlow CLI | `.iflow/skills` | |

同步落点规则：`--adapter` 指定 > 第一个已存在的适配器目录 > `.claude/skills` 兜底。

## 设计约定

- **三端同源**：一条 action 声明驱动 CLI、HTTP、面板；不写第二份命令清单。
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

- skill 分组管理（store.skillGroups 已有数据结构）
- 上次同步快照缓存，让 skill 侧也能走真正的三方合并
- 批量操作（同步到所有项目 / 从所有项目移除）
- 把 `modules/` 的注册从显式列表改为目录扫描（当前保留显式是为了可 grep、可断点，
  且前端受打包约束做不到同等自动）

## License

MIT
