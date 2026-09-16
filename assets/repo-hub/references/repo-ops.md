# 场景：仓库管理

> 归属主文档 [[repo-hub]] 的「仓库管理」路由。本文件是该场景的完整 SOP 与判定标准。

## 何时进入

- 用户问「这台机器上有哪些仓库 / 某仓库什么状态」
- 用户要求查看差异、拉取更新、推送、或处理冲突文件
- 需要把某个目录登记为受管仓库，或扫描某目录发现仓库

## 数据模型

`~/.nx-rh/store.json` 的 `repos[]`，一条记录形如：

```json
{
  "id": "r_xxx",
  "name": "ext",
  "path": "D:\\a_js\\js_proj\\br_controller\\ext",
  "tags": ["git-monitor"],
  "notes": "",
  "addedAt": "…",
  "updatedAt": "…"
}
```

- **id 或绝对路径**都能定位仓库（agent 直接给路径更省事）
- tags 是自由标签数组，用于分组（如 `eco-import`、`git-monitor`、`flutter`）

## SOP

### 1. 看清单

```bash
nx-rh repo list                 # 人读表格
nx-rh repo list --json          # 程序消费
```

### 2. 登记

```bash
nx-rh repo add <path> [--name N] [--tags a,b] [--notes T]
```

- `name` 缺省取目录名
- 同一路径重复登记会显式报错（非零退出），不会产生重复记录
- 非 git 目录也能登记（状态查询会返回 `error: 不是 git 仓库`）

### 3. 批量发现

```bash
nx-rh repo scan <root> [--depth 3]
```

- 递归查找含 `.git` 的目录并登记；已登记的自动跳过
- 默认跳过 `node_modules` / `dist` / `build` / `target` / `.venv` / `vendor` / `AppData` 等
- 深度默认 3；根目录本身也会被检查

### 4. 看状态（最常用）

```bash
nx-rh repo status [id] [--json]
```

逐仓库返回：`branch`、`ahead`（领先）、`behind`（落后）、`staged[]`、`modified[]`、`untracked[]`、`conflicted[]`、`clean`。

**判定规则**：

| 现象 | 含义 | 下一步 |
| --- | --- | --- |
| `conflicted` 非空 | 有未解决的合并冲突 | 先逐文件 resolve，再 pull/push |
| `behind > 0` | 远程有新提交 | `repo pull <id>` |
| `ahead > 0` 且干净 | 本地有未推送提交 | `repo push <id>` |
| `clean: true` | 无变更且与上游同步 | 无需操作 |

### 5. 看差异

```bash
nx-rh repo diff <id> [--file F]
```

- 不带 `--file` 看全部未暂存差异；带 `--file` 看单个文件
- 输出是 git 原始 diff 文本，可直接喂给用户或后续处理

### 6. 拉取 / 推送

```bash
nx-rh repo pull <id>     # fetch + pull --no-edit；冲突时结果里带 conflicted 列表
nx-rh repo push <id>     # 直接 push
```

**注意**：`pull` 遇到冲突不会自动合并，返回的 `conflicted` 数组就是需要人工决策的文件清单。

**失败形态**：`pull` / `push` 失败时**不再返回 `{ok:false, output}`**，而是抛错并以
`exit 1` 结束，`--json` 下给出 `{"ok":false,"error":"…","code":"EXTERNAL"}`，
失败原因在 `error` 里（不再有 `output` 字段）。唯一的例外是 `pull` 产生的冲突——
那是业务结果，仍以 `status: "conflict"` + `conflicted` 数组正常返回，退出码为 0。

### 7. 解决冲突文件

```bash
nx-rh repo resolve <id> --file F --side ours|theirs
```

- `ours` = 当前分支侧，`theirs` = 被合并进来的那侧
- 该命令执行 `git checkout --ours/--theirs -- <file>` 后 `git add`，即**落地并暂存**该文件
- 解决完全部冲突文件后，状态里的 `conflicted` 会清空；此时再决定提交或继续

### 8. 打开目录

```bash
nx-rh repo open <id>     # 在系统文件管理器打开（Windows: explorer）
```

## 正反例

| 反例 | 问题 | 正例 |
| --- | --- | --- |
| 直接 `repo push` 而没先 `status` | 可能在有未解决冲突时推送，报错难懂 | 先 `status`，确认 `conflicted` 为空再推 |
| 冲突时对全部文件统一 `--ours` | 丢掉对方真实改动 | 逐文件判断（`repo diff` 看内容）后再 resolve |
| 用 `repo scan C:\` 全盘扫 | 极慢且登记大量无关目录 | 指定项目根 + 合理 `--depth` |

## 失败排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `不是 git 仓库` | 路径不是仓库（或 .git 缺失） | 核对路径；子目录需登记其 git 根 |
| `repo 不存在: <id>` | id 写错或未登记 | 先 `repo list` 拿 id，或直接传绝对路径 |
| pull 后 conflicted 非空 | 真实合并冲突 | 走第 7 步逐文件 resolve |
