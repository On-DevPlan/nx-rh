# vercel-labs/skills 参考笔记（供 nx-rh 使用）

- 克隆位置：`.claude/repo/skills/`
- 版本：`v1.5.26`，commit `d667282`（2026-09-11）
- 远端：`git@github.com:vercel-labs/skills.git`（SSH 浅克隆，122 个文件）
- 技术栈：TypeScript + Node ≥22，`bin/cli.mjs` 单入口，运行时可 `npx skills <cmd>`

本笔记只提炼与 nx-rh 直接相关的两块：**平台适配表** 与 **skill 软链接方案**，并附与现有 `br_controller/ext/native_host/internal/fileops/fileops.go` 的差异对照。

---

## 1. 平台适配表（`src/agents.ts` + `src/types.ts`）

### 1.1 数据结构

```ts
interface AgentConfig {
  name: string;                 // 机器标识，如 'claude-code'
  displayName: string;          // 展示名 'Claude Code'
  skillsDir: string;            // 项目级相对路径 '.claude/skills'
  globalSkillsDir: string | undefined; // 用户级绝对路径；undefined = 不支持全局安装
  detectInstalled: () => Promise<boolean>;  // 该工具的安装探测
  showInUniversalList?: boolean;   //  默认 true
  showInUniversalPrompt?: boolean; //  默认 true
  createProjectSkillsDirByDefault?: boolean; // 项目安装时是否可自动创建缺失目录
}
```

约 **85 个 agent** 一张常量表全覆盖（`agents.ts:80-823`），新增平台只需加一条，不改任何逻辑。
`detectInstalled()` 基本是 `existsSync(join(home, '.xxx'))`，少数做了多路径兜底（见 `getOpenClawGlobalSkillsDir` 依次探测 `~/.openclaw` → `~/.clawdbot` → `~/.moltbot`）。

### 1.2 两个关键概念

- **Universal agent**：`skillsDir === '.agents/skills'` 的 agent（amp / cursor / codex / gemini-cli / warp / zed 等）。它们天然共享同一目录，**不需要建软链接**。
  `isUniversalAgent()` / `getUniversalAgents()` / `getNonUniversalAgents()` 三个派生函数是全部链接逻辑的分流依据。
- **canonical 目录**：唯一真相源 = `{base}/.agents/skills/<skill>`（`getCanonicalSkillsDir()`，`installer.ts:128`）。
  非 universal agent 的目录（如 `.claude/skills`）通过**软链接指回 canonical**，从而实现「一处更新，处处生效」。

### 1.3 对 nx-rh 的启示

现有 `fileops.go` 的模型是「中心仓库 `{central}/skills` → 各项目 `.claude/skills`」的**跨项目推送**（源与目标都是实体目录，模式可选 symlink/copy）。

建议 nx-rh 保留自己的中心仓库语义，但把 agents.ts 这张表直接移植成 `src/config/agents.ts`：

- 表驱动 → 平台适配零逻辑改动，Web 端下拉框和 CLI 的 `--agent` 校验都从同一张表出；
- `skillsDir` 相对路径 + `globalSkillsDir` 绝对路径的双层结构，正好覆盖 nx-rh「本机各目录的 repo / config 管理」里「项目级 vs 用户级」两种范围；
- `detectInstalled()` 可作为 Web 面板「本机已安装哪些工具」的探测钩子。

---

## 2. skill 软链接方案（`src/installer.ts`）

核心函数 `createSymlink(target, linkPath)`（`installer.ts:227-293`），是整个仓库最值得抄的一段。

### 2.1 完整决策流程

```
createSymlink(canonicalDir, agentDir)
  ├─ realpath(双方)：完全相同 → 直接 return true（已就绪，避免自指 ELOOP）
  ├─ resolveParentSymlinks(双方)：父目录被软链时解析真实父目录 → 仍相同 → true
  ├─ lstat(linkPath) 清理旧目标
  │    ├─ 已是 symlink → 目标一致则 true；否则 rm 链接本体重建
  │    ├─ 是实体目录   → rm -rf 清掉
  │    └─ ELOOP 坏链   → 尝试 rm -f 忽略失败
  ├─ 计算相对路径：relative(realLinkDir, target)   ← 用「解析后的父目录」算，防破链
  └─ platform() === 'win32'
       ? symlink(绝对目标, linkPath, 'junction')   ← Windows：junction + 绝对路径
       : symlink(相对路径, linkPath)               ← POSIX：相对路径，可整目录搬迁
  失败 → return false → 调用方降级为复制目录
```

### 2.2 五个必须注意的细节

1. **Windows 用 junction 而非 symlink**
   `symlink(..., 'junction')` 不需要开发者模式/管理员权限，而 `os.symlink` 创建目录链接需要特权。这正是 `fileops.go:609 createSkillLink()` 里 `os.Symlink` 失败后降级 `mklink /J` 的同一动机 —— 但 Node 版本一步到位。
