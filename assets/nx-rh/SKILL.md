---
name: nx-rh
description: 当用户需要登记本机仓库 / 扫描发现仓库 / 维护仓库清单（路径、描述、标签、备注），需要订阅 Skill Hub 并把 skill 迁移到用户目录或项目目录（软链接或实体复制）、把平台目录里的 skill 提交回订阅源收敛为唯一实文件、盘点项目目录里实际存在的 skill，需要查看与修改 Windows 持久化环境变量与 PATH（命令找不到、改了不生效），或需要用 git worktree 开多个工作树、在工作树里获取主项目最新上下文、登记并同步 .gitignore 里的扩展文件时使用。触发词：仓库登记、仓库扫描、Skill Hub、skill 订阅、skill 迁移、软链接、实体副本、skill 提交、平台适配器、项目里的 skill、环境变量、PATH、工作树、worktree、多工作树、扩展文件、.gitignore 同步、主项目上下文。所有能力都同时提供同构 CLI（加 --json 供程序消费）与本地 Web 面板。
agent_created: true
---

# nx-rh — 本机仓库登记与 Skill 管理

## 不适用

- **纯 git 操作**（通用状态 / diff / pull / push / 冲突落地）——除工作树模块（`wt`）的 worktree 专属操作外，本工具不碰 git，用 git 自己或 IDE
- **远程仓库 / 多用户 / 云端协作**——这是单机本机工具，只管本机目录与 Windows 注册表，不做团队同步

## 适用场景

- 需要知道本机登记了哪些仓库、它们在哪、是干什么的（仓库**目录清单**，不含 git 状态）
- 需要把某个目录登记为受管仓库，或扫描某个目录批量发现仓库
- 需要订阅 Skill Hub（skill 目录），把 skill 迁移到用户目录或项目目录（软链接或实体复制）
- 需要把平台目录里散落的 skill 收进订阅源（提交），收敛「唯一实文件 = 订阅源」
- 需要盘点某个项目目录里实际存在哪些 skill（`skill hub project skills`，含「独立未入 Hub」标注）
- 需要把 skill 的完整文档交给外部 agent（`skill cat`），让它获得上下文并自行迁移
- 需要查看 / 修改 Windows 的持久化环境变量或 PATH（命令找不到、找到旧版本、改了不生效）
- 需要为一件事开独立的 git worktree，在工作树里快速获取主项目最新上下文
- 需要把 `.gitignore` 里不进工作树的文件/目录登记为扩展文件，只读提醒（nx-rh 不代复制）

## 核心原则

1. **CLI 优先，需要解析就加 `--json`**：查询先跑 CLI；要把结果交给程序或自己解析时统一加 `--json`（输出纯净：无 ANSI、无多余文本、错误非零退出）。
   本手册按**场景**组织，不追求穷举命令。要完整命令面就跑 `nx-rh help --json` 或
   `nx-rh routes --json`——那两份由代码生成，不可能与实现脱节。手册里没写到某条命令
   不等于它不存在（只保证反过来：手册里写了的都真实存在）。
2. **先读后写**：任何写操作（migrate / unmigrate / submit / materialize / env set）执行前，先用 `skill hub list` / `skill hub show` 看清现状。
3. **冲突不静默**：迁移到已存在且内容不同的目标时，命令返回 `conflict` 状态并列出文件清单，必须显式 `--force` 或手动处理；不要用 `--force` 掩盖不确定性。
4. **幂等重试**：重复执行同一命令是安全的（已就绪会返回 `skipped`）；失败以非零退出码 + 可读错误返回，可安全重试。
5. **只动该动的**：`repo remove` 只注销登记、不碰磁盘；`skill unmigrate` 删除实体副本需 `--force`；删除或覆盖类操作前先确认目标路径与影响面。
6. **订阅源是唯一真相源**：skill 的实文件只应存在于订阅源（Skill Hub）；平台目录里的是落地副本。迁移默认走 symlink（Windows 自动降级 junction，免管理员）；链接创建失败会降级为复制，并在结果里标注降级原因。`--mode copy` 是显式例外：要一份独立副本（平台间互拷、不随订阅源变化）时按次指定；对实体副本跑 `unmigrate`/`purge` 需 `--force`（可能含本地改动）。
7. **单一数据源**：所有状态集中在 `~/.nx-rh/store.json`（可用 `NX_RH_STORE` 覆盖，测试务必指向临时目录）。
8. **环境变量先 dry-run**：`env` 的每条写命令都支持 `--dry-run`，且每次写入前会自动快照。
   它改的是操作系统注册表（系统级影响整台机器），所以**先看 diff 再落盘**；
   改 PATH 一律用 `env path add|remove`，不要手拼字符串。
