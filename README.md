# nx-rh · npx-repo-hub

本机仓库与 Agent Skill 的统一管理中枢。一个 `npx` 命令同时给出两样东西：

1. **Web 操作面板**（监听本地端口，黑白清晰、无 emoji）——给人用；
2. **同构 CLI**——给 agent 用。面板上的每个按钮，底层都是同一条 CLI 命令，输出 `--json` 即可被任何 agent 直接消费。

数据落在一个地方：用户目录下的单一 JSON 文件（`~/.nx-rh/store.json`），web 表单和 CLI 读写的是同一份。

包管理器：pnpm。运行时：Node >= 18.17，零第三方依赖。

## 快速开始

```bash
# 开发模式（本仓库内）
node bin/cli.mjs serve              # 默认 http://127.0.0.1:7800，自动打开浏览器
node bin/cli.mjs serve --no-open    # 不打开浏览器
pnpm start                          # 等价

# 发布为 npm 包后
npx nx-rh serve

# 冒烟测试（33 项，临时存储，不碰用户目录）
pnpm test
```

## 架构：单 service 层，双前端

```
┌─────────────┐        ┌─────────────┐
│  Web 面板    │        │  agent CLI  │
│ (原生 fetch) │        │  nx-rh ...  │
└──────┬──────┘        └──────┬──────┘
       │ /api/*               │ --json
       ▼                      ▼
┌──────────────────────────────────────┐
│  service 层（唯一业务真相源）          │
│  services/repos.js   services/skills.js│
└──────┬───────────────┬───────────────┘
       ▼               ▼
┌──────────────┐  ┌──────────────────────┐
│ core/store   │  │ core/git · core/diff  │
│ ~/.nx-rh/    │  │ git CLI · LCS/diff3   │
│ store.json   │  └──────────────────────┘
└──────────────┘
```

新增一个能力的顺序永远是：先在 service 层写函数 → CLI 加命令 → Web 加按钮（一个 `fetch('/api/...')` 的 handler）。三者签名一致，不会分叉。

目录结构：

```
bin/cli.mjs              # 唯一入口
src/
  core/
    paths.js             # 常量与存储路径（NX_RH_STORE 可覆盖）
    store.js             # JSON 存储：原子写 + mtime 失效检测
    git.js               # git CLI 封装（status/diff/pull/push/resolve）
    diff.js              # LCS 行级 diff + unified 输出 + diff3-lite 三方合并
  services/
    repos.js             # 仓库 CRUD / 扫描 / git 操作
    skills.js            # skill 识别 / 软链接与复制同步 / 冲突 / 适配器
  cli/main.js            # 命令分发（每条命令 = 一个 service 函数）
  web/
    server.js            # node:http 静态 + /api 路由
    api.js               # 路由表（每条路由 = 一个 service 函数）
    open.js              # 跨平台打开浏览器
    public/              # index.html / app.js / style.css（无构建步骤）
tests/smoke.mjs          # 33 项全链路冒烟测试
```

## 存储

`~/.nx-rh/store.json`（`NX_RH_STORE` 环境变量可覆盖）：

```json
{
  "version": 1,
  "settings": {
    "skillCentralPath": "D:/skills-central",
    "skillSyncMode": "symlink"
  },
  "repos": [
    {
      "id": "r_xxx",
      "name": "nx-rh",
      "path": "D:/a_js/res/nx/nx-rh",
      "tags": ["tool"],
      "notes": "",
      "addedAt": "...",
      "updatedAt": "..."
    }
  ],
  "skillGroups": [{ "id": "ungrouped", "name": "未分组", "skills": [] }]
}
```

## CLI 命令总表

全部命令都支持 `--json`（机器可读输出，供 agent 消费）。

| 命令                                                                      | 对应 Web 操作         |
| ----------------------------------------------------------------------- | ----------------- |
| `nx-rh serve [--port 7800] [--no-open]`                                 | 启动面板              |
| `nx-rh repo list`                                                       | 仓库页：清单            |
| `nx-rh repo add <path> [--name N] [--tags a,b] [--notes T]`             | 添加仓库              |
| `nx-rh repo update <id> [...]`                                          | 编辑登记              |
| `nx-rh repo remove <id>`                                                | 删除登记（不动磁盘）        |
| `nx-rh repo scan <root> [--depth 3]`                                    | 扫描目录发现 git 仓库     |
| `nx-rh repo status [id]`                                                | 刷新状态              |
| `nx-rh repo diff <id> [--file F]`                                       | 行内 diff 按钮        |
| `nx-rh repo pull <id>` / `push <id>`                                    | 行内 pull/push 按钮   |
| `nx-rh repo resolve <id> --file F --side ours\|theirs`                  | 冲突文件落地            |
| `nx-rh repo open <id>`                                                  | 在文件管理器中打开         |
| `nx-rh skill central [path]`                                            | 中心仓库输入框 + 保存      |
| `nx-rh skill adapters`                                                  | 适配器清单             |
| `nx-rh skill list --side central\|project [--path P]  `                 | 识别两侧              |
| `nx-rh skill sync <name> --project P [--mode symlink\|copy] [--force]`  | 同步到项目             |
| `nx-rh skill push <name> --project P [--force]`                         | 推送到中心             |
| `nx-rh skill conflict <name> --project P`                               | 冲突详情              |
| `nx-rh skill apply <name> --project P --file F --side central\|project` | 冲突弹窗里的"用中心版/用项目版" |
| `nx-rh skill materialize <name> --project P`                            | 链接转实体             |
| `nx-rh skill merge --base F --a F --b F`                                | diff3 合并原语        |
| `nx-rh eco scan`                                                        | 生态页：读取 native host 状态 |
| `nx-rh eco import [--repos] [--skills] [--include-env] [--central P] [--mode] [--force]` | 生态页：导入 git 仓库 / skills |
| `nx-rh setting get/set`                                                 | 设置页               |

