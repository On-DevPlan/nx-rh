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
目标（迁移落点）      user:    ~/<platform.globalDir>/<name>
                     project: <启动目录>/<platform.dir>/<name>
```

- 订阅源可以订阅**多个、允许重叠**；当前主源用 `nx-rh skill hub` 查看 / 切换
- 目标 = 平台 × 作用域：`--platform` 选平台，`--to global|user|project|all` 选作用域
  （`global` 与 `user` 同义，都指 `~/`；缺省 `project`）
- 平台既可用 id，也可用自然别名：`--platform claude` / `wb` / `cursor` / `gemini` / `universal`
  （`nx-rh skill adapters` 会列出各自的绝对落点）
- `nx-rh skill adapters [--project <目录>]` 列出每个平台的**项目级与用户级绝对路径**——
  「把一个 skill 变成 .claude / .workbuddy / .cursor」在终端里直接可抄，无需先起面板
- **不做项目之间互迁**——项目目录只是落地副本，真相永远在订阅源里

## SOP

### 1. 零启动盘点：订阅源里有什么、在哪、做什么

```bash
nx-rh skill list [--source <路径>] [--project <项目根>] [--long] [--json]
```

- 默认一行一个：`名称 · 描述（截断）`；多订阅源时额外标出来源短名（如 `sl/skills`）
- `--long`：完整描述 + skill 目录 + 迁移现状（一个 skill 一块），不必起面板就能读清
- `--json`：每项含 `name / dir / description（不截断）/ source / cells[]`
  （`cells` = 每个平台 × 作用域的落点绝对路径与当前形态）——跨平台/跨机器复用时按它落地
- 另单列「未入 Hub」——平台目录里有、订阅源没有的 skill

### 2. 单 skill 详情与上下文

```bash
nx-rh skill show <name> [--project <项目根>]      # 完整描述 + 目录 + 各平台落点矩阵
nx-rh skill cat  <name> [--ref <相对路径>]        # 全文（SKILL.md 或某个 reference）
```

`skill show` 是最快的「这个 skill 能不能在 X 平台上用」判断入口：它把
`平台 × 作用域 → 落点绝对路径 → 当前形态（链接/实体/未迁移）` 一条条列出来。
`skill cat` 把订阅源 skill 的全文交给外部 agent，让它在自己环境里也能获得完整上下文并自行迁移。

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

- 默认走 `symlink`（Windows 自动 junction，免管理员）；链接失败自动降级复制并标注原因
- **目的仓库不做冲突检测，直接被订阅源覆盖**：目标只是落地副本，订阅源里永远有一份，覆盖可恢复。
  真正要做冲突检测的是**订阅源之间**（见下节「来源冲突检测」）

### 4. 撤销迁移（目标侧移除）——可逆的另一半

```bash
nx-rh skill unmigrate <name...> --to user|global|project|all [--platform P] [--force]
nx-rh skill unmigrate --all --dry-run --to project            # 先看要移除哪些
```

- 与 `migrate` 参数完全对称，**迁移是可逆的**：软链接可自由删除，不触碰订阅源
- **实体副本需 `--force`**（可能是手改过的内容，删除不可逆）
- 返回 `blocked` 时列出待确认的目标（实体副本需 --force）

### 5. 提交（目标副本 → 订阅源）

```bash
nx-rh skill submit <name...> [--to project] [--platform P] [--force]
nx-rh skill submit --all --dry-run                              # 预演：把「未入 Hub」那批一次收进订阅源
```

把平台目录里的实体 skill 收进当前订阅源，随后**删除目标实文件**、改回指向订阅源的链接。
这是「唯一实文件 = 订阅源」这条规范的落地动作。目标已是链接时返回 `skipped`（无需提交）。

### 6. 物化（链接 → 实体）

```bash
nx-rh skill materialize <name> --to user|project [--platform P]
```

把目标侧的链接替换成独立副本，之后不再随订阅源实时变化。已是实体时返回 `converted: false`。

## 订阅源管理

```bash
nx-rh skill hub list                             # 订阅源清单（* 为当前主源）
nx-rh skill hub add <路径>                       # 订阅一个 skill 目录（并设为主源）
nx-rh skill hub remove <路径>                    # 取消订阅（不动磁盘）
nx-rh skill hub <路径>                           # 直接切换当前主源
```

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

> 批量前先 `--dry-run` 看一眼：它把每个 skill 在每个落点上的动作都列出来，
> 既避免误操作，也方便 agent 先给出方案再执行。`--exclude` 是一等参数——
> 「全都要，除了某几个」才是全量迁移的真实需求。

## skill 的增改删（CRUD）

订阅源里的 skill 实体可以直接增改删（只动订阅源那份实文件；目标副本由迁移覆盖）：

```bash
nx-rh skill add <name> --description "一句话描述"     # 新建；已存在同名 → CONFLICT
nx-rh skill update <name> --content "$(cat SKILL.md)"  # 改写全文（须含 name/description frontmatter）
nx-rh skill remove <name>                              # 删除；目标侧还有引用时 blocked，--force 继续
```

- `update` 校验 frontmatter：缺 name/description、或 name 与目录名不一致 → `INVALID_INPUT`
- `remove` 的语义：目标侧还有副本/链接 → `blocked` 并列出（删了会悬空）；`--force` 只删订阅源这份，
  悬空目标之后用迁移重建
- 面板：「＋ 新建」在卡片头；编辑 / 删除在每个 skill 的详情弹窗里

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
| 目录不存在 | `missing` | 订阅的路径没了 | `skill hub remove` |
| 没有实文件 skill | `empty` | 空目录，或里面全是链接 | 确认订阅的是不是真相源 |
| 嵌套订阅 | `nested` | A 在 B 里面，会重复计数 | 只订阅叶子那层 |
| 同一根重复订阅 | `same-root` | 两个路径解析到同一个 skills 根 | 留一个 |
| 同名且内容不同 | `conflict` | 两个真相源打架 | 保留一份，迁移时 `--source` 指定 |
| 同名且内容一致 | `duplicate` | 重复订阅（无害） | 清理多余订阅 |

## 平台与落点

```bash
nx-rh skill adapters [--project <目录>]                       # 每平台的项目级 / 用户级绝对落点
nx-rh skill platform [claude-code workbuddy ...]               # 启用哪些平台（首个为默认平台）
```

平台 id 与别名（别名只是输入便利，表仍是唯一真相源）：

| id | 别名 | 项目级 | 用户级 |
| --- | --- | --- | --- |
| claude-code | claude · cc | `.claude/skills` | `~/.claude/skills` |
| workbuddy | wb | `.workbuddy/skills` | `~/.workbuddy/skills` |
| agents | universal | `.agents/skills` | `~/.agents/skills` |
| codebuddy | cb | `.codebuddy/skills` | `~/.codebuddy/skills` |
| cursor | — | `.cursor/skills` | `~/.cursor/skills` |
| codex | — | `.codex/skills` | `~/.codex/skills` |
| gemini-cli | gemini | `.gemini/skills` | `~/.gemini/skills` |
| copilot | — | `.copilot/skills` | `~/.copilot/skills` |
| windsurf | — | `.windsurf/skills` | `~/.codeium/windsurf/skills` |
| iflow-cli | iflow | `.iflow/skills` | `~/.iflow/skills` |

## 判定与正反例

| 反例 | 问题 | 正例 |
| --- | --- | --- |
| 冲突后直接 `--force` 覆盖 | 丢掉目标侧真实改动且无记录 | 目的仓库本就直接覆盖；要改内容请改**订阅源**，再迁移出去 |
| 对链接形态的 skill 跑 submit | 无意义（本就指向某个源） | 看到 `linkType` 非空就跳过 |
| 用 `copy` 做常态化迁移 | 每次都要比 md5，改动无法自动流动 | 默认 `symlink`；仅当目标环境不支持链接时用 `copy` |
| 把项目目录当真相源反复互拷 | 两份会分叉 | 真相只在订阅源；项目侧靠迁移与提交收敛 |

## 失败排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `未设置 Skill Hub 订阅源` | 没有设置主源 | `nx-rh skill hub add <路径>` |
| `订阅源里没有该 skill` | 主源缺该 skill | 换主源，或从平台目录 `skill submit` 收进源 |
| `目标目录里没有该 skill` | 目标侧不存在 / 平台或作用域不对 | 核对 `skill show <name>` |
| `未知平台: xxx（可用: …）` | `--platform` 写了不存在的平台 | 用 `nx-rh skill adapters` 看 id 与别名（claude / wb / cursor…） |
| 迁移后仍是复制而非链接 | 创建链接失败（权限/文件系统） | 结果里 `degraded` + `degradedReason` 已说明；可改用 `--mode copy` 明确意图 |
| 描述显示「(无描述)」 | SKILL.md frontmatter 解析异常 | 检查 frontmatter 是否闭合；CRLF/引号/块标量自 v0.2.2 起已支持 |
