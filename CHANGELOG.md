# Changelog

本文件记录对外可见的变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [0.15.1] - 2026-10-08 环境变量四象限看板 + Skill 落点页配置分离

### Added

- **环境变量页改为四象限看板**：用户环境变量（HKCU）、用户 PATH 条目、系统环境变量
  （HKLM）、系统 PATH 条目以 2×2 分卡承载；每象限独立计数、可滚动，变量可就地
  编辑 / 删除、PATH 可逐条目追加 / 移除；系统级未提权时标「只读」并禁用写入。
  所有写入仍走 dry-run diff 确认，写入语义不变。
- **Skill 落点页平台安装状态按作用域分离**：拆成「项目相关配置 / 用户相关配置」
  两张卡片，各带 `已安装 N/N` 计数；用户级与项目级配置一眼分开，不再混在一个扁平列表。

### Fixed

- **「转实体」按钮显示条件反了**：物化（链接 → 实体副本）本应作用于链接行，现正确
  出现在链接行（转实体 + 撤销），实体行只保留删除。

## [0.15.0] - 2026-10-06 工作树只做「登记 + 提醒」：移除全部复制/链接能力

### Changed

- **nx-rh 不再复制、链接任何文件**。工作树模块的职责收敛为**登记 + 提醒**：
  - 非 git（被 `.gitignore` 屏蔽）的文件/目录按全路径登记为扩展文件；
  - 在工作树里 `wt context` 显示主项目变更，以及每个扩展/关注项的**主项目全路径**，
    只读打开即可（非 git 文件多为文档）。
- 关注项（如 `.tool` 本地工具目录）的辅助操作由「取得指令」改为「复制主项目路径」。
- 模块配置移除 `syncMode`（不再有 copy/symlink 之分）。

### Removed

- 移除命令 `wt ext take`（按需取得单个）与 `wt ext sync`（批量同步）及其 HTTP 路由
  （`POST /api/wt/ext/take`、`POST /api/wt/ext/sync`）；Web 面板移除「取得」「同步扩展」
  「全部同步」按钮与同步结果弹窗。需要文件内容时由 **agent 自行复制**（`Copy-Item` / `cp`）。

## [0.14.0] - 2026-10-06 工作树改为轻量信息收集：新增 `wt ext take`、关注项与 rh-worktree skill

### Added

- **新内置 skill `rh-worktree`**（`skill install rh-worktree` / `--group=rh-worktree`）：
  自动适配当前状态，把规范的工作树流程交给 agent——
  - 主仓库（`role=main`）：先 `wt context` 记录上下文，再 `wt ext discover --apply`
    登记被 ignore 文件的全路径，然后 `wt add <需求>` 创建工作树并显示主项目变更；
  - 工作树（`role=worktree`）：显示主项目地址、本工作树信息，以及主项目被 ignore、
    需要特殊关注的文件/文件夹，附取得指令。
- **`wt ext take <ref>`**：按需把**单个**扩展文件取得进当前工作树（id / 相对路径 / 名称定位），
  比 `sync --ids` 更短；支持 `--target / --mode / --force / --dry-run`，冲突安全。
- **关注项（attention）**：主项目根下的点目录（如 `.tool` 本地工具/测试目录）及一组常见
  本地工具名会被自动标「关注」，在 `wt context`、`wt ext list` 与 Web 面板突出显示并附
  `takeCmd`，方便按需参考/取得。
- `wt context --json` 新增 `role`、`attention[]`、`extItems[]`（含 attention / takeCmd），
  一条命令拿齐，不必再分别查询。

### Changed

- **工作树默认不复制文件**：定位从「扩展文件一键同步」改为**必要信息收集**——工作树里用
  `wt context` 看主项目变更与参考路径，需要哪个再 `wt ext take`；只有工作树要**运行**
  项目级脚本时才复制。批量 `wt ext sync` 保留但降为可选项（Web 上改为 ghost「全部同步（可选）」）。
- `wt add` 输出在 cd 之后直接提示 `wt context`；扩展表新增「取得」按钮、批量同步弱化。

### Fixed

- `wt ext take` 判定为 `skipped` 时仍执行了复制、并被重新标成 `copied`；skipped 现在
  立即短路返回，不再触发 cp。

## [0.13.3] - 2026-10-05 迁移形态就地可选：实体复制按钮 + 批量形态下拉

### Added

- **详情页安装矩阵按形态操作**：未安装行有「迁移」（软链接，默认）与「实体」
  （`--mode copy`，独立副本——方便平台之间互拷、不随订阅源变化）两个按钮；
  已安装的链接行有「转实体」（materialize，确认后断开实时同步）。
  链接行的撤销叫「撤销」（摘指针，无损），实体行叫「删除」（连本地改动一起删，
  Hub 那份仍在）——两种语义不再共用一个按钮。
- **订阅源子页批量迁移形态下拉**：勾选后可选「跟随设置 / 软链接 / 实体复制」，
  按次覆盖、不改全局设置；确认弹窗写明本次形态。
- 内置手册 `nx-rh` 同步：skill-hub ref 写清 `--mode copy` 的例外定位与两种
  撤销语义；SKILL.md 触发词补「实体副本 / 项目里的 skill」。

## [0.13.2] - 2026-10-05 Skill 总览统计口径修正

### Fixed

- **平台卡计数按 skill 名去重**：原先「198 处安装」按目录份数计（同一 skill 在
  用户级 + 项目级各算一次），且「处」与面板其他地方「N 个 skill」的口径不一致。
  现在 managed / orphan 都按名字跨作用域去重——数字回答「这个平台里有几个 skill」。