REST API 与命令一一对应（见 `src/web/api.js` 路由表），例如 `POST /api/skills/sync` ⇔ `nx-rh skill sync`。

## 生态导入（bro_chat_native_host）

浏览器插件（br_controller）的 native host 把进程状态写在 `~/.bro_chat_native_host/`：

```
processes.json / conpty_processes.json / pty_processes.json / window_processes.json
  -> [{ pid, name, cmd, args, workDir, logFile }]
env_snapshot_*.json -> { timestamp, userPath, systemPath, userVars, systemVars, processEnv }
logs/ -> 进程日志
```

「生态」页与 `nx-rh eco` 读取该目录（`NX_RH_BROCHAT_DIR` 可覆盖）：

1. **导入 git 仓库**：提取进程记录里的非空 `workDir`，向上最多找 5 级定位 git 根（进程目录常是仓库子目录），登记进 nx-rh 仓库（自动去重，打 `eco-import` 标签）。加 `--include-env` 会一并扫描 env 快照里的 PATH 目录（只登记真实存在的 git 仓库）。
2. **导入 skills**：对 `workDir`、其 git 根及检出 skill 的目录（含 `{path}/skills` 中心式与 `.claude/skills` 等项目式布局）逐个体检——按当前同步模式（软链接/复制）装进 nx-rh 中心仓库，冲突逐文件列出；没有可导入源时不要求配置中心。

```bash
nx-rh eco scan                                  # 看一眼插件启动过哪些目录、skill 在哪
nx-rh eco import --repos                        # 只导入仓库
nx-rh eco import --repos --include-env          # 连 env 快照的 PATH 目录一起扫
nx-rh eco import --skills --central D:\skills-central --force
nx-rh eco import                                # 两者都导
```

## Skill 同步

两侧模型：`{中心仓库}/skills/<name>` ⇄ `{项目}/<适配器目录>/<name>`。

- **识别**：扫描两侧目录，解析每个 `SKILL.md` 的 frontmatter（name/description），计算 md5，识别链接形态（symlink / junction / 实体）。
- **同步模式**：
  - `symlink`（默认）——项目侧放一个指向中心目录的链接。Windows 用 **junction**（无需管理员/开发者模式），POSIX 用**相对路径**符号链接（整目录搬迁不断链）。链接失败自动降级为复制，不中断操作。
  - `copy`——整目录复制（`dereference`，远端软链解引用成实体文件）。
- **冲突**：目标为实体且与中心 md5 不一致时返回 `conflict`（逐文件差异 + diff 文本），必须 `--force` 覆盖，或 `skill apply` 按文件选侧。不会静默删改用户目录。
- **物化**：链接 → 实体目录的独立复制（断开与中心的实时同步）。
- **三方合并**：`skill merge --base --a --b` 暴露 diff3-lite 原语（`core/diff.js`）：仅单侧变更的区域自动采用；双侧相同自动取一；双侧不同输出 `<<<<<<< / ======= / >>>>>>>` 冲突块。Web 面板有对应弹窗。
- **防护**：skill 名称校验拒绝路径穿越；链接创建前做 realpath 自指检测（防止误删源目录）；父目录为链接时先解析真实父目录再计算相对目标。

### 适配器

预设平台目录（`src/services/skills.js` 的 `ADAPTERS` 表，表驱动、可加行）：

| 平台                  | 项目级目录               | universal |
| ------------------- | ------------------- | --------- |
| Claude Code         | `.claude/skills`    |           |
| Universal (.agents) | `.agents/skills`    | 是         |
| Cursor              | `.cursor/skills`    |           |
| Codex               | `.codex/skills`     |           |
| Gemini CLI          | `.gemini/skills`    |           |
| GitHub Copilot      | `.copilot/skills`   |           |
| Windsurf            | `.windsurf/skills`  |           |
| CodeBuddy           | `.codebuddy/skills` |           |
| iFlow CLI           | `.iflow/skills`     |           |

同步落点规则：`--adapter` 指定 > 第一个已存在的适配器目录 > `.claude/skills` 兜底。

## 设计约定

- **无 emoji**：面板、CLI 输出、代码注释全程无 emoji。
- **黑白清晰**：单色 CSS（黑字白底、粗边框、悬停反色），系统字体，路径与 diff 用等宽字体。
- **agent 优先**：所有写操作幂等或显式报错；错误以 `exit code 1 + 可解析文本` 返回；`--json` 输出无 ANSI、无多余文本。
- **零依赖**：只用 Node 内置模块，离线可跑，`npx` 首次拉包即完。

## 参考项目

- [vercel-labs/skills](https://github.com/vercel-labs/skills) —— skill 链接算法与 85+ 平台适配表（已克隆到 `.claude/repo/skills`，提炼笔记见 `.claude/nx-rh-skill-reference.md`）
- [typicode/json-server](https://github.com/typicode/json-server) —— npx + JSON 文件 + REST 的最小参考（`.claude/repo/json-server`）
- [javimosch/adminer-node](https://github.com/javimosch/adminer-node) —— node:http 零框架 + 路由注册表 + 用户目录 config 的面板模式（`.claude/repo/adminer-node`）

## 路线图

- skill 分组管理（store.skillGroups 已有数据结构）
- 上次同步快照缓存，让 skill 侧也能走真正的三方合并
- 批量操作（同步到所有项目 / 从所有项目移除）
- `npm publish` 后 `npx nx-rh serve`（发布前确认包名 `nx-rh` 未占用）

## License

MIT
