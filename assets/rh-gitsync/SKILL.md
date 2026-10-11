---
name: rh-gitsync
description: 批量检查 git 仓库与远端的同步状态，并只对安全场景自动同步。快速对比本地与上游的领先/落后和工作区干净程度：工作区干净且差异单向（只领先或只落后）的仓库直接自动 push / pull --ff-only；工作区有未提交内容或本地远端双向分叉的仓库一律不动手——agent 进入目录检查、给出报告、问过用户后再操作。当用户说「同步一下仓库」「检查哪些仓库没推 / 没拉」「和远程对比」「批量 push / pull」「git 同步状态」「哪些仓库落后了」时使用。不适用于：单仓库内的日常 git 操作（看某个文件历史、改某个具体提交）与工作树管理（用 rh-worktree）；脚本不做 rebase / merge / force push 决策，分叉与脏树只报告不动手。
---
# rh-gitsync — 批量检查并安全同步 git 仓库

## 这个 skill 解决什么

一台机器上登记了十几个仓库，过一阵总有几个忘了推、几个忘了拉。
本 skill 用一个零依赖的 Python 脚本（只依赖 git 与标准库，无任何 pip 包）把
「逐个仓库 `git fetch` / `status` / 数提交」压成一次调用：**先看清每个仓库与远端的
关系，再只对绝对安全的场景动手**。与 `nx-rh repo list` 配合，登记表里的仓库可以
一条命令全部巡检——nx-rh 本体照旧不做 git 操作，git 的事交给 git 自己 + 这个脚本。

自动化的安全边界只有一条，写死在脚本里（没有开关）：

> **工作区干净 + 与上游单向差异**（只领先 → `git push`；只落后 → `git pull --ff-only`）
> 才会被自动执行。脏工作区、双向分叉、无上游、detached、fetch 失败——一律标
> `needs-human`，脚本一个字节都不动。**永不 `--force`、永不 stash、永不丢弃任何改动。**

## 第一步永远是 check（别猜，先看清）

```bash
python3 ~/.claude/skills/rh-gitsync/scripts/gitsync.py --json
```

- 省略路径 = 当前目录；可传多个路径；`nx-rh repo list --json` 里每条的 `path` 可直接拿来喂：
  `python3 …/gitsync.py "D:/code/a" "D:/code/b" --json`，路径多时用 `-` 从 stdin 逐行读。
- `--json` 是给 agent 的机器契约（每仓库一个对象 + 顶层 summary）；不加则是人读报表。
- 退出码：`0` 全部就绪 / 已自动同步；`1` 有 needs-human；`2` 环境错误（git 不可用等）。

> 装到别处（`skill install rh-gitsync --to <dir>`）就按实际路径调用，脚本自包含。
> 裸 `python` 在一些机器上是 Python 2（直接语法错误）——用 `python3`，或 `uv run …/gitsync.py`。

## 状态分类（脚本输出什么）

| status | 含义 | check 模式 | sync 模式 |
| --- | --- | --- | --- |
| `in-sync` | 与上游一致且干净 | up-to-date | 不动 |
| `ahead` | 干净，本地领先 ↑N | would-push | **自动 `git push`** |
| `behind` | 干净，本地落后 ↓N | would-pull | **自动 `git pull --ff-only`** |
| `dirty` | 工作区有未提交内容 | needs-human | 不动 |
| `diverged` | 本地和上游都有新提交（↑A ↓B） | needs-human | 不动 |
| `no-upstream` | 当前分支没设上游 | needs-human | 不动 |
| `detached` | HEAD 游离 | needs-human | 不动 |
| `fetch-failed` | 连不上远端（网络 / 凭据） | needs-human | 不动 |
| `not-git` / `error` | 路径不是仓库 / 不存在 | needs-human | 不动 |

`--json` 里每个仓库还带：`branch` / `upstream` / `remote` / `ahead` / `behind` /
`head` / `dirty`（staged、unstaged、untracked 计数）/ `files`（变更文件，最多 20 条，
超出置 `filesTruncated`）/ 分叉时的 `localCommits` 与 `remoteCommits`（每侧最多 10 条）——
处理 needs-human 时这些上下文大多已就位，不用再跑一轮 git。

## needs-human：agent 到现场的标准流程

脚本报 `needs-human` 的仓库，按这个顺序处理（**先检查、再问用户、后动手**）：

1. **到目录检查**：`cd <repo>` 后看 `git status`、`git diff --stat`；分叉时对照
   JSON 里的 `localCommits` / `remoteCommits`，判断两侧改的是不是同一批文件。
2. **给用户报告 + 问方案**（一次说清，别挤牙膏）：
   - `dirty` → 列变更文件，问：**提交后同步**（推荐，顺手帮拟 commit message）/
     **stash** / **放弃改动**（危险，必须用户明确说出口才做）；
   - `diverged` → 列两侧提交，问：**rebase 到远端再推**（历史干净，通常推荐）/
     **merge** / **以本地为准强推**（改写远端历史，必须用户明确确认）/
     **以远端为准**（丢本地提交，必须用户明确确认）；
   - `no-upstream` → 问：推到远端同名分支并设上游（`git push -u origin <branch>`）？
3. **执行用户选的方案**。冲突落地、rebase 中断这类复杂操作回到具体 git 本身，逐条确认。
4. **复核**：重跑 `gitsync.py <该仓库> --json`，确认从 `needs-human` 变成 `in-sync`——
   别口头宣布完成，用退出码 0 证明。

## 给用户的报告模板

```
## git 同步报告（N 个仓库）
| 仓库 | 状态 | 本次已做 | 待你决定 |
| --- | --- | --- | --- |
| a | in-sync | — | — |
| b | ahead ↑2 | 已 push | — |
| d | dirty（+2 ~1 ?3） | 未动 | 提交后同步 / stash / 放弃？ |
| e | diverged（↑2 ↓3） | 未动 | rebase / merge / 强推？ |
```

## 命令速查

| 命令 | 用途 |
| --- | --- |
| `python3 …/gitsync.py --json` | 检查当前目录，零改动 |
| `python3 …/gitsync.py <路径>… --json` | 检查指定仓库（可多个） |
| `python3 …/gitsync.py <路径>… --mode sync` | 检查 + 自动推拉安全仓（只动「干净 + 单向」） |
| `python3 …/gitsync.py - --mode sync --json` | 路径从 stdin 逐行读（批量管道） |

## 反例

| 做法 | 为什么坏 |
| --- | --- |
| `--mode sync` 跑完就宣布完成 | 自动动作只覆盖安全仓；完成后必须重跑 check 复核，needs-human 清零才算收工 |
| 不问用户先 `git stash` 腾干净再让脚本拉 | stash 是改状态的动作；untracked 被 pull 覆盖后 stash pop 会冲突——必须先问 |
| 分叉了直接 `push --force` 图省事 | 改写远端历史、丢别人的提交；只有用户明确确认后才允许，且本脚本永不 force |
| 拿 `fetch-failed` 当「没落后」 | fetch 失败时 ahead/behind 是旧数据，任何自动决策都不可信；先修网络 / 凭据 |
| 用裸 `python` 跑脚本 | 部分机器 `python` 是 Python 2，直接语法错误；用 `python3` 或 `uv run` |