2. **junction 必须绝对目标；symlink 用相对路径**
   `installer.ts:285-286`：`junction → resolvedTarget`（绝对），其余 → `relativePath`（相对）。POSIX 用相对路径是为了仓库整体搬迁后链接不失效。
3. **父目录本身是软链时，必须先 realpath 父目录再算相对路径**
   `resolveParentSymlinks()`（`:211-221`）。场景：`~/.claude/skills` 本身软链到 `~/.agents/skills`，此时直接算相对路径会产出**断链**。
4. **先 realpath 比对，相同就直接返回 true**
   防止「canonical 与 agent 目录物理同一」时 `rm -rf` 把源删掉（自指 ELOOP，`:240-252`）。
5. **`pathsOverlap()` 守卫：绝不往源目录里安装**
   `installer.ts:357 / 378`。场景：`skills add ./skills` 时源 `./skills/<name>` 与目标同路径，若先清理目标等于删掉用户源。

### 2.3 复制模式与回退

- `copyDirectory()`（`:500`）：并行 `Promise.all` 复制；`cp(..., { dereference: true, recursive: true })` —— 遇软链**解引用成实体文件**，避免远端 skill 里的相对链接在本地失效；复制后 `chmod` 同步权限。
- 排除项：`EXCLUDE_FILES = {'metadata.json'}`、`EXCLUDE_DIRS = {'.git','__pycache__','__pypackages__'}`。
- **symlink 失败自动降级 copy**：`symlinkFailed: true` 标记返回（`:428-440`），安装永不因权限失败而中断。
- `cleanAndCreateDirectory()`（`:193`）：先 `rm -rf` 再 `mkdir`，保证不残留上一次安装的已删文件。

### 2.4 项目级安装的"不污染"策略

`shouldSkipProjectAgentSymlink()`（`:95-112`）：项目级安装时，若某非 universal agent 的根目录（如 `.windsurf/`、`.kiro/`）**在项目里本来就不存在**，就跳过建链 —— 避免为一个没用到的工具凭空造目录。skill 依然在 `.agents/skills/` 可用。这个策略对 nx-rh 的「多目录批量管理」很有参考价值。

---

## 3. 其他可复用件

| 文件 | 价值 | 对应现有实现 |
|---|---|---|
| `installer.ts:61 sanitizeName()` | 名称净化防路径穿越，顺带 kebab-case 归一，限 255 字符 | `fileops.go` 无此防护 |
| `installer.ts:84 isPathSafe()` / `pathsOverlap()` | `normalize(resolve())` 后前缀比对，写文件前统一校验 | 可补进 nx-rh 的 CLI 写操作 |
| `detect-agent.ts` | 环境变量探测「当前是否跑在 AI agent 内」，是则**自动切非交互模式**并推断目标 agent | nx-rh 的「CLI 供 agent 调用」场景直接适用 |
| `cli.ts:301-417` | 命令分发：`--json` 机器可读输出（无 ANSI）、子命令 `--help` 短路、命令别名(`add/a/i/install`) | 与 nx-rh「Web 每个按钮都有 CLI 对应」的设计吻合 |
| `frontmatter.ts` / `skills.ts parseSkillMd()` | SKILL.md frontmatter 解析（name/description） | 与 `fileops.go parseFrontmatter/parseDescription` 同构，可交叉验证 |
| `skill-lock.ts` / `local-lock.ts` | 哈希锁（`skills-lock.json`）：记录已装 skill 的源与内容哈希，`experimental_install` 可还原 | 可作 nx-rh「配置即代码」的锁文件设计参考 |
| `skill-relocation.ts` | 目标路径丢失后按「归一化名称唯一匹配」重定位；**歧义时 fail-closed 不迁移不删除** | 稳健性设计参考 |

---

## 4. 与现有 fileops.go 的差异速查

| 维度 | `fileops.go`（br_controller） | vercel skills |
|---|---|---|
| 拓扑 | 中心仓库 `{central}/skills` → 各项目 `.claude/skills` | canonical `.agents/skills` → 各 agent 目录 |
| 链接创建 | `os.Symlink` 失败 → `cmd mklink /J` 降级 | Node `symlink(..., 'junction')` 一步到位 |
| 链接目标 | 绝对路径（`filepath.Abs`） | win32 绝对 / POSIX 相对 |
| 父目录软链 | 未处理 | `resolveParentSymlinks()` 显式处理 |
| 自指 ELOOP | 未处理 | `realpath` 比对提前返回 |
| 名称净化 | 无 | `sanitizeName()` + `isPathSafe()` |
| 平台表 | 硬编码单一 `.claude/skills` | 85 agent 表驱动 |

**建议 nx-rh 直接采用 vercel 的链接算法（第 2 节），保留原有中心仓库 + 分组配置（setting.json）的业务语义。**
