# 场景：环境变量管理

> 归属主文档 [[repo-hub]] 的「环境变量」路由。本文件是该场景的完整 SOP 与判定标准。

## 何时进入

- 用户要求查看 / 修改 Windows 的持久化环境变量或 PATH
- 某条命令「找不到」或「找到的是旧版本」——大概率是 PATH 问题
- 要给某个工具（含 agent 自己用的 CLI）加一个目录到 PATH
- 用户说「改了环境变量但没生效」

## 平台与权限（先看这条，能省一轮失败）

| | 用户级（HKCU\Environment） | 系统级（HKLM\...\Session Manager\Environment） |
| --- | --- | --- |
| 读 | 任何时候都可以 | 任何时候都可以（不需要管理员） |
| 写 | 任何时候都可以 | **需要 nx-rh 以管理员身份运行** |

- **本模块只支持 Windows。** macOS / Linux 上所有命令返回 `BLOCKED`，不会假装成功。
- 系统级写不了时错误码是 `BLOCKED`，message 里含「管理员权限」——这是让你**停下来告知用户**的信号，
  不是让你反复重试的信号。
- 先跑 `nx-rh env status` 就知道当前能不能写系统级，不用猜。

## 数据模型

注册表里的一个值有三样东西：**名字、类型、原值**。类型是这里最要紧的部分。

| 类型 | 含义 | 什么时候出现 |
| --- | --- | --- |
| `String` | 原样使用 | 普通变量 |
| `ExpandString` | 值里的 `%VAR%` 会被展开 | 含变量引用的值，如 `%USERPROFILE%\bin` |

**`ExpandString` 降级成 `String` 会让 `%USERPROFILE%` 从此永不展开。** 这是本模块最容易
静默损坏用户 PATH 的地方。规则分两半：

- `env set`（你亲手写下一个值）：
  - 已存在的 `ExpandString` **永不降级**（除非显式 `--kind string`）
  - 值里出现 `%` 时会把 `String` **升级**为 `ExpandString` —— 否则你写进去的是字面量
- `env path add|remove`（只做结构编辑）：**只保留已有类型，不做任何升级**。
  那个 `%` 来自 PATH 里早已存在的条目，不是这次输入的值。真实案例：某机器用户级 PATH
  是 REG_SZ 且含 `%JAVA_HOME%\bin` 字面量（REG_SZ 从不展开，所以是死条目），
  「含 `%` 就升级」会让「加一个无关目录」顺带把整条 PATH 的展开语义改掉，
  那些条目突然生效——用户只是加了个目录，不该承受全局语义变更。

`--json` 输出里类型显示为 `String` / `ExpandString`；CLI 的 `--kind` 用短词 `string` / `expand`。

### PATH 的归一化（知道一下，免得被 diff 吓到）

`env path add|remove` 会把 PATH 重新拼装，期间**丢弃空的条目**（`;;`、尾随 `;`）。
这是有意的：Windows 把空 PATH 段解释成「当前目录」，是个已知的提权面。

代价是 **`add` 之后再 `remove` 不构成严格幂等**——原值若含空段，回不到逐字节相同
（非空条目会逐条保留、顺序不变）。dry-run 的 diff 里能看到这件事，不是静默发生的。

## SOP

### 1. 先看现状（永远从这个开始）

```bash
nx-rh env status                          # 平台 / 是否提权 / 两个 scope 能否写
nx-rh env list                            # 合并视图：两个 scope + 遮蔽标注 + 生效 PATH
nx-rh env list --scope user               # 只看用户级
nx-rh env get <name>                      # 单个变量：两个 scope 的值 + 遮蔽判断
nx-rh env path list                       # PATH 按条目列出（不要自己 split 字符串）
nx-rh env snapshot list                   # 现有快照
```

### 2. 写之前先 dry-run

**每条写命令都支持 `--dry-run`，它不落盘、不产生快照**，只把将要发生的改动以 diff 返回：

```bash
nx-rh env set <name> <value> --dry-run
nx-rh env path add <dir> --dry-run
nx-rh env path remove <dir> --dry-run
nx-rh env snapshot restore <id> --dry-run
```

agent 应当**先 dry-run 看清 diff，再执行**。diff 会被人工看到，也会进日志。

### 3. 写入

```bash
nx-rh env set <name> <value> [--scope user|system] [--kind string|expand]
nx-rh env remove <name> [--scope user|system]

nx-rh env path add <dir> [--scope user|system] [--first]
nx-rh env path remove <dir> [--scope user|system]
```

