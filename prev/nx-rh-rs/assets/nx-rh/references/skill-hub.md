# 场景：Skill Hub 订阅与迁移

> 归属主文档 [[nx-rh]] 的「Skill 订阅与迁移」路由。本文件是该场景的完整 SOP 与判定标准。

## 何时进入

- 要把订阅源（Skill Hub）里的 skill 迁移到本机用户目录或项目目录
- 要把平台目录里散落的 skill 收进订阅源（提交），收敛「唯一实文件 = 订阅源」
- 要判断某个 skill 来自哪个源、已经迁移到了哪些平台
- 要把 skill 的完整文档交给外部 agent（让它获得上下文并自行迁移）

## 数据模型

```
订阅源（Skill Hub）  <src>/<name>/SKILL.md              ← 唯一可信源（目录下直接是各 skill）
目标（安装位置）      user:    ~/<platform.globalDir>/<name>
                     project: <启动目录>/<platform.dir>/<name>
```

- 订阅源可以订阅**多个、允许重叠**；当前主源用 `nx-rh skill hub main` 查看 / 切换
- 目标 = 平台 × 作用域：`--platform` 选平台，`--to global|user|project|all` 选作用域
  （`global` 与 `user` 同义，都指 `~/`；缺省 `project`）
- 平台既可用 id，也可用自然别名：`--platform claude` / `wb` / `cursor` / `gemini` / `universal`
  （`nx-rh skill adapters` 会列出各自的绝对安装位置）
- `nx-rh skill adapters [--project <目录>]` 列出每个平台的**项目级与用户级绝对路径**——
  「把一个 skill 变成 .claude / .workbuddy / .cursor」在终端里直接可抄，无需先起面板
- **不做项目之间互迁**——项目目录只是落地副本，真相永远在订阅源里

## 命令命名空间（`skill` vs `skill hub`）

| 命令 | 管什么 |
| --- | --- |
| `skill list` / `install` / `get` / `groups` | **包内的内置 skill**（随 nx-rh 发布的手册）；`--group <key>` 按组一键装 |
| `skill hub list` / `show` / `cat` / `add` / `update` / `remove` / `purge` | 你订阅源里的 skill（本 ref 讲的就是这一套） |
| `skill hub migrate` / `unmigrate` / `submit` / `materialize` | 订阅源 ↔ 平台目录的搬运 |
| `skill hub sources` / `subscribe` / `unsubscribe` / `main` / `check` | 订阅源本身 |
| `skill hub search` / `skill hub remote ...` | **远程订阅**：从网络装外部 skill（见「远程订阅」节） |

一句话：`skill list` 列的是**包里能装的**，`skill hub list` 列的是**你订阅源里的**。
旧路径（`skill list` 指业务清单、`skill hub add/remove` 指订阅源）已验证过的别名仍可用，
但**新写的东西请按上表**。

## SOP

### 1. 零启动盘点：订阅源里有什么、在哪、做什么

```bash
nx-rh skill hub list [--source <路径>] [--project <项目根>] [--long] [--json]
```

- 默认一行一个：`名称 · 描述（截断）`；多订阅源时额外标出来源短名（如 `sl/skills`）
- `--long`：完整描述 + skill 目录 + 迁移现状（一个 skill 一块），不必起面板就能读清
- `--json`：每项含 `name / dir / description（不截断）/ source / cells[]`
  （`cells` = 每个平台 × 作用域的安装位置绝对路径与当前形态）——跨平台/跨机器复用时按它落地
- 另单列「不在订阅源」——平台目录里有、订阅源没有的 skill
- `nx-rh skill hub project skills [--project <项目根>]`：当前项目目录里**实际存在**的 skill
  （扫全部适配器的项目级目录，未启用平台只标注不裁剪；每项标 `inHub`）

### 2. 单 skill 详情与上下文

```bash
nx-rh skill show <name> [--project <项目根>]      # 完整描述 + 目录 + 文件清单 + 各平台安装状态矩阵
nx-rh skill cat  <name> [--ref <相对路径>]        # 全文（SKILL.md，或 skill 目录里任意一个文件）
```

`skill show` 是最快的「这个 skill 能不能在 X 平台上用」判断入口：它把
`平台 × 作用域 → 安装位置绝对路径 → 当前形态（链接/实体/未安装）` 一条条列出来，并给出该
skill 目录下的**文件清单**——不止 SKILL.md，`scripts/` 与 `references/` 往往才是关键。

`skill cat` 把 skill 全文交给外部 agent，让它在自己环境里也能获得完整上下文并自行迁移。