9. **git 边界**：本工具不做通用 git 操作（状态 / diff / pull / push / 冲突落地）；
   **唯一例外是工作树模块 `wt`**——它独占 git-worktree 操作（add/remove/rebase/扩展文件同步），
   仍不做远端协作。`repo` 模块继续只维护登记信息。

## 主流程（最短路径）

```
1. 定位：nx-rh repo list  ·  nx-rh skill hub list [--source <路径>] [--project <项目根>]
2. 诊断：nx-rh repo get <id>  ·  nx-rh skill show <name>
3. 行动：nx-rh repo add|scan|update  ·  nx-rh skill hub migrate|unmigrate|submit|materialize|purge ...
4. 复核：重跑第 2 步，确认状态已按预期变化
5. 汇报：说明实际执行了什么 + 剩余风险（尤其冲突未处理项）
```

> **两个 list 别混**：`skill list` 列的是**包里能装的内置 skill**；
> `skill hub list` 列的是**你订阅源里的 skill**。业务命令（show / cat / add / update /
> remove / purge / migrate / unmigrate / submit / materialize）全都挂在 `skill hub` 下。
> 订阅源本身用 `skill hub sources | subscribe | unsubscribe | main | check`。
>
> 另有配套 skill **`rh-collect`**（`skill install rh-collect` 或 `skill install --group=rh-collect`）：
> 把 agent 发现的 git 仓库**先问过用户**再登记进仓库清单。
>
> 还有配套 skill **`rh-worktree`**（`skill install rh-worktree` 或 `skill install --group=rh-worktree`）：
> 自动适配主仓库/工作树，规范创建工作树并显示主项目变更；工作树内可查看主项目被 ignore 的
> 关注项（如 `.tool` 本地工具目录）的主项目全路径、只读参考——**nx-rh 不复制文件**，
> 需要内容时 agent 自行复制。

## 场景路由（ref-map）

| 场景 | 信号 | 何时读取 | 路径 |
| --- | --- | --- | --- |
| 仓库登记 | 登记 / 扫描 / 维护仓库清单（路径、描述、标签、备注） | 涉及仓库目录清单的增删改查时 | [[repo-registry]] |
| Skill 订阅与迁移 | 订阅源与目标目录、迁移 / 撤销 / 提交 / 物化、给外部 agent 上下文 | 涉及 skill 的订阅、迁移与收敛时 | [[skill-hub]] |
| 环境变量与 PATH | 查看 / 修改持久化环境变量、命令找不到、改了不生效 | 涉及 Windows 环境变量或 PATH 时 | [[env-manage]] |
| Agent 批量编排 | 多仓库/多 skill 批量处理、要纯 JSON、要幂等重试 | 把自己当执行器连续操作时 | [[agent-workflow]] |
| 工作树与扩展文件 | git worktree 开多工作树、主项目上下文、.gitignore 文件登记与同步 | 涉及工作树生命周期或扩展文件时 | [[worktree-manage]] |

> 扩展约定：新增场景时，先在 `references/<场景>.md` 写完整 SOP（步骤、判定标准、正反例），再在上表补一行并写清「何时读取」。主文档只保留原则与路由，场景级细节一律下沉。

## 检查清单

- [ ] 写操作前已读过现状（list / show）
- [ ] 需要程序消费时加了 `--json`
- [ ] 冲突未被 `--force` 掩盖，或已获得明确授权
- [ ] 环境变量类写入已先 dry-run，且改的是正确的 scope（user / system）
- [ ] 链接/复制降级情况已如实报告
- [ ] 结果向用户汇报了「做了什么 + 剩余风险」
