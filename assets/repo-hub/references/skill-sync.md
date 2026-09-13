# 场景：Skill 同步与冲突

> 归属主文档 [[repo-hub]] 的「Skill 同步与冲突」路由。本文件是该场景的完整 SOP 与判定标准。

## 何时进入

- 要在「中心仓库」与「项目」之间同步某个 skill
- 两侧内容不一致，需要判断差异并决定保留哪侧
- 要把链接形态的 skill 转成实体目录（或反向）

## 数据模型

```
{中心仓库}/skills/<name>/SKILL.md          ← 唯一真相源
{项目}/<适配器目录>/<name>/SKILL.md        ← 项目侧（claude-code 即 .claude/skills）
```

- 中心仓库路径由 `skills.skillCentralPath` 决定：`nx-rh skill central <path>`
- 适配器目录表由 `nx-rh skill adapters` 列出（claude-code / agents / cursor / codex / gemini-cli / copilot / windsurf / codebuddy / iflow-cli）
- 同步落点规则：`--adapter` 指定 > 项目里第一个已存在的适配器目录 > `.claude/skills` 兜底

## 形态识别（读完就知道该怎么处理）

`nx-rh skill list --side project --path <P>` 返回每项的 `linkType` 与 md5：

| linkType | 含义 | 处理取向 |
| --- | --- | --- |
| `symlink` / `junction` | 项目侧是指向中心的链接 | 天然一致，通常无需操作 |
| 空 | 项目侧是实体目录 | 与中心比 md5：相同=一致；不同=冲突 |
| `synced` 状态 | md5 相同 | 无需操作 |

## SOP

### 1. 看两侧

```bash
nx-rh skill list --side central [--json]
nx-rh skill list --side project --path <P> [--json]
```

### 2. 同步（中心 → 项目）

```bash
nx-rh skill sync <name> --project <P> [--mode symlink|copy] [--adapter A] [--force]
```

结果三态：

| status | 含义 | 后续 |
| --- | --- | --- |
| `ok` | 完成（`mode` 与 `linkType` 标明软链接或复制） | 完成 |
| `ok` + `skipped: true` | 已是同源链接，无需变更 | 完成 |
| `conflict` | 目标为实体且与中心不一致 | 走第 4 步 |

- 链接模式下若目标是指向别处/实体，会被清理重建；**内容有差异时不会静默覆盖**，会先返回 conflict
- `--force` 才会覆盖；仅在明确知道要丢弃项目侧改动时使用

### 3. 推送（项目 → 中心）

```bash
nx-rh skill push <name> --project <P> [--force]
```

- 项目侧是链接时直接返回 `skipped`（本就与中心实时一致）
- 中心已存在且内容不同 → `conflict`，列出差异文件

### 4. 冲突分析与选侧（核心）

```bash
nx-rh skill conflict <name> --project <P> [--json]
```

返回 `files[]`，每项 `side` 取值：

| side | 含义 |
| --- | --- |
| `both-differ` | 两侧都有该文件且内容不同（带 `diff` 文本） |
| `only-central` | 仅中心有 |
| `only-project` | 仅项目有 |

逐文件决策后落地：

```bash
nx-rh skill apply <name> --project <P> --file F --side central|project
```

- `side=central`：用中心版覆盖项目（等价于中心为准）
- `side=project`：用项目版覆盖中心（把项目改动采纳为真相源）
- 一次只处理一个文件——**按文件判断，而不是整体选边**

三方合并（需要 base 时）：

```bash
nx-rh skill merge --base <file> --a <file> --b <file> [--json]
```

输出 `{ merged, conflicts[] }`：仅单侧变更的区域自动采用，双侧不同则输出 `<<<<<<< / ======= / >>>>>>>` 冲突块。

### 5. 物化（链接 → 实体）

```bash
nx-rh skill materialize <name> --project <P>
```

- 把项目侧的链接替换成中心的独立副本，之后不再实时同步
- 已是实体时返回 `converted: false`

## 判定与正反例

| 反例 | 问题 | 正例 |
| --- | --- | --- |
| 冲突后直接 `--force` 覆盖 | 丢掉一侧真实改动且无记录 | 先 `conflict` 看 diff，再逐文件 `apply` 选侧 |
| 对链接形态的 skill 跑 push | 无意义（本就一致） | 看到 `linkType` 非空就跳过 |
| 用 `copy` 模式做常态化同步 | 每次都要比 md5，改动无法自动流动 | 默认 `symlink`；仅当目标环境不支持链接时用 `copy` |
| `apply` 时选错侧 | 真相源被反向覆盖 | 先看 `diff` 归属，明确哪侧是期望结果 |

## 失败排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `未设置 skill 中心仓库路径` | `skillCentralPath` 为空 | `nx-rh skill central <path>` |
| `中心仓库不存在该 skill` | 中心缺该 skill | 先从项目侧 push，或先导入 |
| `项目中未找到 skill` | 项目侧无此 skill / 适配器目录不匹配 | 核对 `skill list --side project --path`；必要时 `--adapter` |
| 同步后仍是复制而非链接 | 创建链接失败（权限/文件系统） | 结果里 `degraded` + `degradedReason` 已说明；可改用 `--mode copy` 明确意图 |
| 描述显示「(无描述)」 | SKILL.md frontmatter 解析异常 | 检查 frontmatter 是否闭合；CRLF/引号/块标量自 v0.2.2 起已支持 |