- 统计句式直白化：平台卡与「当前项目」卡统一为「有 N skill，其中 M 独立未入 Hub」，
  悬停解释「独立未入 Hub」= 只在平台目录里、订阅源里没有（点进去可收进 Hub）。

## [0.13.1] - 2026-10-05 工程化：模块内文件拆分 + 尺寸护栏（零行为变化）

### Changed

- **按单一关注点拆分 skills / worktrees 两个最大模块**（对外入口与 import 路径全部不变）：
  - `service.js` 变 barrel，业务进 `svc/*.js`（skills 七文件、worktrees 九文件），
    依赖单向无环；`export *` 的重名静默丢弃风险以「一个导出一个文件」约定排除。
  - action 声明与 CLI 人读渲染分层：`index.js` 只剩声明，`renders.js` 承接 renderX；
    skills 顺带收编 `sourceLabel` 的 index↔view 双份实现为 `shared.js` 一份。
  - `view.jsx` 变路由入口（skills 987→75 行，worktrees 594→216 行），
    页面/弹窗进 `parts/*.jsx`；原 478 行的工作树单组件（14 handler、8 弹窗）消解；
    三份重复的过滤谓词收敛为 `makeHit`。懒加载 chunk 不变（仍 5 个 view-*.js）。
- **lint 尺寸护栏**：`max-lines` 500 / `max-lines-per-function` 450（有效行计，
  跳过空行注释；tests/ 不限）。阈值卡在拆分后最大值上方——env 模块（EnvView 420）
  是下一个被棘轮盯上的。
- **分层规则补洞**：前端禁 node:* / 禁引 service / 禁跨模块的规则此前只覆盖
  `view.jsx`，拆出的 `parts/*.jsx` 落在所有规则之外；glob 扩为
  `src/modules/**/*.jsx` + `*/shared.js`，跨模块禁令在视图层重复声明
  （flat config 同文件多块匹配整条替换）。
- registry 一致性测试的 /api 路由对齐扫描扩展到 `view.jsx + parts/*`，
  视图拆分后接口调用仍然全量受检。
- README 新增「模块内的文件布局与何时拆」；模块目录结构注释同步。

## [0.13.0] - 2026-10-05 新增工作树模块 `wt`；Skill 页第二轮：hub 中心化、当前项目子页、术语平实化

### Added

- **新功能域「工作树」（CLI 根 `wt`，Web「工作树」标签）**：一条 action 同时暴露
  CLI / HTTP / 面板。参考 ccswitch 的工作树机制，让 agent 能用 skill+cli 快速生成准确的
  worktree 工作流。
  - `wt init`：建集中式工作树根（默认 `~/.nx-rh/worktrees/<repo>`）；根若在主仓库内，
    自动把根登记进 `.gitignore`（幂等）。
  - `wt add <描述>`：描述 → `feature/<会话名>` 分支 + `git worktree add`，秒级创建；
    `wt checkout <branch>` 挂已存在分支；`wt remove` / `wt switch` / `wt open`。
  - `wt context`：**一条命令**在工作树内拿齐主项目最新 git 上下文（分支 / HEAD / 改动 /
    最近提交、当前树领先落后、扩展文件状态、可直接复制的建议指令），解决上下文不及时。
  - `wt rebase` / `wt fanout`：把工作树 rebase 到主项目分支；fanout 先出安全计划
    （脏树、领先树拦下），`--yes` 顺序执行，冲突自动 abort 并停在该树。
- **扩展文件机制（`wt ext ...`）**：`.gitignore` 里不进工作树的文件按**绝对路径全路径登记**。
  - `wt ext discover [--apply]`：从 `.gitignore` 具体条目 + `git ls-files` 发现候选
    （默认只建议、零副作用）；`wt ext add <abspath>` 手工登记（被跟踪文件默认阻止）。
  - `wt ext sync [target]`：以主项目**当前**内容为准复制 / 链接进工作树——缺文件→复制，
    已一致→skipped，工作树内有本地差异→conflict 不覆盖（`--force` 才覆盖）；
    支持 `--mode symlink`（Windows 目录用 junction、文件软链失败自动降级复制）、
    `--ids` 挑条目、`--dry-run` 出计划。
  - 内容指纹：小文件 sha256，大文件 size+mtime，目录对清单哈希；工作树根自身自动排除，
    防止同步递归自复制。
- **Skill 页「当前项目」子页**（`#/skills/project` ⇔ `nx-rh skill hub project skills`）：
  扫描全部适配器的项目级目录（不只启用的平台），列出当前项目目录里实际存在的 skill，
  每项标注是否已在订阅源；勾选「不在订阅源」的项可批量收进。总览页相应多一张
  「当前项目」入口卡片（数据随 `/api/skills` 的 `projectSummary` 一次下发）。
- **`skill hub submit --into <订阅源>`**：收进哪个已订阅的源（缺省仍是当前主源）。
  与 `migrate --source` 刻意区分：`source` = 来源冲突时用哪份内容；`into` = 提交落到哪个源。
  面板上「收进订阅源…」弹窗列出全部已订阅源（radio 单选，缺省主源）。
- **Skill 总览页「快捷设置」浮层**：迁移形态 / 默认平台 / 平台范围三项就地可改，
  不必跳去设置页（两端写同一个 `POST /api/settings`）。

### Changed

- **git 边界开了一个明确例外**：此前「本工具不做任何 git 操作」；现在 `wt` 模块独占
  git-worktree 操作，但仍不做通用 status/diff/pull/push 与远端协作，`repo` 模块继续不碰 git。
  工作树清单真相始终在 git（`git worktree list` 现查），store 只存 git 不知道的扩展文件与配置。