**两个命令都认「不在订阅源」的 skill**（订阅源里没有、只躺在平台目录里的那些）：
安装位置是链接就**顺着链接读**，读到的是链接目标的内容；断链（目标已被删）会明确报
`… 的安装位置是断链：<位置> → <目标>（目标已不存在）`，而不是含糊地说「订阅源里没有」。

### 3. 迁移（订阅源 → 目标）——可逆

```bash
nx-rh skill migrate <name...> --to user|global|project|all [--platform P] [--mode symlink|copy]
nx-rh skill adapt   <name> --platform cursor --to project      # adapt 是 migrate 的别名（口语：把 skill 变成 .cursor）
nx-rh skill migrate --all --to global --platform wb            # 批量；--to global 即用户级
nx-rh skill migrate --all --exclude "gh-*" --dry-run --to project   # 先预演再执行
nx-rh skill migrate clash --source <路径>                      # 跨源冲突时，指定采用哪个订阅源的版本
```

结果状态：

| status | 含义 | 后续 |
| --- | --- | --- |
| `ok` | 完成（`linkType` 标明软链接，或为复制） | 完成 |
| `ok` + `skipped` | 已是同源链接，无需变更 | 完成 |
| `blocked` | **跨订阅源冲突**：同名实文件在多个源且内容不同 | 用 `skill hub check` 看，解决订阅或 `--source` 指定 |

- **迁移形态**：默认 `symlink`（Windows 自动 junction，免管理员），链接失败自动降级复制并标注原因；
  `--mode copy` 按**次**显式要实体副本——适合平台之间互拷、或要一份不随订阅源变化的独立快照。
  面板上同款能力：安装状态矩阵的未安装行有「迁移」（软链接）与「实体」（复制）两个按钮，
  已安装的链接行有「转实体」（物化）。
- **目的仓库不做冲突检测，直接被订阅源覆盖**：目标只是落地副本，订阅源里永远有一份，覆盖可恢复。
  真正要做冲突检测的是**订阅源之间**（见下节「来源冲突检测」）

### 4. 撤销迁移（目标侧移除）——可逆的另一半

```bash
nx-rh skill unmigrate <name...> --to user|global|project|all [--platform P] [--force]
nx-rh skill unmigrate --all --dry-run --to project            # 先看要移除哪些
```

- 与 `migrate` 参数完全对称，**迁移是可逆的**。两种形态语义不同：
  - **软链接**：撤销 = 摘掉指针，订阅源真相不受影响，可自由反复
  - **实体副本**：删除 = 连本地改动一起删、不可恢复（订阅源里那份仍在），需 `--force`
- 返回 `blocked` 时列出待确认的目标（实体副本需 --force）

### 5. 提交（目标副本 → 订阅源）

```bash
nx-rh skill submit <name...> [--to user|global|project|all] [--platform P] [--force] [--into <订阅源>]
nx-rh skill submit --all --dry-run                              # 预演：把「不在订阅源」那批一次收进订阅源
```

把平台目录里的实体 skill 收进订阅源，随后**删除目标实文件**、改回指向订阅源的链接。
这是「唯一实文件 = 订阅源」这条规范的落地动作。目标已是链接时返回 `skipped`（无需提交）。

**`--into <订阅源>`**：收进哪个已订阅的源（须在 `skill hub sources` 清单里；缺省当前主源）。
未订阅的路径报 `INVALID_INPUT` 并列出已订阅清单。与 migrate 的 `--source` 刻意区分：
`source` = 来源冲突时用哪个源的内容；`into` = 提交时落到哪个源。

**`--to` 缺省 `all`**：不在订阅源的 skill 常常落在**用户级**平台目录里（如 `~/.claude/skills`），
只扫项目级会报「目标目录里没有该 skill」——而 `--all` 正是主推用法。要只收某一侧时再显式写
`--to project` / `--to user`。

### 6. 物化（链接 → 实体）

```bash
nx-rh skill materialize <name> --to user|project [--platform P]
```

把目标侧的链接替换成独立副本，之后不再随订阅源实时变化。已是实体时返回 `converted: false`。

## 订阅源管理

```bash
nx-rh skill hub sources                          # 订阅源清单（* 为当前主源；远程订阅恒排最后）
nx-rh skill hub subscribe <路径>                 # 订阅一个 skill 目录（并设为主源）
nx-rh skill hub unsubscribe <路径>               # 取消订阅（不动磁盘）
nx-rh skill hub main [<路径>]                    # 查看 / 切换当前主源
```

## 远程订阅（外部 skill）

需要**从网络装 skill**（skills.sh 搜到的、别人仓库里的）时走这条线。远程订阅是一个固定仓库
`~/.nx-rh/远程订阅/`，与普通订阅源同权——里面的 skill 照常 `show / cat / migrate / submit`。

