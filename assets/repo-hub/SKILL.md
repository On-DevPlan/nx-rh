---
name: repo-hub
description: 通过 nx-rh（npx-repo-hub）统一管理本机 git 仓库、Agent Skill 与 Windows 环境变量。当需要登记或扫描仓库、查看 git 状态与差异、拉取/推送、处理冲突文件，需要识别、同步、物化 skill，或需要查看/修改持久化环境变量与 PATH（命令找不到、改了不生效）时使用本技能。所有能力都同时提供同构 CLI（加 --json 供程序消费）与本地 Web 面板。
agent_created: true
---

# repo-hub — 本机仓库与 Skill 管理

## 适用场景

- 需要知道本机登记了哪些 git 仓库，以及它们的分支 / 领先落后 / 变更 / 冲突
- 需要查看差异、拉取更新、推送、或解决单个冲突文件
- 需要把 skill 从中心仓库同步到项目侧（软链接或复制），或从项目侧反向推送到中心
- 需要判断项目里的 skill 与中心是否一致，不一致时如何按文件选侧
- 需要查看 / 修改 Windows 的持久化环境变量或 PATH（命令找不到、找到旧版本、改了不生效）

## 核心原则

1. **CLI 优先，需要解析就加 `--json`**：查询先跑 CLI；要把结果交给程序或自己解析时统一加 `--json`（输出纯净：无 ANSI、无多余文本、错误非零退出）。
   本手册按**场景**组织，不追求穷举命令。要完整命令面就跑 `nx-rh help --json` 或
   `nx-rh routes --json`——那两份由代码生成，不可能与实现脱节。手册里没写到某条命令
   不等于它不存在（只保证反过来：手册里写了的都真实存在）。
2. **先读后写**：任何写操作（pull / push / sync / apply / resolve / materialize）执行前，先用 `list` / `status` / `conflict` 看清现状。
3. **冲突不静默**：遇到内容不一致时命令返回 `conflict` 状态并列出文件清单，必须显式 `--force` 或按文件选侧；不要用 `--force` 掩盖不确定性。
4. **幂等重试**：重复执行同一命令是安全的（已就绪会返回 `skipped`）；失败以非零退出码 + 可读错误返回，可安全重试。
5. **只动该动的**：`repo remove` 只注销登记、不碰磁盘；删除或覆盖类操作前先确认目标路径与影响面。
6. **链接优先**：skill 同步默认走 symlink（Windows 自动降级为 junction，免管理员）；链接创建失败会降级为复制，并在结果里标注降级原因。
7. **单一数据源**：所有状态集中在 `~/.nx-rh/store.json`（可用 `NX_RH_STORE` 覆盖，测试务必指向临时目录）。
8. **环境变量先 dry-run**：`env` 的每条写命令都支持 `--dry-run`，且每次写入前会自动快照。
   它改的是操作系统注册表（系统级影响整台机器），所以**先看 diff 再落盘**；
   改 PATH 一律用 `env path add|remove`，不要手拼字符串。

## 主流程（最短路径）

```
1. 定位：nx-rh repo list  ·  nx-rh skill list --side central|project [--path P]
2. 诊断：nx-rh repo status [id]  ·  nx-rh skill conflict <name> --project P
3. 行动：nx-rh repo pull|push <id>  ·  nx-rh skill sync|push|apply|materialize ...
4. 复核：重跑第 2 步，确认状态已按预期变化
5. 汇报：说明实际执行了什么 + 剩余风险（尤其冲突未处理项）
```

## 场景路由（ref-map）

| 场景 | 信号 | 何时读取 | 路径 |
| --- | --- | --- | --- |
| 仓库管理 | 登记 / 扫描 / 看状态 / 看 diff / 拉推 / 解决冲突文件 | 涉及 git 仓库的查询与读写时 | [[repo-ops]] |
| Skill 同步与冲突 | 中心与项目两侧不一致、要同步 / 推送 / 物化 | 涉及 skill 两侧识别与内容合并时 | [[skill-sync]] |
| 环境变量与 PATH | 查看 / 修改持久化环境变量、命令找不到、改了不生效 | 涉及 Windows 环境变量或 PATH 时 | [[env-manage]] |
| Agent 批量编排 | 多仓库/多 skill 批量处理、要纯 JSON、要幂等重试 | 把自己当执行器连续操作时 | [[agent-workflow]] |

> 扩展约定：新增场景时，先在 `references/<场景>.md` 写完整 SOP（步骤、判定标准、正反例），再在上表补一行并写清「何时读取」。主文档只保留原则与路由，场景级细节一律下沉。

## 检查清单

- [ ] 写操作前已读过现状（list / status / conflict）
- [ ] 需要程序消费时加了 `--json`
- [ ] 冲突未被 `--force` 掩盖，或已获得明确授权
- [ ] 环境变量类写入已先 dry-run，且改的是正确的 scope（user / system）
- [ ] 链接/复制降级情况已如实报告
- [ ] 结果向用户汇报了「做了什么 + 剩余风险」