- store 新增顶层键 `worktreeState`，按主仓库路径分桶；无论从主仓库还是链接工作树启动，
  都先用 `git rev-parse` 解析出主仓库再定位桶，在工作树内操作不会产生不同桶。
- **不在订阅源的 skill 详情页改为 hub 中心操作集**：不再显示逐平台的迁移 / 撤销按钮
  （那套逻辑只对已在订阅源的 skill 有意义），主操作是「收进订阅源…」（选源弹窗）+
  彻底删除；安装位置矩阵只读列出实际存在的位置。
- **详情页文件预览移到最后并默认折叠**（`文件与 SKILL.md 预览（N 个文件）`）：
  页面主体先给安装状态与操作，长正文不再把操作区顶下去。
- **术语平实化**：面板与 CLI 文案里的「落点」改为「安装位置 / 安装状态」，
  「未入 Hub / 已入 Hub」改为「不在订阅源 / 已在订阅源」，「未迁移」改为「未安装」；
  `skill cat` 的非源侧前缀由 `落点:` 改为 `目录:`。断链错误文案同步改为
  `… 的安装位置是断链：…`。

## [0.12.0] - 2026-10-04 多 skill 包：`skill hub` 归位、内置 skill 可分组、新增 rh-collect

### Added

- **包里可以有多个 skill 了**（脚手架 B04）：`assets/` 下每个 `<name>/SKILL.md` 就是一个可装的
  skill，由 `assets/groups.json` 归组。`skill list` 列**包内**可装的 skill 与 group（并标出默认
  装哪个），`skill install [name]` 装单个，`skill install --group <key>` 一键装一组，
  `skill groups` 看每个 group 含哪些 skill。
- **`groups.json` 只是别名表，不是第二条事实源**。事实源永远只有 `assets/<x>/SKILL.md`：
  文件缺失或解析失败时降级为「每个 skill 各成一组」——照样能装，只是没了 `--group`；
  但 **schema 错**（缺 `groups`、某组缺 `skills`、skill 名非法）必须显式报错，那是打包事故，
  静默吞掉只会让排查抓瞎。
- **内置 skill `rh-collect`**：把 agent 在工作过程中发现 / 克隆的 git 仓库收进登记表的专用手册，
  核心是「先扫描发现（零副作用），**问过用户再登记**」，与下面的 `repo scan --dry-run` 配套。
- **`repo scan [root] [--depth N] [--dry-run]`**：`--dry-run` **只列出**发现的仓库、不登记。
  「看看这底下都有些什么」和「把它们都收进来」是两件事，此前合并成一个动作，
  等于逼人先猜、再后悔。`root` 现在可以省略，缺省当前目录。

### Changed

- **⚠️ 破坏性：业务命令全部归到 `skill hub` 下** —— `show / cat / add / update / remove /
  purge / migrate / unmigrate / submit / materialize / merge / sources / subscribe /
  unsubscribe / main / project / platform / adapters / check`。
  原先 `skill list` 列的是**订阅源里的 skill**，而 `skill hub list|add|remove` 操作的却是
  **订阅源本身** —— 同一个 `skill` 前缀下混着两套不同的宾语，还撞名（`list` 到底列 skill
  还是列源？）。现在分工固定：`skill list` = 包内可装的，**订阅源里的 skill 与源自身
  一律走 `skill hub`**（源本身是 `sources | subscribe | unsubscribe | main | check`）。
  **脚本里写死的 `nx-rh skill migrate …` 要改成 `nx-rh skill hub migrate …`。**
- `skill hub submit` 的 `--to` 缺省改为 `all`（未入 Hub 的 skill 多在**用户级**目录里，
  原来缺省 project 经常一个都收不到）。
- `skill install` 的返回多一个显式 `group` 字段：装一个与装一组的判别靠它，不做形状嗅探
  ——「装一个」的退化结果里也可能带数组。

### Fixed

- 默认 install 的标记改为读**本包自己的** package.json，不再读 `process.cwd()`：
  全局安装时 cwd 是用户的任意目录，永远匹配不上，标记会静默消失。

## [0.11.1] - 2026-10-04 面板修复：多源目录名可区分、skill 查看器可滚动

### Fixed

- **多源订阅源的目录名现在能区分了**。订阅源目录几乎都叫 `skills`
  （`~/.claude/skills`、`D:\a_other\md\sl\skills`），而面板有三处只取路径末段 ——
  于是列表里 43 行的来源标签全是同一个词 `skills`，订阅源下拉也变成两个「skills」，
  等于没标。改用「先剥掉**所有源共有**的尾部段，再取最短能唯一区分的尾部」：
  现在是 `sl` / `.claude`，完整路径仍留在 `title` 里；下拉额外标出「· 主源」。
  CLI 的 `shortSource`（原来取末两段，`sl/skills` / `.claude/skills`）也统一到同一套规则。
- **skill 查看器的正文与文件树可以滚动了**。`.skl-files` 原先把高度约束写在容器上
  （`max-height` + `overflow:hidden`），而 grid 子项的 `min-height` 默认是 `auto`
  —— 子项被正文撑到全高（一份 SKILL.md 实测 9596px），容器那边只负责把它**裁掉**，
  子项自己的 `overflow:auto` 永远不生效：表现为「看得见开头、滚不动、后面全够不着」。
  现在把高度约束给在子项上（`min-height:0` + `max-height` + `overflow:auto`），
  超过就自己内部滚，内容短时也不留一大块空白。