```bash
nx-rh skill hub search <关键词> [--owner <组织>]      # 搜 skills.sh 注册表（结果里的 source 可直接导入）
nx-rh skill hub remote import <spec> --dry-run        # 先看清上游有什么（列名称/描述/版本），不拷贝
nx-rh skill hub remote import <spec> [--name <skill>] # 导入（spec: owner/repo、git URL、归档 URL）
nx-rh skill hub remote list                           # 内容清单（来源 / 版本指纹 / 安装状态）
nx-rh skill hub remote update [<name...>]             # 按来源重拉更新（指纹变了才换）
nx-rh skill hub remote add <name>                     # 手写一个定义放进远程订阅
nx-rh skill hub remote link <name> <目录>             # 软链：别处的 skill 链进来
nx-rh skill hub remote link-out <name> <目录>         # 软链：远程订阅里的 skill 链出去
nx-rh skill hub remote remove <name...>               # 移除（平台侧副本另行 skill purge）
```

- `subscribe` 只收**本地目录**；远程规格一律 `remote import`（给错了会提示）
- 每个 skill 记来源与版本指纹，`update` 只换有变化的；上游删了的如实报告
- `migrate --all-sources` 可把**全部订阅源**（含远程订阅）铺到平台

## 批量选择（全量迁移，不手点）

`migrate` / `unmigrate` / `submit` 共用同一套选择参数：

```bash
nx-rh skill migrate --all --to project                     # 全量迁移
nx-rh skill migrate --all --exclude "gh-*,test-*" --to project   # 全都要，除了这几个
nx-rh skill migrate --include "nx-*" --to user             # 按模式只取一批
nx-rh skill migrate --all --match "CI" --to user           # 按描述关键词（业务需求驱动）
nx-rh skill migrate alpha beta gamma --to project          # 点名多个
nx-rh skill migrate --all --dry-run --to project           # 预演：只列计划，不落盘
```

| 参数 | 含义 |
| --- | --- |
| `<name...>` | 点名（可多个）；**其中一个不存在就报错**，避免批量里静默漏迁移 |
| `--all` | 当前主源的全部 skill（`unmigrate` / `submit` 则是「目标目录里扫到的全部」） |
| `--include <模式>` | 按名称取子集；支持 `*` 通配，否则子串匹配（不区分大小写） |
| `--exclude <模式>` | 从选集中排除；同样支持 `*` 与子串，可逗号分隔多个 |
| `--source <路径>` | 仅在跨源冲突时用：指定采用哪个订阅源的版本 |
| `--match <关键词>` | 按 **description** 过滤——「按业务需求挑」的那一条 |
| `--dry-run` | 只判定不落盘，输出计划（将创建 / 将覆盖 / 已是最新） |

> 批量前先 `--dry-run` 看一眼：它把每个 skill 在每个安装位置上的动作都列出来，
> 既避免误操作，也方便 agent 先给出方案再执行。`--exclude` 是一等参数——
> 「全都要，除了某几个」才是全量迁移的真实需求。

## skill 的增改删（CRUD）

订阅源里的 skill 实体可以直接增改删（只动订阅源那份实文件；目标副本由迁移覆盖）：

```bash
nx-rh skill add <name> --description "一句话描述"     # 新建；已存在同名 → CONFLICT
nx-rh skill update <name> --content "$(cat SKILL.md)"  # 改写全文（须含 name/description frontmatter）
nx-rh skill remove <name>                              # 只从订阅源删；目标侧还有引用时 blocked，--force 继续
nx-rh skill purge <name> [--dry-run] [--force]         # 彻底删除：所有平台安装位置 + 订阅源里的实文件
```

- `update` 校验 frontmatter：缺 name/description、或 name 与目录名不一致 → `INVALID_INPUT`
- **`remove` 与 `purge` 的分工**（后果不同，所以是两个命令）：
  - `remove` = 「下架，但保留各平台安装位置」。目标侧还有副本/链接 → `blocked` 并列出（删了会悬空）；
    `--force` 只删订阅源这份，悬空目标之后用迁移重建
  - `purge` = 「这个名字不该存在了」。安装位置（链接也含）与订阅源那份一起删；
    先 `--dry-run` 看清单，安装位置里有**实体副本**时需要 `--force`（可能含本地改动）
