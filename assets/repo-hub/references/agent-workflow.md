# 场景：Agent 批量编排

> 归属主文档 [[repo-hub]] 的「Agent 批量编排」路由。本文件是该场景的完整 SOP 与判定标准。

## 何时进入

- 需要连续处理多个仓库（如全部 pull、全部看状态、找有变更的）
- 需要把 nx-rh 的输出交给程序解析（`--json`）
- 需要在失败后安全重试，或需要批量策略（先诊断再动手）

## 稳定契约（可依赖）

| 契约 | 内容 |
| --- | --- |
| `--json` | 输出**单个** JSON 值到 stdout；无 ANSI、无多余文本。错误时输出 `{"ok":false,"error":"…"}` 且退出码非零 |
| 退出码 | `0` 成功；`1` 失败（业务错误、参数错误、非法名称等） |
| 幂等 | 重复执行安全：已就绪返回 `skipped`；重复登记报错但不产生脏数据 |
| 错误文本 | 中文明确定位（如 `未设置 skill 中心仓库路径`），可直接用于判断分支 |
| 存储覆盖 | `NX_RH_STORE=<path>` 或 `--store <path>` 指定 store，**测试必须指向临时目录** |

## SOP

### 1. 先诊断，再行动

```bash
# 全量状态（一次调用拿到所有仓库）
nx-rh repo status --json

# 只关心需要动作的
nx-rh repo status --json | jq '[.[] | select(.git.behind > 0) | {id, name, behind: .git.behind}]'

# 找有冲突的
nx-rh repo status --json | jq '[.[] | select((.git.conflicted // []) | length > 0) | .name]'
```

### 2. 批量执行（逐项循环 + 收集结果）

单条命令只作用于一个仓库，批量靠外层循环：

```bash
for id in $(nx-rh repo status --json | jq -r '.[] | select(.git.behind > 0) | .id'); do
  nx-rh repo pull "$id" --json
done
```

**判读要点**：`pull` 返回的 `conflicted` 非空 = 该项需要人工决策，**不要**在这里自动 `--force`。

### 3. 结果聚合成报告

```bash
# 汇总：干净 / 有变更 / 有冲突 的三类计数
nx-rh repo status --json | jq '{
  clean:  [.[] | select(.git.clean)] | length,
  dirty:  [.[] | select((.git.staged|length)+(.git.modified|length)+(.git.untracked|length) > 0)] | length,
  conflict: [.[] | select((.git.conflicted // []) | length > 0)] | length
}'
```

向用户汇报时给出：**做了什么**（动作清单）+ **剩余风险**（未处理的冲突、被跳过的项及原因）。

### 4. 失败处理策略

| 失败类型 | 判断依据 | 处理 |
| --- | --- | --- |
| 参数/用法错误 | 错误文本含「用法:」 | 修正参数后重试，不要盲目重试 |
| 业务前置缺失 | 含「未设置」「不存在」 | 先补齐前置（如设置中心仓库），再重试 |
| 冲突 | 返回 `status: "conflict"` | **停止自动化**，转为逐文件决策后 `apply` |
| 网络/远端 | `output` 含网络错误 | 可重试；连续失败则上报用户 |

### 5. 安全边界（agent 必须遵守）

1. **不做破坏性推断**：删除、覆盖、强制推送类操作需明确授权；`--force` 不是"重试按钮"。
2. **测试隔离**：任何自测都设 `NX_RH_STORE` 指向临时目录，禁止写真实 `~/.nx-rh/store.json`。
3. **改动前后留痕**：写操作前后各跑一次 `status` / `conflict`，把差异写进汇报。
4. **不确定就停**：遇到未覆盖的命令或非预期输出，停下来询问，不要猜测参数。

## 正反例

| 反例 | 问题 | 正例 |
| --- | --- | --- |
| 解析 `--json` 时还去 grep 人类可读文本 | 输出格式一变就崩 | 只用 `--json` 的字段 |
| 批量 pull 时对冲突项自动 `--force` | 静默丢改动 | 收集冲突清单，停下来请用户决策 |
| 用真实 store 做自测 | 污染用户数据 | `NX_RH_STORE=/tmp/... nx-rh …` |
| 失败后无限重试 | 掩盖真实错误 | 按第 4 步分类：先修因再重试 |

## 与其他场景的衔接

- 需要理解单仓库字段含义 → 读 [[repo-ops]]
- 需要处理 skill 两侧不一致 → 读 [[skill-sync]]