- 同一个坑的另外两处一并补上：`.modal-body`（`.modal-box` 是 flex 列，子项默认
  `min-height:auto` 会拒绝收缩，长 diff / 长落点列表同样被裁）、`.dlg` 浮层
  （内容高过视口会溢出到屏幕外且滚不到）。

## [0.11.0] - 2026-10-04 面板信息架构重构：环境变量页 / Skill 页 + skill 的完整查看与删除

### Added

- **`skill purge <name> [--dry-run] [--force]`** —— 彻底删除一个 skill：**所有平台落点 + 订阅源里的实文件**。
  与 `skill remove` 分工明确：`remove` 是「下架，但保留各平台落点」（目标侧还有引用就 `blocked`）；
  `purge` 是「这个名字不该存在了」。**未入 Hub 的 skill 只有 `purge` 能删**——订阅源里根本没有它，
  `remove` 只会 `NOT_FOUND`。`--dry-run` 先列出将删除的每一处；落点里有**实体副本**时需要 `--force`，
  **链接不需要**（删链接不会碰它的目标）。
- **面板的 skill 查看器**：详情弹窗改为「描述 / 来源 / 目录 / 规模 + **文件树 + 全文** + 落点 + 操作」。
  一个 skill 不止 SKILL.md，`scripts/` 与 `references/` 往往才是决定「它到底干什么」的部分；
  内容点哪个读哪个（`drawio` 这类 skill 有 80+ 个文件，一次全读既慢也没必要）。
  「删除」按后果分成「从订阅源删除」与「彻底删除…」两个按钮，后者先弹 dry-run 清单再确认。
- **`skill show` 输出文件清单**；`skill cat` 增加 `--project`。

### Fixed

- **未入 Hub 的 skill 现在能看内容了**。此前 `skill cat` 与面板的「查看全文」只认订阅源，
  对这类 skill 必然报 `订阅源里没有该 skill`。现在按「当前主源 → 其它订阅源 → 平台落点」解析，
  **落点是链接就顺着链接读**；断链（目标已被删）明确说明
  `… 的落点是断链：<落点> → <目标>（目标已不存在）`，而不是含糊地报「不存在」。
- **`skill submit` 的 `--to` 缺省改为 `all`**。未入 Hub 的 skill 常常落在**用户级**平台目录里
  （如 `~/.claude/skills`），原来的缺省 `project` 会让 `skill submit --all`（文档主推用法）
  与面板的「提交到订阅源」必然报 `目标目录里没有该 skill`。
- **面板「全选订阅源」不再清掉已勾的「未入 Hub」**。全选从「整体替换」改为并集 / 差集，
  并给「未入 Hub」补了整块全选（否则批量提交没有入口）。

### Changed

- **环境变量页：五张等权卡片收敛为「一张变量表 + 一张快照」。**
  - **PATH 置顶**——它是唯一带专属编辑器（逐条目而不是一坨分号串）、也是唯一
    「写坏会让整台机器命令行不可用」的一条，在 54 行的字母序里随机落点并不合理。
  - 变量行可展开成 **用户级 / 系统级**两行，各自可编辑、删除。此前每行只显示一个
    「生效值」，被用户级覆盖掉的系统级值**既看不到、也点不到**。
  - 只读行（只在系统级存在、且当前未提权）视觉降级；新增「全部 / 只看用户级」范围切换。
  - 「新增变量」进工具栏；快照默认收起；CLI 等价提示从首屏移到页尾。
- **Skill 页：三条工具栏收敛为一条。** 订阅源 / 默认平台 / 迁移形态是配置（改一次管很久），
  折进「设置」浮层；批量操作改为**选中之后才出现**，并去掉「不勾选 = 全量」的隐式语义
  ——一按下去会动 3 个还是 48 个，按钮上写不出来，要全量就先「全选」（一个看得见的动作）。
- 「未入 Hub」的平台子表头（Claude Code / WorkBuddy）支持**收起 / 展开**；
  区块表头不再显示「项目 0」这类零值。

## [0.10.7] - 2026-10-04 Skill 面板 UX：搜索、筛选、可扫的行

### Added

- **搜索框**（列表首行，`Esc` 清空）：按名称或描述即时过滤。48 个 skill 只能靠滚着找，
  是这一屏最大的缺口。搜索**同时命中「未入 Hub」**，并在命中时自动展开该区块与该分组——
  否则用户会以为「搜不到」（实测搜 `lark`：订阅源 0/48，未入 Hub 里 27 个直接摊开）。
- **三态筛选**：全部 / 未迁移（还有落点没铺）/ 跨源冲突。与搜索叠加。
- **计数与出口**：表头从 `48 个` 变为 `显示 12 / 48 个`，旁边给「清除筛选」；
  筛空时给明确空状态而不是一片空白。

### Changed

- **行对齐**：名称列定宽 208px（一列名字对齐才扫得动，截断时悬停看全名）；
  描述降为次要信息（11px 灰字单行 + 悬停看全文）。
- **行尾「详情」按钮默认压到 35% 透明度**，悬停/聚焦才提亮——48 行就是 48 个按钮，
  常显纯属噪音；不移除是为了保留可发现性与键盘可达性。
- 工具栏瘦身：订阅源下拉只显示短名（全路径进 title）；「项目在右上角切换」那句长提示
  换成行尾的 `项目: nx-rh` 短标注。

## [0.10.6] - 2026-10-04 未入 Hub：组内按平台各自聚合

### Changed