- **不在订阅源的 skill 只有 `purge` 能删**：订阅源里根本没有它，`remove` 只会 `NOT_FOUND`
- `purge` **删链接不会碰它的目标**——链接只是指向别处的一个指针，所以清掉一批失效的游离链接是安全的
- 面板：详情页本身就是查看器（描述 / 平台安装状态 / 操作，文件预览折叠在最后）；
  「从订阅源删除」与「彻底删除…」是两个按钮，后者先弹 dry-run 清单再确认；
  **不在订阅源的 skill 详情页没有迁移按钮**——主操作是「收进订阅源…」（弹窗选源）+ 彻底删除

## 来源冲突检测（只在订阅源之间）

订阅源是唯一可信源，因此**来源之间本不该有冲突**；出现同名实文件 = 订阅配置有问题。
目的仓库**不参与**冲突检测——它只是落地副本，直接被订阅源覆盖即可（hub 里永远有一份，可恢复）。

```bash
nx-rh skill hub check          # 来源健康：目录缺失 / 空源 / 嵌套订阅 / 重复根 / 跨源同名冲突
```

来源侧只认**实文件**：源目录里的链接是别的真相源的落地副本（典型：把 `~/.claude/skills`
订阅为临时来源，里面大半是指向其它源的链接），**不算来源**，也不制造假冲突。

| 问题 | kind | 含义 | 处理 |
| --- | --- | --- | --- |
| 目录不存在 | `missing` | 订阅的路径没了 | `skill hub unsubscribe` |
| 没有实文件 skill | `empty` | 空目录，或里面全是链接 | 确认订阅的是不是真相源 |
| 嵌套订阅 | `nested` | A 在 B 里面，会重复计数 | 只订阅叶子那层 |
| 同一根重复订阅 | `same-root` | 两个路径解析到同一个 skills 根 | 留一个 |
| 同名且内容不同 | `conflict` | 两个真相源打架 | 保留一份，迁移时 `--source` 指定 |
| 同名且内容一致 | `duplicate` | 重复订阅（无害） | 清理多余订阅 |

## 平台与安装位置

```bash
nx-rh skill adapters [--project <目录>]                       # 每平台的项目级 / 用户级绝对安装位置
nx-rh skill platform [claude-code workbuddy-ai ...]            # 启用哪些平台（首个为默认平台）
```

平台 id 与别名（别名只是输入便利，表仍是唯一真相源）。新装 store 默认只启用 `claude-code`，
其余平台要显式 `skill platform` 开（首个为默认平台）：

| id | 别名 | 项目级 | 用户级 |
| --- | --- | --- | --- |
| claude-code | claude · cc | `.claude/skills` | `~/.claude/skills` |
| workbuddy | wb | `.workbuddy/skills` | `~/.workbuddy/skills` |
| workbuddy-ai | workbuddyai · wbai · wb-ai | `.workbuddy-ai/skills` | `~/.workbuddy-ai/skills` |
| doubao | doubao | `.doubao/skills` | `~/Doubao/skills` |
| doubao-work | doubaowork · dbw | `.doubaowork/skills` | `~/DoubaoWork/skills` |
| qianwen | qwenwork · qwen · qw | `.qwenworkcn/skills` | `~/.qwenworkcn/skills` |
| trae-cn | trae | `.trae/skills` | `~/.trae-cn/skills` |
| qoder | — | `.qoder/skills` | `~/.qoder/skills` |
| qoder-cn | qodercn | `.qoder-cn/skills` | `~/.qoder-cn/skills` |
| agents | universal | `.agents/skills` | `~/.agents/skills` |
| codebuddy | cb | `.codebuddy/skills` | `~/.codebuddy/skills` |
| cursor | — | `.cursor/skills` | `~/.cursor/skills` |
| codex | — | `.codex/skills` | `~/.codex/skills` |
| gemini-cli | gemini | `.gemini/skills` | `~/.gemini/skills` |
| copilot | — | `.copilot/skills` | `~/.copilot/skills` |
| windsurf | — | `.windsurf/skills` | `~/.codeium/windsurf/skills` |
| iflow-cli | iflow | `.iflow/skills` | `~/.iflow/skills` |

千问办公（qianwen）官方只写明用户级 `~/.qwenworkcn/skills`，**无项目级约定**——项目级那一格只是占位，
迁到那里千问读不到，要生效用 `--to global`。

WorkBuddy 分国内版（workbuddy.cn，`.workbuddy/skills`）与国际版（workbuddy.ai，`.workbuddy-ai/skills`）：
同族不同产品、目录也不同名，两行都保留。国际版两级同名 `.workbuddy-ai/skills`，用户级本机实测
（应用启动即建，技能扫描的 watch 目录就是它），项目级也在应用的项目目录约定表里，两级都真生效。
裸 `workbuddy` / `wb` 归国内版（先有产品），国际版用 `workbuddy-ai` / `workbuddyai` / `wbai`；
显示名连写 `WorkBuddyAI`（不带空格），带空格会与国内版坍缩成同一个 `workbuddy` 勋章。

