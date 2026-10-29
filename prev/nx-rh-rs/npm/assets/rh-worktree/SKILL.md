---
name: rh-worktree
description: 自动适配当前状态，规范地创建或查看 git 工作树（worktree）。在主仓库里：按业务需求登记被 ignore 的文件/目录全路径、创建工作树，并显示主项目的全部变更；在工作树里：显示主项目地址、本工作树信息，以及主项目被 ignore、需要特殊关注的文件或文件夹（如 .tool 本地工具目录）。nx-rh 只做「登记 + 提醒」，不复制、不链接任何文件——非 git 文件多为只读文档，需要内容时 agent 自己复制。触发词：开工作树、建工作树、worktree、新分支工作目录、主项目上下文、.tool、本地工具目录、扩展文件、登记忽略文件。
---
# rh-worktree — 规范地创建/查看 git 工作树

## 这个 skill 解决什么

`git worktree` 让同一个仓库在磁盘上有多个工作目录，每个停在不同分支，互不干扰、
共享同一个 `.git`。本 skill 让你（agent）**不凭记忆、按固定套路**把工作树开对，
并在工作树里随时拿到主项目的最新上下文。

核心定位：**nx-rh 只做「登记 + 提醒」，不提供任何复制/链接能力。**

- 工作树只带走被 git 跟踪的文件；`.gitignore` 里的东西（`.env`、`.tool` 本地工具、
  数据目录）不会出现。这些登记为**扩展文件**，干活时用 CLI 看主项目的变更与它们的
  **主项目全路径**，只读打开即可。
- **nx-rh 不代复制**：非 git 文件一般是文档，只读就够用。确实要把某个文件/脚本拿到
  工作树时，**agent 自己复制**（见下方「需要内容时」）。

## 第一步永远是探测状态（别猜）

```bash
nx-rh wt context --json
```

看返回的 `role`：

- `"main"`：当前在**主仓库** → 走【情况 A】
- `"worktree"`：当前在**某个工作树** → 走【情况 B】
- `git: false`：不是 git 仓库 → 提示用户切到 git 项目或先 `git init`，结束。

## 情况 A：在主仓库，按需求创建工作树

按顺序做，成功模板：

```bash
# 1) 拿主项目当前上下文（分支/HEAD/改动/最近提交），确认起点是干净或可接受的
nx-rh wt context --json

# 2) 登记被 ignore 的文件/目录全路径（先只看建议，零副作用）
nx-rh wt ext discover
# 确认候选无误后一次性登记
nx-rh wt ext discover --apply
# 或只登记某个明确的本地工具目录
nx-rh wt ext add "D:/proj/my-project/.tool" --label "本地测试工具"

# 3) 用一句「要做什么」创建分支 + 工作树（不复制任何文件）
nx-rh wt add "给登录页加图形验证码"

# 4) 复制输出里的 cd 进入工作树
cd "C:/Users/你/.nx-rh/worktrees/<repo>/add-login-captcha"

# 5) 进入后一条命令显示主项目的全部变更与可参考项
nx-rh wt context
```

要点：

- 描述要写**业务意图**（"加图形验证码"），分支自动命名为 `feature/<会话名>`。
- `wt add` **不复制文件**；它只创建分支与工作树，并在输出里给出 cd 和下一步 context 指令。
- 起点分支不是默认分支时加 `--base <分支>`；自定义会话名加 `--name <名>`。

## 情况 B：在工作树里，拿主项目信息与关注项

直接：

```bash
nx-rh wt context
```

它会显示：

1. **主项目地址**（`main.path`，可点击复制）与主项目分支 / HEAD / 改动 / 最近提交；
2. **本工作树信息**：当前分支、是否有改动、相对主项目领先 ↑ / 落后 ↓；
3. **需要关注的主项目排除项**（`attention`）：被 ignore、不进工作树、但干活常要只读
   参考的文件或文件夹，附它们在**主项目的全路径**（可复制）；
4. 建议指令（落后提示 rebase；缺参考项提示去主项目路径自取），可直接复制。

### 关注项怎么处理（例：`.tool` 目录）

主项目根下的 `.tool` 一般被屏蔽，里面是**局部测试/工具逻辑**。默认它不在工作树里：

- **只读参考（默认，最常见）**：直接打开主项目路径查看，不动文件——
  `nx-rh wt context` 里就有 `.tool` 的主项目全路径，点「复制主项目路径」。
- **需要内容时（agent 自己复制，nx-rh 不代劳）**：

  PowerShell（Windows）：

  ```powershell
  Copy-Item -Recurse -Force "D:/proj/my-project/.tool" "./.tool"
  ```

  macOS / Linux：

  ```bash
  cp -R "/proj/my-project/.tool" "./.tool"
  ```

  > 一般用不上：文档只读打开主项目路径即可。只有工作树要**运行**项目级脚本
  > （本地构建/测试脚手架）时才需要复制对应脚本。

### 主项目往前走了

```bash
nx-rh wt rebase            # 在工作树内：把当前树 rebase 到主项目当前分支
```

冲突会自动 abort 并返回输出，不丢改动；脏树可给 `--message "WIP"` 自动提交后 rebase。

## 命令速查

| 命令 | 用途 |
| --- | --- |
| `nx-rh wt context [--log N]` | 自动适配：主项目 + 当前工作树信息 + 关注项 + 建议（加 `--json` 供程序消费） |
| `nx-rh wt ext discover [--apply]` | 发现被 ignore 文件（默认只建议，`--apply` 登记全路径） |
| `nx-rh wt ext add <绝对路径> [--label L]` | 按全路径登记单个扩展文件/目录 |
| `nx-rh wt ext list [--target T]` | 扩展文件及其在主项目/某工作树的状态（关注项标「关注」） |
| `nx-rh wt add "<描述>" [--name N] [--base B]` | 创建分支与工作树（**不复制**） |
| `nx-rh wt rebase [ref] [--message M]` | 把工作树 rebase 到主项目分支 |
| `nx-rh wt remove <ref> [--branch] [--force]` | 移除工作树（主树不可删） |

面板「工作树」页有同样的入口；关注项可一键「复制主项目路径」。
**nx-rh 没有复制/同步命令**——需要文件内容时 agent 自行 `Copy-Item` / `cp`。

## 反例

| 做法 | 为什么坏 |
| --- | --- |
| 不先 `wt context` 探测，直接假设自己在主仓库 | 可能在工作树里，导致桶/路径判断错；第一步必须看 `role`。 |
| 想让 nx-rh 复制/同步 ignore 文件 | nx-rh 刻意不提供复制能力；它只登记和提醒，复制由 agent 自行做。 |
| 不分需要，把所有 ignore 文件复制进工作树 | 多数只需只读参考；复制会带入过期/无关文件，还会让树变脏。 |
| 把被跟踪文件当扩展登记 | 扩展用于被忽略文件；被跟踪文件默认被阻止，确认登记需显式 `--force`。 |
| 期望本流程做 pull/push/提 PR | 超出边界；远端协作交给 git / gh / IDE。 |