- 「未入 Hub」的作用域组（项目 / 用户级）里，**再按平台各自聚合一行**：每行写清
  **平台名 + 该平台目录 + 数量**（`Claude Code  C:\Users\zhlx\.claude\skills  70 个`）。
  此前组表头只显示其中一个目录 + 「等 N 个目录」——不说平台名，用户根本看不出那份副本
  是给哪个平台用的，而「该放到哪个平台目录」正是这一屏要回答的问题。
- 组表头改为列出该组的平台名一览（`Claude Code · WorkBuddy`），子表头缩进 + 浅底，
  层级一目了然；子表头不是折叠项，展开作用域组即可看到全部平台。
- 同一个 skill 同时存在于多个平台目录时，会在各自的平台分组里各出现一次——它本来就在两处。

## [0.10.5] - 2026-10-04 行上去掉勋章墙，改一个汇总标签

### Changed

- **行上不再摆「平台 × 作用域」勋章**。它按平台数线性膨胀——2 个平台就是 4 个勋章、
  4 个平台变 8 个，行里根本放不下，也没法一眼看。改成一个**汇总标签**：
  `已迁移 3/4` / `未迁移` / 未入 Hub 的 `2 处`，tooltip 里逐行列出每个落点的形态
  （`用户·WorkBuddy：未迁移` …）。平台再多，行宽不变。
- 0.10.4 的「勋章即操作」据此撤回：它解决了「非要进详情页才能动」，却带来勋章膨胀，
  两头不讨好。逐落点的迁移 / 撤销回到详情页的竖向列表（每个落点一行：状态 + 路径 +
  迁移/撤销），那里本来就该放明细；详情页同时保留 `迁移 → 项目 / → 用户`、编辑、删除、
  查看全文。

## [0.10.4] - 2026-10-04 勋章即操作

### Changed

- **行右侧的平台勋章（用·xx / 项·xx）改为直接可点**：点一下 = 迁移到那个落点；
  已经在了 = 撤销；未入 Hub 的行点勋章 = 提交到订阅源。
  此前它们只是状态展示、非要进详情页才能操作——摆一排只读勋章却不能动，是白占地方。
- 迁移幂等可逆，不弹确认；撤销**实体副本**会删文件，仍走确认；撤销链接免确认。
- 勋章 title 明确写出「点击迁移到 项目·WorkBuddy」/「已迁移（软链接）· 点击撤销」，
  不再让人猜它是状态还是按钮。
- 详情页保留：编辑 / 删除 / 查看全文 / 来源 / 结构这类非逐落点操作仍在弹窗里。

## [0.10.3] - 2026-10-04 未入 Hub：按项目目录成组

### Changed

- **「未入 Hub」改为两组**：当前激活项目的游离 skill 收成一组（表头带项目名，如
  `项目 · nxrh-proj`，组内不再按平台拆开），用户级另归一组并**默认收起**。
  项目组排最前、默认展开——真要处理的是它；用户级多是本机常驻旧副本，属于次要信息。
- 一个 skill 同时存在于项目与用户级时归项目组（更该处理的一侧），用户级形态仍可在
  详情弹窗里看到并单独操作。
- 两组各自可收起/展开（会话级状态），区块表头给出「N 个（项目 X · 用户 Y）」。

## [0.10.2] - 2026-10-04 Skill 面板：单选修复 + 未入 Hub 收起

### Fixed

- **行首勾选框无法单独勾选**（0.10.1 回归）：`toggleSel` 在 `skills/view.jsx` 里被调用，
  却既没从 `useStore()` 解构也没本地定义——点击即抛 ReferenceError，于是只有走
  `patchUi` 的「全选」能用。补上解构；并用真实鼠标事件（CDP）验证单选/累加/不误开弹窗。
- **lint 新增 `no-undef`**（手写浏览器 + Node 全局表，不引 globals 包）：这类「调用未定义
  标识符」此前完全不在 lint 视野内（`no-undef` 是关的），已反向测试确认会红。

### Changed

- **「未入 Hub」可收起**：默认收起（状态随 UI 选择持久化），表头给出数量与
  项目 / 用户分布，点标题展开——它是「待收敛」的提示，不是日常要看的信息。
  展开时**项目级排前**（用户级游离多为本机常驻旧副本，优先级低）。

## [0.10.1] - 2026-10-04 面板白屏修复

### Fixed

- **面板整页白屏（TDZ，0.10.0 的关键回归）**：`store.jsx` 的 `switchScope` 依赖数组
  引用了下方才声明的 `patchUi`，`skills/view.jsx` 的 `load` 同样引用了后声明的
  `project`——hook 依赖数组在声明那一刻求值，构成「初始化前访问」，React 根组件
  直接崩溃、页面只剩空壳。构建与单测都测不出来（lint 无此规则、smoke 只 grep 静态
  HTML），用无头浏览器 dump-dom 才现形。两处声明都前移，四个视图已逐一无头验证。
- **`registerDir` 参数名**：recents action 收 `path`，面板误发 `dir`，「注册其他目录」
  被静默忽略（退化为登记服务进程目录）。
- **lint 新增 `no-use-before-define`**（前端文件，函数声明放行）：把这类 TDZ 从
  「运行时才炸」提前到 lint 期拦截，已做反向测试（临时重引入 bug 确认会红）。

## [0.10.0] - 2026-10-03 Skill 域重写：订阅制（Skill Hub）

### Added