- `--scope` 默认 `user`。**改 PATH 前想清楚改哪一级**：用户级只影响自己，系统级影响整机。
- 值以 `--` 开头时（如存命令行参数的变量）用 `--value=` 形式传，否则会被参数解析器当成 flag。
- `env path add` 默认**追加在末尾**；`--first` 前置——但前置会遮蔽系统同名工具，慎用。
- `env path remove` 不会让 PATH 变空：删到最后一条会被 `BLOCKED` 拦下。
- 重复添加 / 删除不存在的条目返回 `status: "skipped"`（幂等，不是错误）。

### 4. 出事了怎么回滚

**每次写入前都会自动快照**（含两个 scope 的完整数据），所以任何一次写操作都能回滚：

```bash
nx-rh env snapshot list                   # 找到写入前的那一份
nx-rh env snapshot restore <id> --dry-run # 先看清会改什么
nx-rh env snapshot restore <id>           # 执行
```

- 恢复前会**再自动快照一份**，所以「恢复」本身也可以被恢复。
- 恢复是「回到那个时刻」，**不是叠加**：快照之后新增的变量会被删除。
- 未提权时系统级恢复不了，命令返回 `status: "partial"` 并列出跳过的 scope——
  这是**如实报告**，不是失败。用户级部分已经恢复。

## 判定标准

### 遮蔽 vs 拼接 vs 重复

`env list` 的合并视图给每条变量一个标记，三者含义完全不同：

| 标记 | 含义 | 该怎么做 |
| --- | --- | --- |
| `*` | 用户级遮蔽系统级（两边值不同） | 生效的是用户级。要改行为就改用户级；要全局生效才动系统级 |
| `+` | **PATH：拼接，不是遮蔽** | 生效 PATH = 系统条目在前 + 用户条目在后。**不要**因为看到两边都有就去删用户级 PATH |
| `=` | 两边都有且值相同 | 只是重复登记，不是问题，可以不动 |

本机上 `TEMP` / `TMP` 是典型的 `*`，`Path` 是 `+`。

### 改完什么时候生效

写入的是**注册表里的持久化值**，不是当前进程的环境：

- 新开的终端 / 从开始菜单启动的应用 → 会读到新值
- **已经启动的进程（含你自己所在的那个 shell）→ 不会自动跟变**

所以「改完立刻在当前 shell 里验证」必然失败，这不是 bug。要验证就新开一个终端，
或直接读注册表：`nx-rh env get <name>`。

写入后会广播 `WM_SETTINGCHANGE`，让 Explorer 重读环境，从而让新开的终端拿到新值。
这个广播实测要几秒，`--no-notify` 可以跳过（批量写入时值得加）。

## 红线

1. **不要用 `env set Path <整串>` 改 PATH。** 用 `env path add` / `env path remove`——
   手拼几千字符的字符串迟早会拼坏，而 PATH 写坏会让这台机器的命令行整个不可用。
2. **不要在没有 dry-run 的情况下写系统级。** 系统级 PATH 出问题影响的是整台机器。
3. **不要为了「让当前 shell 生效」反复重写变量。** 它不会生效，换个终端就行。
4. **不要忽略 `BLOCKED`（未提权）反复重试。** 把情况告诉用户，让他决定是否以管理员重启 nx-rh。
5. **不要用 `--kind string` 去覆盖一个 `ExpandString` 变量**，除非你确认它的值里确实没有
   `%VAR%`。这是唯一会主动制造「永不展开」的路径。

## 正反例

**要加一个目录到 PATH：**

```bash
nx-rh env path add D:\tools\bin --dry-run    # 先看 diff
nx-rh env path add D:\tools\bin              # 确认后执行
```

反例：`nx-rh env set Path "C:\Windows;D:\tools\bin;...（手动拼的一长串）"` ——
一旦抄漏一段，用户的 PATH 就少了一截，而且看不出是哪一截。

**要改一个已存在变量的值：**

```bash
nx-rh env get MY_TOOL_HOME                   # 先确认它在哪个 scope、什么类型
nx-rh env set MY_TOOL_HOME D:\new --scope user --dry-run
nx-rh env set MY_TOOL_HOME D:\new --scope user
```

注意 `env set` 是 upsert：它保留注册表里的原始大小写与类型。你不会因为敲了
`path` 而造出第二份 `Path`。

## 与面板的关系

Web 面板的「环境变量」页每一项都是上面某条命令的等价物，且**所有写入都强制走
「dry-run 预览 → 展示 diff → 确认」三步**。agent 走 CLI 时应当自行保持同样的纪律：
先 dry-run，看清再写。
