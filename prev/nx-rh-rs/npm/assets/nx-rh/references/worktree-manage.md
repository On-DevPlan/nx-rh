# 30 · 工作树（git worktree）管理：CLI + Web

> 给 agent 的操作手册：怎么用 `nx-rh wt init`、`nx-rh wt add` 等命令开工作树、拿主项目上下文、
> 登记 `.gitignore` 里的文件并**只读提醒**。**nx-rh 不复制、不链接任何文件**——只做登记与提醒，
> 需要内容时 agent 自己复制。
> **怎么改这个模块本身**属于项目仓库（`README.md` 的「如何新增功能域」），不在本文件。

## 心智模型

`git worktree` 让**同一个仓库**在磁盘上有多个工作目录，每个目录停在不同分支：

- 分支 A 写到一半，不用 commit/stash，直接开另一个工作树做分支 B，两边互不干扰。
- 多个工作树共享同一个 `.git`，不需要重复 clone，秒级创建。
- 主工作树（main）就是最初那个目录；其余是链接工作树。

两个必须知道的事实：

1. **工作树只带走被 git 跟踪的文件**。`.gitignore` 里的东西（`.env`、本地密钥、
   `.tool` 本地工具、数据目录）不会出现在新工作树里——本模块把这些登记为**扩展文件**。
   **nx-rh 不代复制**：在工作树里用 `wt context` 看主项目变更与它们的主项目全路径，
   只读打开即可；确实要拿到工作树时 agent 自己复制（见场景 D）。
2. **工作树清单的真相在 git**（`git worktree list`），不在本工具的 store。
   store 只登记 git 不知道的东西：扩展文件全路径 + 模块配置。
3. **关注项（attention）**：主项目根下的点目录（如 `.tool`）等本地工具/测试逻辑会被
   自动标「关注」，在 `wt context` / `wt ext list` 里突出显示并附主项目全路径。

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
当前工作树相对主项目的领先（↑）落后（↓）；**需要关注的主项目排除项**（如 `.tool`，附主项目全路径）；
扩展文件在两侧的状态；以及**建议指令**（落后提示 rebase，缺参考项提示去主项目路径自取）。建议指令可直接复制。
`--json` 返回里有 `role`（main/worktree）、`attention[]` 与 `extItems[]`。

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
- 主仓库外的路径可以登记，但只能只读参考、无法映射到工作树内（会标注 `outside`）。
- 改标签：`nx-rh wt ext update <id> --label "新标签"`；
  查看：`nx-rh wt ext list`（在主仓库里显示「一致/变更」）、`nx-rh wt ext get <id>`。

## 场景 D：参考扩展文件（只读为主；需要内容时 agent 自行复制）

nx-rh **不提供复制/同步命令**。扩展文件一般是文档，只读打开主项目路径即可：

- `wt context`（或 Web 上下文弹窗）里每个关注项都有**主项目全路径**，点
  「复制主项目路径」，然后直接打开查看，不动文件。

确实要把某个文件/目录拿到工作树（例如工作树要**运行**项目级脚本）时，**agent 自己复制**：

PowerShell（Windows）：

```powershell
Copy-Item -Recurse -Force "D:/proj/my-project/.tool" "./.tool"
```

macOS / Linux：

```bash
cp -R "/proj/my-project/.tool" "./.tool"
```

> 一般用不上：文档只读打开主项目路径即可，复制会带入过期/无关文件、还可能让树变脏。

在工作树内查看扩展文件状态（关注/一致/差异/缺失）：

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
| 想让 nx-rh 复制/同步 ignore 文件           | nx-rh 刻意不提供复制能力；它只登记和提醒，复制由 agent 自行做。   |
| 不分需要，把所有 ignore 文件复制进工作树    | 多数只需只读参考；复制会带入过期/无关文件，还会让树变脏。         |
| 把被跟踪文件 `wt ext add`，不加 `--force`   | 被 BLOCKED；扩展文件用于被忽略文件，确认登记加 `--force`。         |
| 脏工作树直接 `wt rebase` 不给 `--message`   | blocked（这是保护，不是故障）；提交改动，或给 `--message` 自动提交。|
| `wt fanout` 不看计划直接 `--yes`            | 有脏/领先工作树时整体 blocked；先无参看计划。                      |
| 期望 `wt` 能 pull/push/提 PR                 | 超出边界；远端协作交给 git / gh / IDE。                            |
| 手工解析 `wt list` 人读文本做判断            | 用 `--json`，字段稳定；人读格式可能调整。                          |
