# 30 · 工作树（git worktree）管理：CLI + Web

> 给 agent 的操作手册：怎么用 `nx-rh wt init`、`nx-rh wt add` 等命令开工作树、拿主项目上下文、
> 登记并同步 `.gitignore` 里的文件。**怎么改这个模块本身**属于项目仓库
> （`README.md` 的「如何新增功能域」），不在本文件。

## 心智模型

`git worktree` 让**同一个仓库**在磁盘上有多个工作目录，每个目录停在不同分支：

- 分支 A 写到一半，不用 commit/stash，直接开另一个工作树做分支 B，两边互不干扰。
- 多个工作树共享同一个 `.git`，不需要重复 clone，秒级创建。
- 主工作树（main）就是最初那个目录；其余是链接工作树。

两个必须知道的事实：

1. **工作树只带走被 git 跟踪的文件**。`.gitignore` 里的东西（`.env`、本地密钥、
   数据目录、构建配置）不会出现在新工作树里——本模块把这些登记为**扩展文件**，
   用 `wt ext sync` 复制/链接进工作树。
2. **工作树清单的真相在 git**（`git worktree list`），不在本工具的 store。
   store 只登记 git 不知道的东西：扩展文件全路径 + 模块配置。

> 边界：`wt` 模块**独占 git-worktree 操作**；`repo` 模块仍只登记仓库、不碰 git。
> 本模块不做通用的 pull/push / 远端协作 / PR（那些用 git、IDE、gh）。

## 场景 A：初始化 + 开一个工作树（成功模板）

```bash
# 1) 初始化（幂等，可重复跑）：建工作树根；根若在主仓库内会自动登记进 .gitignore
nx-rh wt init

# 2) 用一句「要做什么」创建分支 + 工作树（分支自动命名为 feature/<会话名>）
nx-rh wt add "给登录页加图形验证码"
# → 输出最后一行：cd "C:/Users/你/.nx-rh/worktrees/<repo>/add-login-captcha"
```

复制输出里的 `cd "..."` 执行，就进入新工作树。

常用覆盖项（都可省略）：

```bash
nx-rh wt add "重构计费" --name billing-refactor --base develop
nx-rh wt add "试验" --root D:/wt/myrepo          # 本次工作树根覆盖配置
nx-rh wt checkout feature/old-branch             # 分支已存在：直接挂成工作树
```

## 场景 B：在工作树里快速获得主项目的最新上下文

工作树里待久了，主项目可能已经往前走了。**一条命令**拿齐主项目现状，
不用自己拼 `git -C <主仓库> status/log/rev-list`：

```bash
nx-rh wt context
```

输出包含：主项目分支 / HEAD / 是否有改动 / `status -sb` / 最近提交；
当前工作树相对主项目的领先（↑）落后（↓）；扩展文件在两侧的状态；
以及**建议指令**（落后就提示 rebase，缺扩展就提示 sync）。建议指令可直接复制。

```bash
nx-rh wt context --log 10      # 多带几条提交
```

## 场景 C：登记 .gitignore 里的扩展文件（全路径）

扩展文件按**绝对路径**登记，一个文件/目录一条：

```bash
# 自动发现：从 .gitignore 具体条目 + git 忽略清单里找（默认只建议、零副作用）
nx-rh wt ext discover

# 确认把候选全部登记
nx-rh wt ext discover --apply

# 或手工按全路径登记单个文件/目录
nx-rh wt ext add "D:/proj/my-project/.env.local" --label "本地密钥"
```

规则与安全：

- 被登记对象**必须被 git 忽略**；登记一个被跟踪文件会被阻止，确认要登记加 `--force`。
- 工作树根自身会被自动排除，不会被误登记成扩展文件。
- 主仓库外的路径可以登记，但无法按相对路径同步（会标注 `unmappable`）。
- 改标签：`nx-rh wt ext update <id> --label "新标签"`；
  查看：`nx-rh wt ext list`（在主仓库里显示「一致/变更」）、`nx-rh wt ext get <id>`。

## 场景 D：把扩展文件同步进工作树

**在目标工作树内**（cwd 是工作树）直接同步，目标自动取当前工作树：

```bash
nx-rh wt ext sync
```

或在任意位置按名字/路径指定目标：

