# 03 · CLI 对外契约

> 归属主文档 [[server-cli-web-scaffold]]。读它当你要**定命令名**或**写第一个功能域**时。
> CLI 是这个项目对 agent 的接口——契约一旦定下，改动成本很高。

## 一、标准命令面（每个项目都该有这几个）

| 命令 | 作用 | 为什么是标准 |
| --- | --- | --- |
| `<name> serve [--port N] [--no-open]` | 起 Web 面板 | 唯一常驻命令；`--no-open` 给开发与 CI |
| `<name> skill install [name] [--to DIR] [--force]` | 把内置 skill 装到 `~/.claude/skills` | **让 agent 学会用这个工具** |
| `<name> help [主题]` | 命令表 | 由 action 声明生成，不是手写 |
| `<name> version` | 版本号 | 裸输出，方便 `V=$(xxx version)` |
| `<name> bootstrap [--json]` | 一次性拿齐上下文 | 省去 agent 多次往返 |
| `<name> health` | 存活 + 存储可达 | 排查用 |

`serve --port` 与 `--no-open` 是硬要求：自动化场景不能弹浏览器，端口必须可换。

## 二、skill install：这个骨架的分水岭

普通 CLI 工具只服务人；这个骨架的工具**同时服务 agent**。而 agent 要学会用它，
只能靠一份能被 `install` 的 skill。

### 约定

1. **包内自带 skill**：源码放 `assets/<skill名>/`（`SKILL.md` + `references/`），
   随 `npm publish` 一起发出去（`package.json` 的 `files` 必须包含 `assets/`）。
2. **默认装到用户级**：`~/.claude/skills/<skill名>`，这样在任何项目里都可用。
   `--to <dir>` 可换成项目级（如 `<项目>/.claude/skills`）。
3. **安装是三态的**，不静默覆盖：

| 目标状态 | 返回 | 退出码 |
| --- | --- | --- |
| 不存在 | 安装 | 0 |
| 存在且内容一致 | `{ status:'ok', skipped:true }` | 0 |
| 存在且内容不同 | `{ status:'conflict', files:[...] }` | 0（是业务结果，不是失败） |

只有显式 `--force` 才覆盖。**用户目录里的东西，永远不要静默覆盖。**

```js
// service.js 骨架
export async function installBundledSkill({ name = '<默认名>', to, force } = {}) {
  name = assertSafeName(name);                       // 拒绝路径穿越
  const src = join(ASSETS_DIR, name);
  if (!(await pathExists(join(src, 'SKILL.md')))) {
    throw notFound(`未找到内置 skill: ${name}（可用: ${available}）`);
  }
  const dst = join(resolve(to || DEFAULT_SKILLS_DIR), name);
  const files = await diffTrees(src, dst);           // 逐文件 md5
  if (!files.length) return { status: 'ok', skipped: true, path: dst, files: 0 };

  const exists = await pathExists(dst);
  if (exists && !force) return { status: 'conflict', path: dst, files, count: files.length };

  if (exists) await fsp.rm(dst, { recursive: true, force: true });
  await fsp.cp(src, dst, { recursive: true, dereference: true, force: true });
  return { status: 'ok', installed: !exists, replaced: exists, path: dst, files: files.length };
}
```

### `assets/` 下的目录名约定

`assets/<skill名>/` 的 `<skill名>` **取包名**（`<name>`），不要另起一个。
这样用户不必记两个名字：`npx <name> skill install` 装出来的就是 `<name>` 这个 skill，
装到 `~/.claude/skills/<name>`。多个内置 skill 时，第一个用包名，其余的按用途命名。

### 内置 skill 该写什么

它要让**零知识的 agent** 学会用这个 CLI。结构照 `repo-hub`：

- 主 `SKILL.md` 只放**核心原则 + 场景路由表**（ref-map），不堆细节
- `references/<场景>.md` 放具体 SOP、判定标准、正反例
- 主文档写清"何时读哪个 ref"——否则 ref 永远不会被读到

## 三、`--json` 契约（agent 依赖它）

| 契约 | 内容 |
| --- | --- |
| 输出 | **单个** JSON 值到 stdout；无 ANSI、无多余文本、无 `undefined` |
| 成功 | 直接输出数据本身（数组就是数组，对象就是对象），**不要**套 `{ok,data}` 外壳 |
| 失败 | `{"ok":false,"error":"<字符串>","code":"<错误码>"}` + 退出码 1 |
| 退出码 | `0` 成功（**含业务结果如冲突**）；`1` 失败 |
| 错误文本 | 中文可读，且**保留稳定的分类锚点**（见下） |

