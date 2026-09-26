# 场景：仓库登记

> 归属主文档 [[repo-hub]] 的「仓库登记」路由。本文件是该场景的完整 SOP 与判定标准。

## 何时进入

- 用户问「这台机器上有哪些仓库 / 某个仓库在哪」
- 需要把某个目录登记为受管仓库，或扫描某目录批量发现仓库
- 需要维护仓库的元信息：名称、描述、标签、备注，或改登记路径
- **需要 git 状态、差异、拉取、推送时不要进这里**——本工具不提供 git 操作（见下）

## 边界：本工具不管 git

仓库模块只维护一份**目录清单**。状态、diff、pull、push、冲突落地全部不做，
原因见 README「为什么不管 git」：git 客户端是无底洞，面板做不出比 IDE 更好的体验，
而半吊子的状态显示比没有更危险（用户会拿它当决策依据）。

要用 git 时直接用它自己：

```bash
git -C <path> status -sb
git -C <path> diff
git -C <path> pull --no-edit
```

本工具的价值在另一方面：把这些路径**记住并描述清楚**（叫什么、干什么用、归在哪类），
让 agent 下次不必重新问一遍「这个是哪个项目」。

## 数据模型

`~/.nx-rh/store.json` 的 `repos[]`，一条记录形如：

```json
{
  "id": "r_xxx",
  "name": "ext",
  "path": "D:\\a_js\\js_proj\\br_controller\\ext",
  "tags": ["eco-import"],
  "desc": "对外扩展模块",
  "notes": "",
  "addedAt": "…",
  "updatedAt": "…"
}
```

- **id 或绝对路径**都能定位仓库（agent 直接给路径更省事）
- tags 是自由标签数组，用于分组
- 路径不必是 git 仓库：登记不校验目录内容，也不要求目录存在

## SOP

### 1. 看清单

```bash
nx-rh repo list                 # 人读表格
nx-rh repo list --json          # 程序消费
```

### 2. 登记

```bash
nx-rh repo add <path> [--name N] [--desc D] [--tags a,b] [--notes T]
```

- `name` 缺省取目录名
- 同一路径重复登记会显式报错（非零退出），不会产生重复记录

### 3. 批量发现

```bash
nx-rh repo scan <root> [--depth 3]
```

- 递归查找含 `.git` 的目录（目录或文件都算——worktree / submodule 下是文件）并登记；已登记的自动跳过
- 默认跳过 `node_modules` / `dist` / `build` / `target` / `.venv` / `vendor` / `AppData` 等
- 深度默认 3；根目录本身也会被检查
- **只做文件系统存在性检查，不调用 git**，所以在没装 git 的机器上同样可用

### 4. 看单条 / 改元信息

```bash
nx-rh repo get <id|path> [--json]
nx-rh repo update <id> [--name N] [--desc D] [--tags a,b] [--notes T] [--path P]
```

- `update --path` 用来纠正登记错位的目录；改到**已被别的记录占用**的路径会显式报错

### 5. 打开目录

```bash
nx-rh repo open <id>     # 在系统文件管理器打开（Windows: explorer）
```

### 6. 注销

```bash
nx-rh repo remove <id>   # 只移除登记，磁盘文件不受影响
```

## 正反例

| 反例 | 问题 | 正例 |
| --- | --- | --- |
| 用 `repo list` 判断仓库有没有未提交改动 | 这里没有 git 信息，只会得到误导性结论 | 用 `git -C <path> status -sb` |
| 用 `repo scan C:\` 全盘扫 | 极慢且登记大量无关目录 | 指定项目根 + 合理 `--depth` |
| 把 `notes` 当 changelog 写 | 元信息越滚越长，列表失去可读性 | 只记「这个仓库是干什么的 / 在哪个生态里」 |

## 失败排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `repo 不存在: <id>` | id 写错或未登记 | 先 `repo list` 拿 id，或直接传绝对路径 |
| `该路径已登记` | 同一路径已有记录 | 用 `repo list` 找到那条，改用 `repo update` |
| `path 不能为空` | `repo add` 少了路径参数 | 补上绝对路径 |