- **启动目录与作用域**（对齐脚手架 ref B03 的「项目化启动 + cwd 作用域」）：
  - `nx-rh serve [dir]` 把启动目录注入为「当前项目」；CLI 不传 `--project` 时落点即它。
  - **一个面板管所有项目**：`serve` 前探测同端口 `/api/health`，认出 `cwdScope` 字段即
    认领现有面板——登记目录 + 打开浏览器后退出，不再起第二个进程。
  - `recents`：全局跨项目的「最近目录」列表（`recents` / `recents add <目录>` /
    `recents remove <目录>`），作为面板项目下拉的数据源；store 新增 `recents` 字段（最多 20 条）。
  - `x-nx-rh-scope` 头 + `core/als.js`（`AsyncLocalStorage`）：面板切项目时整条请求链
    自动落到激活目录，业务 action 零改动。
  - `health` / `bootstrap` 新增 `cwdScope`、`projectRoot`、`recents`。
- **零启动盘点与平台适配（CLI 侧）**——不启动面板就能判断「skill 能不能在 X 平台用、该放到哪」：
  - `skill list --long` 打完整描述 + skill 目录；`--json` 每项补 `dir`，`cells[]` 补
    `platformName` 与落点绝对路径（`dir`）。
  - `skill show` 改为「完整描述 + 来源目录 + 平台 × 作用域落点矩阵 + 当前形态」。
  - `skill adapters [--project]` 输出每平台的**项目级 / 用户级绝对落点**（此前只有相对目录）。
  - 平台别名：`--platform claude` / `wb` / `cursor` / `gemini` / `universal` —— 唯一真相源仍是
    `ADAPTERS` 表，别名只在输入侧归一。
  - `--to` 新增 `global`（= `user`），与 `project` / `all` 并列，明确「全局 / 项目化」两端。
  - `skill adapt` 作为 `skill migrate` 的别名（同一条 action，不会分叉）；`migrate` ⇄ `unmigrate` 完全对称，可逆。
- **批量选择器**（`migrate` / `unmigrate` / `submit` 共用）——全量迁移不再手点：
  - `<name...>` 多位置参数点名（其中一个不存在即报错，避免批量里静默漏掉）；
  - `--all` 全量；`--include <模式>` 取子集；`--exclude <模式>` 排除个别（`*` 通配或子串，可逗号分隔）；
  - `--match <关键词>` 按 **description** 过滤——agent 依业务需求挑 skill 的那条路径；
  - `--dry-run` 只判定不落盘，输出「将创建 / 将替换 / 冲突」计划，批量前先预演；
  - `unmigrate --all` 的候选改为**扫描目标目录**，因此也能清掉未入 Hub 的游离 skill。
  - Web 面板：行首勾选 + 「→项目 / →用户 / 撤销勾选 / 提交未入 Hub」批量按钮（未勾选即全量，弹窗确认）。

### Added（skill 结构预览：按前 3 级标题看大局）

- 新增 `core/mdoutline.js`：`mdOutline`（抽 1..N 级 ATX 标题，**跳过代码围栏里的 #**，带行号）+
  `mdStats`（行数 / 字节 / 节数）。纯函数，单测 6 条。
- `skill show` 的人读输出与 `--json`（`skill.show` / `skill.cat` / `skill.get`）都带
  `outline` + `stats`——agent 与面板都能先看结构再决定读不读全文。
- 面板：详情弹窗加「结构」区块（缩进树 + 行号 + 规模），「查看全文」弹窗顶部也带大纲。

### Added（面板内 skill 的完整 CRUD）

- 服务层：`skill add`（新建，同名 → CONFLICT）/ `skill update`（改写 SKILL.md 全文，
  校验 frontmatter 的 name 与目录名一致）/ `skill remove`（目标侧还有引用时 `blocked`，`--force` 继续）。
  只动订阅源那份实文件——目标副本由迁移覆盖，与「目的仓库直接覆盖」的模型一致。
- HTTP：`POST /api/skills`、`PATCH /api/skills/:name`、`DELETE /api/skills/:name`
  （字面量路由优先，`DELETE /api/skills/sources` 不被遮蔽）；CLI 同名三条。
- 面板：卡片头「＋ 新建」；详情弹窗里「编辑 / 删除」。编辑器含名称 / 描述 / 全文三个字段，
  支持直传完整 SKILL.md（以 `---` 开头时校验 frontmatter）。

### Changed（Skill 面板轻量化：行 = 浏览，弹窗 = 操作）

- 行上不再排一排按钮（→项目 / →用户 / 上下文 / 提交到 Hub 全部撤掉）——一行只剩
  勾选框 + 名称 + 描述 + 状态标签 + 平台状态（只读 pill）+ 一个「详情」；点击整行打开详情弹窗。
- **详情弹窗**：完整描述、来源/目录、跨源冲突提示；每个「平台 × 作用域」落点一行
  （路径可复制、形态标签、迁移 / 撤销按钮），以及「迁移 → 项目」「迁移 → 用户」「查看全文」。
- **「未入 Hub」按平台目录分组**（用户级 / 项目级 / 不同平台各一组，组头带目录路径与数量）——
  不再混在一行里；组内每条都能在弹窗里单独提交。
- 平台状态 pill 从按钮改为只读标签：状态一眼可见，操作收敛到弹窗。

### Changed（项目级启动：右上角「最近目录」）


参考 `nx-rp` 的启动方式与 UI 形态，把「项目级启动」落到面板：

- **右上角「最近目录」**：每次 `serve` 启动自动登记当前目录；也可「＋ 注册其他目录…」主动登记。
  点击即切换激活目录（再点一次切回服务进程目录）——**项目级信息只针对激活的那个项目**，
  不与全局混在一起。窗口重新聚焦时自动刷新（能看到别的终端刚登记的目录）。