### 错误分类锚点

agent 需要判断"该重试还是该停下来问人"。给它稳定的子串或错误码：

| 失败类型 | 判断依据 | agent 该做什么 |
| --- | --- | --- |
| 参数/用法错误 | 文本含「用法:」或 `code: "INVALID_INPUT"` | 修正参数，不要盲目重试 |
| 业务前置缺失 | 文本含「未设置」「不存在」 | 先补齐前置，再重试 |
| 冲突 | `status: "conflict"`（**退出码 0**） | 停止自动化，转人工决策 |
| 网络/外部命令 | `code: "EXTERNAL"` | 可重试；连续失败上报用户 |

**两条实现纪律**：

1. 参数缺失的报错必须带完整用法串，不能只写「缺少参数 X」：
   ```js
   throw badInput(`用法: ${usageOf(action)} —— 缺少参数 --${spec.name}`);
   ```
2. 冲突是业务结果，**退出码 0**。别用退出码判断冲突——要看 `status`。

## 四、命名约定：资源型模块与其余模块

### 集合资源：固定五个动词

**先判断该不该是资源**——只有「用户会想改其中一条或删其中一条」的模块才是。
分类表见 [[00-design-and-verify]] 第七节，那里也写了每类模块的底线要求。

确认是集合资源后，命令名按固定五个来，**不要自创动词**：

| 操作 | 命令 | 路由 |
| --- | --- | --- |
| 查列表 | `X list` | `GET /api/X` |
| 查单条 | `X get <id>` | `GET /api/X/:id` |
| 增 | `X add …` | `POST /api/X` |
| 改 | `X update <id> …` | `PATCH /api/X/:id` |
| 删 | `X remove <id>` | `DELETE /api/X/:id` |

**避开这几个词**：`create` / `delete` / `modify` / `set`（用于集合时）。
它们语义上和 `add` / `remove` / `update` 重复，一旦两种并存，
agent 就得猜你这个项目用哪个——而 CRUD 完备性也没法机器检查了。

### 其余模块：动作动词，但同样要两端可达

不是资源就用动作动词（`sync` / `compare` / `push` / `materialize`），
这不受五动词约束。

**但「不勉强」不等于「可以随便」**：每个 action 仍然必须两端可达
（有 `cli` 必有 `http` 或显式 `null`），这条对**所有** action 成立——
只有 CRUD 资源额外受「五操作齐备」的约束。

单例配置类模块（settings）自然退化成两个动词：`X get` / `X set`，
不必硬凑成五个。

## 五、命令与 HTTP 一一对应

一条 action 同时声明两者，所以不可能分叉：

```js
{ id: 'skill.sync', cli: ['skill','sync'], http: ['POST','/api/skills/sync'], ... }
```

**方向刻意不对称**：每条 action 必有 `cli`，`http` 可为 `null`（纯 CLI 命令）。
这样"Web 上能做的 CLI 都能做"是结构保证，而 CLI 仍可以有面板不需要的命令。

### 双向可查

agent 常常是**从端点出发**的（看到面板 devtools 里的一个请求，要问怎么用 CLI 重放）。
所以给一条自省命令：

```bash
<name> routes                              # 全量命令 ↔ 路由对照
<name> routes --module repos               # 按模块过滤
<name> routes --http "POST /api/skills/apply"   # 反向：有端点，查该敲哪条命令
```

反向查找复用路由编译时的正则，这样带参路由也能匹配实例
（`DELETE /api/repos/r_abc` → `repo remove`）。

**统一到同一份数据**：`routes` 与 `help --json` 必须覆盖同一批命令，
否则你会得到两张长度不同的"命令表"。加个断言钉住。

## 六、help 由声明生成

不要手写 help 文本——它必然与实际命令脱节。

```js
export function usageOf(action) {
  const parts = ['<name>', ...cliPathsOf(action)[0]];
  for (const a of argSpecsOf(action)) parts.push(a.required ? `<${a.name}>` : `[${a.name}]`);
  for (const f of flagSpecsOf(action)) {
    let token;
    if (f.type === 'boolean') token = `--${f.name}`;
    else {
      // 值的占位符优先用 enum 展开，其次显式 hint，最后才退回 flag 名——
      // `--side <side>` 这种读起来没有信息量
      const hint = f.enum ? f.enum.join('|') : f.hint || f.name;
      token = `--${f.name} <${hint}>`;
    }
    parts.push(f.required ? token : `[${token}]`);
  }
  return parts.join(' ');
}
// → xxx skill sync <name> --project <project> [--mode <symlink|copy>] [--force]
```

