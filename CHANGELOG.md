# Changelog

本文件记录对外可见的变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [0.6.0] - 2026-09-16

架构重构：把 CLI / HTTP / Web 三端收敛到同一份 action 声明上。**CLI 命令名全部保持不变**，
因此已发布的 `assets/repo-hub/` agent 用法文档继续有效；变化集中在内部分层、
HTTP 接口形状与错误契约。

### Added

- `nx-rh bootstrap` —— 补齐聚合上下文读取（此前 Web 有 `/api/bootstrap`，CLI 没有，
  agent 只能多次往返拼装）。同时下发命令表，供面板渲染「CLI 等价」提示。
- `nx-rh health` —— 健康检查。
- `nx-rh skill platform-status <name> --project P` —— 补齐一条此前**只有路由没有命令**的死接口。
- `nx-rh bundled list` —— 列出内置 skill 包（`skill install --list` 保留为别名）。
- `nx-rh repo get <id>` —— 补齐仓库的 CRUD。此前只有 list / add / update / remove，
  想做「查单条」只能用 `repo status <id>`，但那会顺带跑一遍 git，语义和开销都不对。
  同时新增 **CRUD 完备性断言**：声明了 `resource` 的模块，五个操作必须齐备
  且**每个都能从 CLI 与 HTTP 两端调用**（见下）。
- `nx-rh routes` —— 命令 ↔ HTTP 路由对照表，**双向可查**：
  `--module M` 按模块过滤；`--http "METHOD /api/path"` 由端点反查命令
  （带参路由也能匹配实例，如 `DELETE /api/repos/r_abc` → `nx-rh repo remove`）。
  `bootstrap` 下发的命令表同步补上 `http` 字段，因此面板看到的端点也能反查到 CLI 命令。
  `routes` 与 `help --json` 共用同一份命令表（含 `serve`/`help`/`version` 等平台命令），
  两者条目必然一致——有测试断言，不会退化成两张长度不同的表。
- `nx-rh setting set k1=v1 k2=v2` —— 支持一次原子写入多个键。
  旧写法 `setting set <key> <value>` 仍然可用。
- 单元测试（43 项）与注册表一致性断言：`tests/unit/`。其中
  `registry.test.mjs` 强制「模块目录 ↔ 后端注册表 ↔ 前端视图注册表 ↔ 视图里调用的接口」四方对齐。
- ESLint 扁平配置，把分层约束写成 `no-restricted-imports` 规则。
- CI 工作流 `.github/workflows/ci.yml`（lint + 单测 + 构建 + 冒烟），与发布流水线分离。
- `LICENSE`、`.editorconfig`。

### Changed

- **HTTP 路由按「字面量段优先」排序**，不再依赖声明顺序。
  `GET /api/repos/status` 与 `GET /api/repos/:id` 都能匹配 `/api/repos/status`，
  谁先声明谁赢——一旦有人调整 actions 顺序，前者就会被后者抢走，
  而且只在特定路径上出错，极难排查。排序后声明顺序不再影响匹配结果。

- **架构**：`src/cli/main.js`（400 行硬编码 switch）、`src/web/api.js`（手写路由表）、
  `src/services/*` 重构为 `src/modules/<域>/{index,service,view}` + `src/runtime/*`。
  新增命令不必再改 4 处，只需在所属模块的 `actions` 里加一项。
- **错误契约**：service 层统一为「失败抛 `AppError`，业务结果返回 `{ status }`」。
  HTTP 状态由错误码映射（`NOT_FOUND`→404、`CONFLICT`→409、`EXTERNAL`→502），
  不再一律 400。`--json` 的错误对象**新增** `code` 字段，`error` 仍为字符串（向后兼容）。
- **HTTP 接口形状**（面板同步更新，CLI 不受影响）：
  - `POST /api/candidates`（一个端点承载四种操作）拆分为
    `POST|DELETE /api/skills/central` 与 `POST|DELETE /api/skills/project`，
    与 CLI 的 `skill central add/remove`、`skill project add/remove` 严格一一对应。
  - `POST /api/skills/remove-project` → `POST /api/skills/remove`
- `core/` 扩充：`errors.js`、`fstree.js`、`frontmatter.js`、`link.js`、`open.js`。
  原先 `diffTrees` 由 `bundled.js` 从 `skills.js` 横向引入，`caller` 各自重复实现
  frontmatter 解析与名称校验，现统一下沉。
- 前端新增 `ErrorBoundary`：单个视图崩溃不再白屏；`api/client.js` 增加超时与错误码透出。

### Fixed

**重构前就存在的缺陷：**