- 面板整体跟随激活目录：`x-nx-rh-scope` 请求头 + `scopeTick` 强制重挂载，切完即整页按新作用域拉数据。
  Skill 页里原来的项目下拉移除，项目切换收敛到右上角一处。
- **写操作 Origin 校验（脚手架 A01 §三.3）**：服务只绑 127.0.0.1，但浏览器里任意页面都能向它发请求；
  现在浏览器的跨站写请求（POST/PATCH/PUT/DELETE 带非本机 Origin）会被拒（`BLOCKED`），
  本机程序（curl / agent / 测试，不带 Origin）不受影响。单元测试钉住（含 IPv6 `[::1]` 形态）。

### Changed（冲突检测收窄到订阅源之间）



- **目的仓库不再做冲突检测，直接被订阅源覆盖**：目标只是落地副本，hub 里永远有一份，覆盖可恢复；
  `migrate` 因此移除了 `conflict` 状态与 `--force`（删除 `unmigrate` 才保留 `--force`，因为删除不可逆）。
- **来源侧扫描只认实文件**：源目录里的链接是别的真相源的落地副本（典型：把 `~/.claude/skills`
  订阅为临时来源，里面大半是指向其它源的链接），不再被当成第二个来源，也不制造假冲突。
- **新增 `skill hub check`**：订阅源健康诊断——目录缺失 / 空源（全是链接）/ 嵌套订阅 /
  同一根重复订阅 / 跨源同名冲突（内容不同 = 真冲突，内容一致 = 重复订阅）。
- **跨源冲突时迁移 `blocked`**：同名实文件在多个订阅源且内容不同，说明「用哪份内容覆盖」未定；
  新增 `migrate --source <路径>` 显式指定。`skill list` / `skill show` 同步显示冲突标记。

### Changed（规范对齐：脚手架 skill server-cli-web-scaffold）



按 `server-cli-web-scaffold` 的 A00 / A03 / A04 / A07 逐条对账后修正：

- **`skill get` 语义归位（A03 §一/§三）**：`skill get [name] [ref]` 现在是**内置手册**的三段导出——
  `prefix`（引导语）→ `sentinel`（`# --- begin skill content ---`）→ 正文 → `install` 状态；
  执行时顺手按 install 三态装到本机；`--json` 输出 `{skillName, ref, content, contentBytes, install}`
  四元（不含 prefix 文本）；ref 支持**裸名**（`skill-hub` → `references/skill-hub.md`），拒绝 `..` 与绝对路径，
  未知 ref 列出可用裸名。订阅源 skill 的全文导出改名为 **`skill cat`**（原 `skill get` 的语义）。
- **内置 skill 目录名 = 包名（A03 §二）**：`assets/repo-hub/` → `assets/nx-rh/`，安装落点
  `~/.claude/skills/nx-rh`；旧名 `repo-hub` 保留为 `--name` 别名。
- **SKILL.md 触发词自检（A04）**：`description` 改为「当用户……时使用」开头并带 10 个触发词；
  新增「不适用」一节（纯 git 操作 / 远程协作）。
- **bootstrap 字段名（A03 SOP 6）**：`storePath` → `appStorePath`，与规范的五字段
  `version / appStorePath / cwdScope / settings / commands` 对齐。
- **health 返回明确错误码（A03 SOP 7）**：存储路径不可读 / 不是文件 / cwd 不可达时抛
  `BLOCKED`，不再假装健康。
- **`unmigrate` 的状态取值（A00 §八）**：`need-force` → **`blocked`**（四取值 ok / skipped / conflict / blocked 之一）。
- **错误锚点**：未设置订阅源的报错改回含「未设置」（`未设置 Skill Hub 订阅源`），恢复 agent 的失败分类锚点。
- **lint 分层覆盖（A00 闸 1 的实测反例）**：前端禁列的 `files` 补上 `src/modules/**/view.jsx`——
  此前真正写视图的文件不受「禁止 import node:/runtime/core」约束；已做反向测试确认规则会红。
  `ignores` 补 `assets/**`。
- **`src/index.js` 导出补齐（A07 #6，无断言的静默点）**：补 `export * as system`。
- ~~面板「Skill」页新增「内置手册」区块~~ → **已按用户裁定撤下**：面板不展示（噪音），
  `skill install` / `skill get` 保留为 CLI 命令（agent 使用），不做 Web 等价。


### Changed（破坏性）

- **skill 模型从「中心仓库 ⇄ 项目」改为「订阅源 → 目标」的订阅制。**
  唯一的可信源是订阅源（Skill Hub，你的 skill 仓库目录）；平台目录只是落地副本。
  方向只有两条：订阅源 → 目标（`skill migrate`）、目标 → 订阅源（`skill submit`）。
  **不再有「项目之间互迁」**。

  | 移除的命令 | 替代 |
  | --- | --- |
  | `skill central …` | `skill hub list\|add\|remove\|<path>` |
  | `skill list --side central\|project` | `skill list [--source <路径>] [--project <项目根>]` |
  | `skill sync <name> --project P --adapter A` | `skill migrate <name> --to user\|project\|all [--platform P]` |
  | `skill platform-set <name> --project P --adapter A [--off]` | 迁移 / 撤销（面板上的目标 pill，或 `migrate` / `unmigrate`） |
  | `skill platform-status <name> --project P` | `skill show <name>` |
  | `skill push <name> --project P` | `skill submit <name>` |
  | `skill remove <name> --project P` | `skill unmigrate <name> --to …` |
  | `skill conflict` / `skill apply --file F --side central\|project` | 冲突直接由 `migrate` / `submit` 返回文件清单，`--force` 覆盖 |

