# Changelog

本文件记录对外可见的变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [0.8.0] - 2026-09-19

### Fixed

- **HTTP 路由排序：字面量段必须压过同长度的参数段。** 旧 `compareRoutes` 只在
  「同位置字面量 vs 参数」时比较，`GET /api/env`（env.list，全字面量）会排在
  `GET /api/env/:name`（env.get）之后——`/api/env/list` 这类路径把 `list` 当变量名去查。
  新规则：**字面量段总数多者优先**，其次段数、其次逐段字面量。配反向断言钉住
  四对「字面量 vs :param」冲突路径（`/api/env/status|path|snapshots`）。
- **env 页布局：顶层容器误用 `.settings`。** 那是设置页 dt/dd 的
  `grid-template-columns: 120px 1fr` 两列网格——env 页 5 张卡片被 Grid 交错摆放，
  能力横幅 / 新增 / 快照掉进 **120px 左列**被压成竖条（变量表占右列所以看起来
  「只有左边是坏的」）。改为新的 `.stack` 单列容器，并在类名旁留注释说明为什么
  不能复用 `settings`。
- **CLI 等价提示粘成一坨**：`nx-rh env statusnx-rh env list…`——命令之间没有分隔符。
  命令之间加间隔点（弱化、不可点），文案改为通顺句子；末尾「加 --json 得机器可读输出」
  独立成行。同时修 map 里无 key Fragment 的 React 警告。
- **`style.css` 重写时丢失的规则补回**：`footer`（全局页脚——丢了这个是上一轮
  「页脚小字 UI 不对」的根因）、`.d-add` / `.d-del` / `.conflict-file`（diff 高亮，
  丢了之后冲突行只是普通文字）。

### Added

- **`pnpm run dev` 一条命令起全部**（`scripts/dev.mjs`）：先起 vite（5180），
  ready 后自动拉 serve（7800），一个 Ctrl-C 两个都退。**直接 spawn node 二进制
  而非 npm.cmd**——后者在 Windows 上会重排参数；vite 显式 `--host 127.0.0.1`，
  绕开 Node 18+ 默认 IPv6（`::1`）监听导致 `127.0.0.1` 连接被拒的坑。
  dev 启动器只服务本地开发；`pnpm start`（prod）不变，发布包不带这层。
- **面板视觉密度体系**（核心显示与交互件分层）：
  行 / 表格 / 输入框 28px 高 + 12px 字号；按钮 / tab 32px（比行厚 4px，
  明确「这是可按的」）；次级标签 22px / 11px。
- **新拟物阴影只给交互件**：按钮四态（默认凸起 / hover 光晕 / 按下内嵌 + 下沉 1px /
  禁用内凹）、tab.active 单层、input:focus 内凹（替代外发光）。
  **容器（卡片 / 行 / 表格 / 标签）不带任何 box-shadow**——主体是连续的流，
  全部分隔靠 1px 浅底线（`.row border-bottom`、`.card + .card border-top`），
  不用 margin / 投影撑空间。

### Changed

- **skill：`02-web-panel.md` 合并为「Web 端要求」单一来源**——面板交互规范与
  视觉规范（密度 / 立体感 / 分隔 / 实操 / 反 AI-default 自检）在同一份里
  （写视图时两套规则要同时满足），原来拆出去的设计 ref 已并回并删除。
  新增 `references/07-framework-runtime.md`（dev 两进程为什么 / 端口绑定 /
  Windows spawn 三坑 / CI 不走 dev），主文档路由表同步。

## [0.7.0] - 2026-09-17

### Added

- **`nx-rh env` 模块 —— 查看与编辑 Windows 的持久化环境变量**（新面板「环境变量」页）。
  这是本项目第一个改**操作系统状态**而非仓库状态的模块，因此写路径的安全网比其他模块厚：

  - `env status` —— 能力探测：平台 / 是否提权 / 两个 scope 各能否写。
    **不进 `/api/bootstrap`**：探测要跑一次 PowerShell（约 300ms），挂在 bootstrap 上
    等于每次开面板都付这个钱，而大多数人不会打开这一页。
  - `env list` / `env get <name>` —— 合并视图，标注**遮蔽**（用户级盖住系统级）、
    **拼接**（PATH，生效值 = 系统条目在前 + 用户条目在后）、**重复**（两边值相同）三种关系。
    本机上 `TEMP` / `TMP` 是遮蔽，`Path` 是拼接——把 PATH 也标成遮蔽会误导用户
    去删用户级 PATH，那会直接丢掉他加进去的几十个条目。
  - `env set` / `env remove` —— upsert 语义（同 `setx`），不区分 add / update。
    写入时**沿用注册表里已有的原始大小写**，避免造出 `Path` 与 `PATH` 两份。
  - `env path add|remove <dir>` —— PATH 按条目增删，**不让调用方手拼几千字符的字符串**。
    默认追加在末尾；`--first` 前置（会遮蔽系统同名工具，慎用）。
    删到最后一条会被拦下（`PATH` 变空会让整台机器的命令行不可用）。
  - `env snapshot list|save|restore <id>` —— **每次写入前自动快照**（两个 scope 的完整数据），
    保留最近 50 份。恢复前会再自动备份一份，所以**恢复本身可被恢复**。
    未提权时系统级恢复返回 `status: "partial"` 并列出跳过的 scope——如实报告，不是失败。