主题要**同时接受模块 id 与命令组**——用户脑子里想的是"repo 相关的东西"，
不会去记内部模块名：

```js
function helpEntries(topic) {
  const all = ALL_COMMANDS.map(commandEntry);
  if (!topic) return all;
  if (MODULES.some((m) => m.id === topic)) return all.filter((e) => e.module === topic);
  const byRoot = all.filter((e) => e.command.split(' ')[1] === topic);   // repo / skill / gh
  if (byRoot.length) return byRoot;
  const byId = all.filter((e) => e.id === topic);                        // repo.add
  if (byId.length) return byId;
  throw badInput(`未知帮助主题: ${topic}（可用模块: ...；或命令组如 repo / skill）`);
}
```

## 七、flag 解析规则（逐条定死，否则各写各的）

| 规则 | 说明 |
| --- | --- |
| 布尔 flag 不吞下一个 token | 只有 action 声明的 `type:'boolean'` 才不取值。所以 `--force demo` 里 `demo` 是位置参数 |
| 带连字符的 flag 名 | 字面匹配，`--no-open` 就是个普通名字，不做拆分 |
| `--flag=value` | 支持；`=` 之后全是值，不再按 flag 解析 |
| 需要值的 flag 写在末尾 | **报错**，不要静默转换。`--depth` 无值 → `Number(true)` 会变成「深度 1」这种另一个合法值 |
| 未知 flag | **报错**，不要当位置参数吞掉。`--fiile` 这类拼写错误应该立刻被指出来 |
| 全局 flag | `--json` / `--store` 可以出现在 argv 任意位置，先摘掉再匹配命令 |
| 命令路径里可以含 flag | `skill install --list` 是一条**命令路径**而非「install 带 --list flag」。匹配按 token 前缀逐字比，最长优先 |
| 位置参数多余 | 报错，并提示用法 |

## 八、help / version / serve 是 action 吗

判据一句话：**业务能力做成模块 action；纯 CLI 运行时关注点做成平台命令**。

| | 归属 | 理由 |
| --- | --- | --- |
| `serve` / `help` / `version` | 平台命令（`runtime/cli.js` 的 `BUILTINS`） | 不属于任何业务域；`help` 更是 CLI 自身的帮助 |
| `bootstrap` / `health` / `routes` | 模块 action（`modules/system`） | 它们返回的是**业务上下文数据**，也应有 HTTP 路由 |
| 各业务命令 | 各模块 action | —— |

两者合成同一张 `ALL_COMMANDS`，所以：
- `help` 不会漏掉平台命令
- `routes` 与 `help --json` 条目数一致
- 只有一张命令表，不存在"第二份清单"

细节见 [[00-design-and-verify]] 第五节。

## 九、踩过的坑

| 坑 | 后果 | 正确做法 |
| --- | --- | --- |
| help 手写 | 与实际命令脱节，用户看到不存在的命令 | 从 action 声明生成 |
| 参数缺失只报「缺少参数 X」 | 丢掉 agent 依赖的「用法:」锚点，最常见的失败被归为"不确定" | 报错带完整用法串 |
| 冲突用退出码 1 表达 | agent 把正常的待决策状态当成失败 | 冲突是业务结果，退出码 0 + `status` 字段 |
| `--json` 输出前后有多余文本 | agent 无法 `JSON.parse` | stdout 只有单个 JSON 值 |
| 无返回值的命令打出 `undefined` | 同上 | emit 不序列化 `undefined` |
| 需要值的 flag 写在末尾 | `Number(true)` 静默变成 1，笔误成了另一个合法值 | 缺值直接报错 |
| 安装 skill 时静默覆盖 | 用户目录里的修改被无声抹掉 | 三态返回，冲突要显式 `--force` |
| `routes` 与 `help` 各建一份命令表 | 两张长度不同的表，用户困惑 | 共用同一个 `commandEntry` |
| 布尔 flag 靠全局白名单判断 | `--force demo` 把 `demo` 吃成 force 的值 | flag 规格随 action 声明 |