- **新增命令**：`skill show`（详情）、`skill get`（输出全文给外部 agent）、
  `skill migrate` / `skill unmigrate` / `skill submit` / `skill materialize`。
- **订阅源可多个、允许重叠**：`skill hub add` 可订阅多个 skill 目录（如同时订阅 `sl` 与 `.claude`），
  每个 skill 在列表里标注来源。
- **平台**：新增 WorkBuddy 适配器（项目级 `.workbuddy/skills`、用户级 `~/.workbuddy/skills`），
  默认聚焦 claude-code 与 workbuddy；其余平台保留、可按需启用。
- **启动目录注入**：`nx-rh serve [dir]` 与 CLI 的当前目录即项目根，面板默认打开它；
  `--project` 可覆盖。
- **设置存储升级到 `version: 2`**：`skillCentralPath` / `skillCentralCandidates`
  读取时自动平移为 `skillHubPath` / `skillHubSources`；移除未使用的 `skillGroups`。
- Web 面板「Skill」页改为**源 → 迁移 单向流**：订阅源下拉、每个 skill 一行（来源徽标 +
  用户/项目 × 平台 的目标 pill 可点即迁移/撤销）、「未入 Hub」区块一键提交。

### Removed

- `skill compare` / `skill conflict` / `skill apply` 三件套（逐文件选侧）——订阅制下
  真相源唯一，冲突只需「覆盖与否」，由 `--force` 表达。

### Fixed

- **多订阅源下点名迁移只扫主源**：`hub add` 会把新源设为主源，旧源里的 skill 随之
  「消失」（点名迁移报 NOT_FOUND，CI smoke 抓出）。现在**显式点名**在全部已订阅源里找
  （新增 `listAllSourceSkills`，同名去重留主源那份；同名不同内容仍由 sourceEntriesFor
  判 blocked / `--source`）；`--all` / `--include` 全量保持只取当前主源（「把主源铺出去」
  的语义不变）。回归测试 `tests/unit/skills-multisource.test.mjs`（8 条）。
- **smoke 三处自身问题**：`skill get` 裸 ref 误放第一个位置参数（契约是先 skill 名后
  ref）；api bundled 断言还停在旧名 `repo-hub`；「同端口 serve 认领」用 spawnSync 冻住
  本进程事件循环、被探测服务器永远应答不了——改异步 spawn。

## [0.9.0] - 2026-09-26 移除 git 能力

### Removed

- **整个 git 执行层（破坏性变更）。** 删掉 `src/core/git.js` 与仓库模块下的
  12 条 git 相关命令／路由：

  | 移除的命令 | 移除的路由 |
  | --- | --- |
  | `repo status [id]` | `GET /api/repos/status` |
  | `repo diff <id> [--file F]` | `GET /api/repos/diff` |
  | `repo pull <id>` / `repo push <id>` | `POST /api/repos/pull` / `push` |
  | `repo resolve <id> --file F --side ours\|theirs` | `POST /api/repos/resolve` |

  仓库模块的面板同时去掉「分支」「状态」两列与行内 diff/pull/push 按钮。
  **保留**登记本身：`repo list|get|add|update|remove|scan|open` 与面板的仓库页。

  为什么砍：git 客户端是无底洞。上一版把 porcelain 解析成「分支 · 领先落后 ·
  变更 · 冲突」显示在面板上，但点进冲突只能读原始 diff 文本——没有 hunk 级取舍、
  没有 merge/rebase 策略、没有凭据、进度与失败恢复。要做成能用的东西就得自己写
  一个 git 客户端，而那件事 IDE 和几十个成熟 GUI 做得永远比这里好。
  更危险的是**给出可信外观的错误结论**：面板显示「干净」，用户就不再跑
  `git status` 了，而那个实现只看了 porcelain 首行。
  详见 README 新增的「为什么不管 git」一节。

- **GitHub 连接器模块（`gh *`）**：与 git 同批移除。它依赖 gh CLI 登录态，
  而模块的价值本就在于「和已登记的本地仓库对上」——仓库不再有分支/远端信息后，
  它退化成一层比浏览器书签好不了多少的外壳。面板的「GitHub」页随之撤掉。

### Changed

- **`repo update` 新增 `--path`**，可以改登记路径；改到已被别的记录占用的路径会
  显式报错（与 `repo add` 的重复检查同一条规则）。
- **`repo scan` 不再调用 git**：只做 `.git` 存在性检查（目录或文件——worktree /
  submodule 下是文件），因此没装 git 的机器也能用。
- **项目候选下拉不再自动并入已登记仓库**：候选只有设置里维护的那一份。
  两个来源意味着用户要同步两处心智模型，而合并语义（哪个覆盖哪个）没人记得住。
- `repo-hub` skill 文档同步：`references/repo-ops.md`（仓库状态/diff/拉推/冲突 SOP）
  删除，替换为 `references/repo-registry.md`（登记清单的增删改查 + 「本工具不管 git」
  的边界说明与替代做法）；`SKILL.md` 的适用场景、原则、主流程、路由表一并改写；
  `references/agent-workflow.md` 里基于 `repo status` 的批量编排示例改为登记清单示例。

### Notes

- **升级提示**：store.json 的 `repos[]` 结构不变，旧数据无需迁移；但只存在于
  git 状态里的信息（分支、领先落后）本工具不再知道，需要时用
  `git -C <path> status -sb`。
- 测试同步：冒烟测试删掉 git fixture（不再依赖机器上装了 git），新增
  `repo update --path`、重复路径拒绝、`repo scan` 只认 `.git` 三类断言。

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