- **`--dry-run` 覆盖每一条写命令**，只返回将发生的改动的 unified diff，不落盘、不产生快照。
- **值类型保真**（本模块最容易静默损坏用户 PATH 的一处），且 `env set` 与 `env path *` 规则**不同**：
  - `env set`（用户亲手写值）：已存在的 `REG_EXPAND_SZ` 永不降级成 `REG_SZ`
    （降级会让值里的 `%USERPROFILE%` 从此不展开）；值里出现 `%` 时把 `String` 升级为 `ExpandString`。
    只有显式 `--kind string` 才能覆盖。
  - `env path add|remove`（只做结构编辑）：**只保留已有类型，不做升级**。
    这条区分是实测逼出来的——见下方 Notes 里的真实事故。
- **PATH 条目增删会归一化 PATH**（丢弃 `;;` 与尾随 `;` 这类空段）。Windows 把空 PATH 段
  解释成「当前目录」，是个已知的提权面，所以这是有意的；代价是 add 之后再 remove
  **不构成严格幂等**（非空条目逐条保留、顺序不变）。dry-run 的 diff 里可见。
- `assets/repo-hub/references/env-manage.md` —— 随包发布的 agent 操作手册新增环境变量场景
  （平台权限矩阵、遮蔽/拼接/重复的判定、红线、正反例）。

### Changed

- **新增模块必须补登记**：`eslint.config.js` 的模块互依禁列是逐模块枚举的，
  本次补上 `../env/*` 并加注释说明「漏补不会报错，只是新模块悄悄变成谁都可以依赖」。
- `core/paths.js` 新增 `ENV_SNAPSHOT_DIR`（`~/.nx-rh/env_snapshots/`）。
- 冒烟测试新增 env 段（89 项）：**写操作一概不进冒烟**——那会改掉跑测试这台机器的 PATH。
  只走读与 `--dry-run`，并用「dry-run 前后 PATH 逐条比对」证明最危险的操作确实惰性。

### Fixed

- `tests/unit/skill-docs.test.mjs` 的 frontmatter 正则只认 LF，导致该断言在 Windows 检出
  （CRLF）上**永久为红**——本地测试带一个假失败，真问题会被它掩盖。读取时归一换行。

### Notes

- **实测事故（已修复，记在这里因为它定义了一条设计边界）**：`env path add|remove` 最初
  复用了 `env set` 的类型决策，于是继承了「值含 `%` 就升级」。在一台用户级 PATH 为 `REG_SZ`、
  且含 `%JAVA_HOME%\bin` / `%MAVEN_HOME%\bin` **字面量**（REG_SZ 从不展开，所以那两条是死条目）
  的机器上，`env path add` 加一个无关目录时拼出的整串含 `%`，整条 PATH 被升级成 `ExpandString`
  —— 那两条死条目突然生效，机器上 `JAVA_HOME` / `MAVEN_HOME` 的 `bin` 凭空上了 PATH。
  **用户只是加了一个目录，不该承受全局语义变更。** 修复方式是把「结构编辑」与「赋值」的
  类型规则拆成两个函数（`kindForStructuralEdit` / `decideKind`）——`%` 来自 PATH 里早已存在的
  内容时，我们没有资格改它的展开语义。
- **仅支持 Windows。** macOS / Linux 上所有 env 命令返回可分类的 `BLOCKED`，
  不假装成功；posix 实现位已预留（launchctl 与 shell rc 的语义差异大，
  留待单独实现，以免做出「看似支持实则不生效」的假实现）。CI 跑在 ubuntu-latest 上，
  这条路径是被断言的。
- **已启动的进程不会自动跟变**：写的是注册表持久值，新开的终端才会读到。
  写入后会广播 `WM_SETTINGCHANGE` 让 Explorer 重读环境；广播实测约 3–6 秒，
  `--no-notify` 可跳过（批量写入时值得加）。
- **驱动用 PowerShell 而非 `reg.exe`**，理由与实测数据记录在 `src/core/envvars.js` 顶部：
  `reg.exe` 的输出是控制台代码页编码（同一份输出 utf-8 解码得乱码、gbk 才对），
  且是给人看的表格文本——真实机器上存在名为 `IntelliJ IDEA Community Edition` 的变量、
  值为空的变量、值含连续空格的路径，文本切分在这些数据上会崩。
- **注入防线是结构性的**：脚本文本里只有常量，变量值经 UTF-8 临时文件、文件路径经
  `$env:` 传入，任何数据都不参与脚本拼接。
- **已知竞态**：`env path add|remove` 是「读-改-写」，两个并发调用可能丢一次更新
  （Windows 注册表没有 CAS）。env 编辑是低频人工 / agent 操作，本次接受该限制，
  未加锁。

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
