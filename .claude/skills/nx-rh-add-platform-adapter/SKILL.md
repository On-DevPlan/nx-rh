---
name: nx-rh-add-platform-adapter
name_en: nx-rh Add Platform Adapter
name_zh: nx-rh 平台适配器新增
description: Add or adjust an Agent platform adapter in nx-rh's Skill Hub — the full change surface (adapters.js ADAPTERS + PLATFORM_ALIASES, README adapter table, built-in manual skill-hub.md platform table, skills-adapters unit tests) plus the verification chain (eslint, build zero-diff, unit, smoke, `skill hub adapters` absolute-path check). Use when adding a platform (e.g. qianwen, trae-cn, doubao) to nx-rh, changing platform aliases or skill directories, or syncing the platform tables.
description_en: Add or adjust an Agent platform adapter in nx-rh's Skill Hub — the full change surface (adapters.js ADAPTERS + PLATFORM_ALIASES, README adapter table, built-in manual skill-hub.md platform table, skills-adapters unit tests) plus the verification chain (eslint, build zero-diff, unit, smoke, `skill hub adapters` absolute-path check). Use when adding a platform (e.g. qianwen, trae-cn, doubao) to nx-rh, changing platform aliases or skill directories, or syncing the platform tables.
description_zh: 给 nx-rh Skill Hub 新增或调整 Agent 平台适配器：固定 4 文件改动面（adapters.js 的 ADAPTERS + PLATFORM_ALIASES、README 适配器表、内置手册 skill-hub.md 平台表、skills-adapters 单测）与验证链（eslint / build 零 diff / unit / smoke / `skill hub adapters` 核对绝对落点）。用于给 nx-rh 加平台（qianwen、trae-cn、豆包等）、改平台别名或落点目录、同步三处平台表、补平台单测时。
argument-hint: Describe the platform to add (name, config dir, user/project skill paths)
argument-hint-en: Describe the platform to add (name, config dir, user/project skill paths)
argument-hint-zh: 说明要新增的平台（名称、配置目录、用户级/项目级 skills 路径）
user-invocable: true
---

# nx-rh — 新增 Agent 平台适配器

给 nx-rh（Skill Hub）新增 / 调整一个 Agent 平台适配器（Trae、Qianwen、Doubao 这类工具的 skill 读取目录）。仓库根：`D:\code\a_js\proj\nx-rh`。触发语：「给 nx-rh 加个平台」「加 qianwen / trae-cn 平台」「改平台别名 / 落点」「adapters.js 加一行」。

## 改动面总览（固定 4 文件）

| # | 文件 | 角色 | 改什么 |
|---|------|------|--------|
| 1 | `src/modules/skills/adapters.js` | **唯一真相源**（Web 下拉、CLI `--platform` 校验、目标目录解析都由它派生） | `ADAPTERS` 加条目 + `PLATFORM_ALIASES` 加别名 |
| 2 | `README.md`「### 适配器」节 | 文档副本 | 表加一行 + 特殊口径说明 |
| 3 | `assets/nx-rh/references/skill-hub.md`「## 平台与安装位置」节 | 文档副本（内置手册） | 表加一行 + 特殊口径说明 |
| 4 | `tests/unit/skills-adapters.test.mjs` | 回归测试 | 头注释 + 新平台用例 |

> 三处平台表副本必须同步，漏一处 = 文档说谎。收尾用 `git status --porcelain` 核对**只**有这 4 个文件。

## 工作流

### ① 定落点（先考证，不猜）

1. **磁盘实测**：目标平台配置目录（`~/.trae-cn/`、`~/.qwenworkcn/`、`~/Doubao/` 这类）里找 `skills` 目录，确认其存在、层级与是否要 `SKILL.md`。
2. **口径核实**：查官方文档确认用户级 / 项目级支持情况；项目级可去常用仓库 find 该平台目录，看有没有带 `SKILL.md` 的实体佐证。
3. **产出**：`id`、`name`（显示名，中文平台带「（中文名）」）、`dir`（项目级，相对项目根）、`globalDir`（用户级，相对 home）、别名集合（id 自身 + 产品英文名 + 缩写）。
4. **特殊口径写进注释 + 三处文档**：
   - 无项目级约定（如 qianwen）→ `dir` 按 `.<id>/skills` 惯例给占位，写明「迁到项目级读不到，要生效用 `--to global`」。
   - 两级目录名不一致（如 trae-cn：项目 `.trae/skills` / 用户 `~/.trae-cn/skills`）→ 写明各自来源与实测情况。
   - 同族多版本（国内版 / 国际版）→ 只加本机实测的那个；给未实测的版本留「要聚焦就补一行 `id=xxx`」的说明。

### ② 改 `src/modules/skills/adapters.js`

`ADAPTERS` 在 `doubao` 之后、「其余平台保留」注释之前插入（注释把特殊点讲清）：

```js
  // Trae 国内版：用户级 ~/.trae-cn/skills（本机实测），但项目级两版共用 .trae/skills
  // （project-graph 仓库里就有三个带 SKILL.md 的实体）。国际版按同族约定是 ~/.trae/skills，
  // 本机未装未实测——真要聚焦国际版再加一行 id=trae 的适配器即可。
  { id: 'trae-cn', name: 'Trae CN（国内版）', dir: '.trae/skills', globalDir: '.trae-cn/skills' },
```