Trae 国内版用户级是 `~/.trae-cn/skills`，项目级两版共用 `.trae/skills`；国际版用户级应为 `~/.trae/skills`，
未装未实测，要聚焦国际版就在 `ADAPTERS` 里补一行 `id: 'trae'`。

Qoder 分国际版（qoder.com）与中国版（qoder.com.cn）：国际版两级目录同名 `.qoder/skills`，官方两级都写明、
用户级本机实测。中国版整套用户配置独立在 `~/.qoder-cn/`，用户级 `~/.qoder-cn/skills` 本机实测；项目级
无文档也无实体佐证，表里那格按 `.<id>/skills` 惯例占位，迁过去读不到就 `--to global`。别名 `qodercn`，
裸 `qoder` 维持归国际版，中国版用 `qoder-cn` / `qodercn`。显示名连写 `QoderCN`（不带空格）——Web 平台勋章取显示名首词，带空格会和国际版坍缩成同一个 `qoder` 勋章。

DoubaoWork（豆包办公，桌面端）与「豆包」是同族不同产品：用户级落点是「非隐藏 + 产品名」的
`~/DoubaoWork/skills`（与 `~/Doubao/skills` 同款，应用启动时自动创建，本机实测存在）；内置技能在
`AppData/.../workspace/.skills`（应用自带，别往那放用户内容），`workspace/.user_skills` 也会被扫，
但标准用户安装位置是 `~/DoubaoWork/skills`。项目级无文档也无实体佐证，表里那格是占位，
读不到就 `--to global`。别名 `doubaowork` / `dbw`，裸 `doubao` 仍归「豆包」。

## 判定与正反例

| 反例 | 问题 | 正例 |
| --- | --- | --- |
| 冲突后直接 `--force` 覆盖 | 丢掉目标侧真实改动且无记录 | 目的仓库本就直接覆盖；要改内容请改**订阅源**，再迁移出去 |
| 对链接形态的 skill 跑 submit | 无意义（本就指向某个源） | 看到 `linkType` 非空就跳过 |
| 把 `copy` 当默认迁移方式 | 每次都要比 md5，改动无法自动流动 | 默认 `symlink`；`--mode copy` 留给明确的例外：平台间互拷 / 要独立快照 / 目标环境不支持链接 |
| 对实体副本跑 `unmigrate` 不加 `--force` | 这是保护不是故障：实体可能含本地改动 | 确认不要了再加 `--force`；只是想断开同步用 `materialize`（保留副本） |
| 把项目目录当真相源反复互拷 | 两份会分叉 | 真相只在订阅源；项目侧靠迁移与提交收敛 |

## 失败排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `未设置 Skill Hub 订阅源` | 没有设置主源 | `nx-rh skill hub subscribe <路径>` |
| `这是远程规格：用 skill hub remote import …` | `subscribe` 只收本地目录，远程规格（owner/repo、URL）走导入 | 按提示改用 `nx-rh skill hub remote import <spec>` |
| `上游里没有找到 skill` / 下载失败 | spec 形态不对、网络不通、或上游仓库没有 skill | 先 `--dry-run` 核对；owner/repo / git URL / 归档 URL 三种形态任选 |
| `订阅源里没有该 skill` | 主源缺该 skill，且各平台目录里也没有 | 换主源；或从平台目录 `skill submit <name>` 收进源 |
| `目标目录里没有该 skill` | `--to` 选的那一侧没有它（不在订阅源的 skill 多半在**用户级**） | `skill submit` 缺省已是 `--to all`；核对 `skill show <name>` 的安装状态矩阵 |
| `… 的安装位置是断链：<位置> → <目标>（目标已不存在）` | 链接指向的目标被删/被移走了（常见于订阅源目录改名后留下的残留） | `skill purge <name>` 清掉；`skill show` 里 `broken: true` 就是这个原因 |
| `未知平台: xxx（可用: …）` | `--platform` 写了不存在的平台 | 用 `nx-rh skill adapters` 看 id 与别名（claude / wb / cursor…） |
| 迁移后仍是复制而非链接 | 创建链接失败（权限/文件系统） | 结果里 `degraded` + `degradedReason` 已说明；可改用 `--mode copy` 明确意图 |
| 描述显示「(无描述)」 | SKILL.md frontmatter 解析异常 | 检查 frontmatter 是否闭合；CRLF/引号/块标量自 v0.2.2 起已支持 |