- **幂等跳过在 Windows 上永久失效**。链接目标用 `realpath` 形式写入，而调用方持有的是
  字面量路径；`os.tmpdir()` 返回 8.3 短名（`C:\Users\ADMINI~1\...`）而 `realpath`
  返回长名（`C:\Users\Administrator\...`），直接字符串比较判为不同，
  导致每次同步都白删白建一遍链接。新增 `sameRealPath()` 比较前先归一化。
- **`repo push` / `repo pull` 失败时退出码为 0**。此前返回 `{ ok: false }` 后 CLI 只打印
  错误文本而不设退出码，agent 会当成成功。现在失败抛 `EXTERNAL` → exit 1。
  （`pull` 产生的冲突例外——那是业务结果，以 `status: "conflict"` 正常返回。）
- **`settings` 模块寄生在 skill 模块**：`updateSettings` 原先定义在 `skills.js`，
  任何模块想加设置项都得改 skill 的代码。现已独立为 `src/modules/settings/`。
- 补上 `repo` 路径参数的一致性校验（`gitResolve` / `gitDiff` 此前不如
  `applySkillSide` 严格），并新增 Origin 校验拒绝跨站写请求。
- 静态文件服务改用「解析后前缀校验」替代正则剥离 `..`。

**重构过程中引入、在发布前审查中发现并修复：**

- **面板「关闭平台」完全失效**：action 里写成 `enabled: !ctx.off`，面板传的
  `enabled:false` 被 `!undefined` 顶成 `true`——点「关」等于点「开」。
  CLI 的 `--off` 正常，且测试只覆盖了 CLI，所以一度没被发现。现已补上
  「两条入口必须走同一分支」的对照断言。
- **`skill apply` 拒绝前导点文件**（`.gitignore` 等）：文件路径校验误用了
  「目录名」的规则。`conflict` 能列出 `.gitignore` 而 `apply` 报「非法文件路径」，
  冲突永远无法按文件落地。拆出 `assertSafeRelPath`（允许前导点、归一化 `./`）。
- **参数缺失丢失「用法:」锚点**：`agent-workflow.md` 教 agent 用该子串判定参数错误，
  新实现只输出「缺少参数 X」，会让最常见的失败落到「不确定 → 停下来问人」。
- **移除候选不再幂等且报 404**：面板的项目下拉是「已登记仓库 ∪ 候选目录」，
  移除一个从未成为候选的仓库会报错、且清理不掉选中项。
- **若干 `--json` 形状静默变形**：`skill central`（裸字符串 → 对象）、
  `skill central list`（字符串数组 → 对象数组）、`skill platform`（两键 → 全量 settings）。
- **`help <主题>` 与 `<命令> --help` 全部报「未知模块」**：主题匹配的是模块 id 而非
  命令组，`bundled list --help` 还会拼出 `bundled,list`。
- **`help` / `serve` 在输出末尾多打一行 `undefined`**，且 `help --json` 的 stdout
  不是合法 JSON——违反 `--json` 输出单个 JSON 值的契约。
- **`setting set` 历史写法回归**：`setting set note a=b`（值含 `=`）与
  `setting set platforms a b`（值含空格）都会被误判成新语法而报错。
- **路径校验过严**：`repo diff --file ./a.txt` 这类 git 自己接受的写法被拒。
- **需要值的 flag 缺值被静默转换**：`repo scan --depth`（末尾无值）经 `Number(true)`
  变成「深度 1」——笔误被当成另一个合法值。
- 错误文案 `非法skill 名称` 补回缺失的空格。
- **dev 模式下面板整页白屏**：Vite 的 root 是 `src/web/frontend/`，源码文件会暴露成 URL，
  于是 `api/client.js` 被请求为 `/api/client.js`——正撞上代理前缀 `/api`，
  被转发到后端拿到 404 JSON，浏览器 `import` 失败。
  生产构建不走代理，所以这个 bug 只在 `pnpm run dev` 下出现，
  平时只用 `pnpm start` 验证的话会一直潜伏。
  现按「是不是前端资源」分流（`shouldServeLocally`），并加单测钉住。

**文档：**

- README 命令总表补齐遗漏的 `gh *`、`skill remove`、`repo add --desc`、
  `skill sync --adapter`、全局 `--store`；修正 `skill-sync.md` 中与根目录布局
  矛盾的旧布局描述；`repo-ops.md` 与 `agent-workflow.md` 同步 push/pull 的新失败形态。

### Removed

- `src/cli/`、`src/services/`、`src/web/api.js`、`src/web/server.js`、`src/web/open.js`
  （能力已迁入 `src/modules/` 与 `src/runtime/`）。

## [0.5.1] 及更早

见 git 历史。