`PLATFORM_ALIASES` 加别名（id 自身也要写，是仓库惯例；有歧义的别名加注释说明取舍）：

```js
  'trae-cn': 'trae-cn',
  trae: 'trae-cn', // 本机只装国内版，裸 trae 就落到它；若哪天加了 id=trae 需重新斟酌这条
```

### ③ 同步两处文档平台表

- `README.md`「### 适配器」：`| 平台名 | 项目级目录 | 用户级目录 | universal |`，特殊口径在表后补一段。
- `assets/nx-rh/references/skill-hub.md`「## 平台与安装位置」：`| id | 别名（· 分隔） | 项目级 | 用户级 |`，特殊口径在表后补一段。

### ④ 补单测 `tests/unit/skills-adapters.test.mjs`

- 文件头注释补一句新平台特殊点（每个平台一段，历次累积）。
- 用例锁定：适配器存在 + 字段（id / dir / globalDir）、别名归一（含大小写混合）、两级绝对落点；跨版本别名注明取舍。

```js
test('Trae 国内版两级目录名不同：项目 .trae / 用户 .trae-cn', () => {
  const a = adapterById('trae-cn');
  assert.ok(a, 'trae-cn 适配器应存在');
  assert.equal(a.dir, '.trae/skills');
  assert.equal(a.globalDir, '.trae-cn/skills');
  const proj = join(tmp, 'proj2');
  assert.equal(targetDirFor('trae-cn', 'user', tmp), join(home, '.trae-cn', 'skills'));
  assert.equal(targetDirFor('trae-cn', 'project', proj), join(proj, '.trae', 'skills'));
});
```

- 顶部 fixture 的 `process.env.HOME` / `USERPROFILE` 必须在 `await import(adapters.js)` **之前**设置（`homedir()` 导入期读取），不要挪进用例。

### ⑤ 验证链（按序跑，全绿才算完成）

```bash
cd "D:/code/a_js/proj/nx-rh"

# 1) 改动文件 eslint
npx eslint src/modules/skills/adapters.js tests/unit/skills-adapters.test.mjs

# 2) 目标单测（新用例先在这里过）
node --test tests/unit/skills-adapters.test.mjs

# 3) 全量 lint + build，再核对零产物 diff：只应有那 4 个目标文件
pnpm run lint && pnpm run build && git status --porcelain

# 4) smoke 全过
node tests/smoke.mjs

# 5) 全量 unit（Windows 本地 worktrees 的预存在失败见「坑与约定」）
node --test tests/unit/*.test.mjs

# 6) CLI 核对新平台绝对落点 + [启用]/[默认] 标记（全局 CLI 同款：nx-rh skill hub adapters）
node bin/cli.mjs skill hub adapters
```

别名端到端补核：写临时 `.mjs` 脚本 import `src/modules/skills/svc/targets.js`，对每个别名（含大写混合）跑 `resolveTargets({ to: 'all', platform: '<别名>', project })`，核对归一为预期 id。**不要用多行 `node -e`**——本机 Git Bash 下会静默失败（无输出也无报错）。

### ⑥ 收尾约定

- **CHANGELOG 不动**：feature 提交不碰，留给 `chore(release)` 补写。
- **默认平台不动**：新平台默认不启用（CLI 显示 `[   ]`）；要启用让用户跑 `nx-rh skill platform <平台列表>`（首个为默认平台，claude-code 保持排最前）。
- **提交**：`feat(skills): 新增 <平台> 平台适配器`；提交前 `git status` 核对 4 文件；不主动提交，先问用户。

## 坑与约定

- **三处副本一致性**是最大坑：改完 `grep -n "<新id>\|<别名>" README.md assets/nx-rh/references/skill-hub.md src/modules/skills/adapters.js` 三方对照。
- **build 零 diff**：`src/web/public` 构建产物已提交；`pnpm run build` 后若 `git status` 出现产物 churn，说明前端硬编码了平台，需排查（正常零 diff）。
- **worktrees 预存在失败**：Windows 本地全量 unit 里 `worktrees.test.mjs` 可能失败（本仓库已知 2 例），与 skills 改动无关；用 `gh run list` 看 ubuntu CI 是否为绿佐证。
- **多行 `node -e` 静默失败**：验证脚本落成 `.mjs` 文件再 `node <file>`。
- **默认平台用例**：`skills-adapters.test.mjs` 里「默认平台保留且适配器 id 无重复」锁死 claude-code / workbuddy 与全表 id 唯一——新增条目不能破坏。

## 实战锚点

最近两例（同一 4 文件改动面；工作区带未提交改动时 `git --no-pager diff` 即最佳模板）：

- **qianwen（千问办公）**：官方只写用户级 `~/.qwenworkcn/skills`、无项目级约定 → 占位 + 三处 caveat；别名 `qwenwork / qwen / qw`。
- **trae-cn（Trae 国内版）**：两级目录名不同（项目 `.trae/skills`、用户 `~/.trae-cn/skills`）；裸别名 `trae` 落到国内版并注明取舍。

验证基线：eslint 干净；目标单测全过；build 零 diff；smoke 全过；全量 unit 仅余 worktrees 预存在失败；CLI `skill hub adapters` 显示新平台绝对路径与启用状态。