```bash
nx-rh wt ext sync add-login-captcha
nx-rh wt ext sync --target D:/path/to/worktree --mode symlink   # 链接而非复制
nx-rh wt ext sync --ids x_abc,x_def                            # 只同步指定条目
nx-rh wt ext sync --dry-run                                   # 只看计划，不写盘
```

同步语义（以**主项目当前内容**为准）：

| 目标工作树现状               | 动作                                        |
| ---------------------------- | ------------------------------------------- |
| 没有该文件                   | 复制/链接主项目当前内容                     |
| 已有且与主项目当前内容一致   | `skipped`，不动                             |
| 已有但与主项目不同（本地改过）| `conflict`，**不覆盖**；确认覆盖加 `--force` |

Windows 说明：默认 `copy` 最稳；`symlink` 时目录用 junction（免管理员），
文件软链若因权限失败会自动降级为复制。

在工作树内查看扩展文件状态（一致/差异/缺失）：

```bash
nx-rh wt ext list
```

## 场景 E：主项目新提交后，同步（rebase）工作树

主项目往前走了，把工作树 rebase 到主项目当前分支：

```bash
nx-rh wt rebase add-login-captcha
nx-rh wt rebase                          # 在工作树内：目标取当前工作树
nx-rh wt rebase add-login-captcha --message "WIP：rebase 前自动提交"
```

- 工作树干净才 rebase；有未提交改动且没给 `--message` → 返回 `blocked`（不丢改动）。
- rebase 出冲突 → **自动 abort** 并返回 `conflict` 与输出，工作树回到 rebase 前状态；
  冲突要人工解，本工具不做 hunk 级取舍。

**Fanout**：一次性把主项目当前分支 rebase 到全部工作树。先出安全计划，确认再执行：

```bash
nx-rh wt fanout                # 计划：标注每个工作树「可执行 / 阻止（脏、领先）」
nx-rh wt fanout --yes          # 执行；遇到冲突立即停在该工作树
```

脏工作树、或相对主项目**领先**（有主项目没有的提交）的工作树会被拦下，
避免覆盖未保存的工作。

## 场景 F：移除工作树

```bash
nx-rh wt remove add-login-captcha             # 移除工作树，分支保留
nx-rh wt remove add-login-captcha --branch    # 连同分支一起删（未完全合并会保留并提示）
nx-rh wt remove add-login-captcha --force     # 工作树有改动时强制移除
nx-rh wt open add-login-captcha               # 在系统文件管理器里打开
nx-rh wt switch add-login-captcha             # 只打印 cd 指令
```

主工作树不可移除。`wt remove` 只动工作树登记与目录，不碰主项目文件。

## 全部命令都支持 `--json`

agent 做分支判断时用 `--json` 拿结构化结果，例如：

```bash
nx-rh wt list --json
# .worktrees[]: { name, branch, head, isMain, dirty, ahead, behind, extMissing, path }
```

冲突 / 阻止 / 计划都通过 `status` 字段表达（`ok / planned / blocked / conflict`），
不要靠匹配人读文本分支。

## agent 常见错误

| 错误写法 / 做法                            | 后果 / 纠正                                                         |
| ------------------------------------------- | ------------------------------------------------------------------- |
| 不 `wt init` 就 `wt add`，且根在主仓库内    | 根没进 .gitignore，git 可能拒绝在其下挂工作树；先跑一次 `wt init`。 |
| 把被跟踪文件 `wt ext add`，不加 `--force`   | 被 BLOCKED；扩展文件用于被忽略文件，确认登记加 `--force`。         |
| `wt ext sync` 遇冲突后反复重跑              | 永远 conflict；确认覆盖加 `--force`，否则人工处理工作树本地改动。   |
| 脏工作树直接 `wt rebase` 不给 `--message`   | blocked（这是保护，不是故障）；提交改动，或给 `--message` 自动提交。|
| `wt fanout` 不看计划直接 `--yes`            | 有脏/领先工作树时整体 blocked；先无参看计划。                      |
| 期望 `wt` 能 pull/push/提 PR                 | 超出边界；远端协作交给 git / gh / IDE。                            |
| 手工解析 `wt list` 人读文本做判断            | 用 `--json`，字段稳定；人读格式可能调整。                          |
