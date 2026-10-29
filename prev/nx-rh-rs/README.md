# nx-rh-rs — npx-repo-hub 的 Rust 原生实现

> **试验版**：与 JS 版 `nx-rh` 命令面与功能完全一致，但用 Rust 重写了一遍运行时。
> 目的是验证「server-cli-web 规范」能否平移到原生二进制上。
> 结论：**规范可平移，实现资产要换**。这份代码就是那条路线的落地样本。

## 与 nx-rh 的关系

| | nx-rh（JS） | nx-rh-rs（本目录） |
| --- | --- | --- |
| npm 包名 | `nx-rh` | `nx-rh-rs` |
| 命令名 | `nx-rh` | `nx-rh-rs` |
| 配置文件 | `~/.nx-rh/store.json` | `~/.nx-rh-rs/store.json` |
| 面板端口 | 7800 | **7801** |
| action 条数 | 79 | 79（逐条对齐） |
| HTTP 路由数 | 71 | 71（逐条对齐） |
| 代码规模 | — | ~15k 行 Rust，**零运行时依赖**（不装 node 也能跑） |

**两版可以同时跑**（端口 +1、配置目录分离），方便逐条对比、来回切。

## 命令面完全一致

```
nx-rh <命令>       ≡   nx-rh-rs <命令>
```

包括**别名**（`bundled list` / `skill scan` / `skill adapt` / `skill describe` …）、
`--json` 输出形状、`--store` 覆盖、help 版面、错误文案里的「用法:」「未设置」
「不存在」锚点 —— 全部逐字一致。

三处**刻意**不同（由对照脚本归一化掉，其余一律不许差）：

1. 命令名 `nx-rh-rs`（npm 包名不同）
2. 配置目录 `~/.nx-rh-rs/`、面板端口 `7801`（两版要能同时启动）
3. 版本号各自推进

### 怎么验

```bash
cd prev/nx-rh-rs
cargo build --release

# 1) action 表 / 路由表 / usage 串 / help 版面 / 只读命令的 --json 形状与人读输出
node tests/compare.cjs node ./target/release/nx-rh-rs.exe

# 2) 别名集合（help --json 只暴露主路径，别名得单独比）
cd ../.. && node prev/nx-rh-rs/tests/alias-diff.mjs

# 3) 契约断言
cd prev/nx-rh-rs && cargo test --release
```

`compare.cjs` 让两版读**同一份临时 store**（否则比出来的全是「一边有数据一边空」的噪声），
并在文本比对前归一化命令名 / 端口 / 版本号。`env snapshot list` 这类读的是各自应用目录的
命令只比对类型，内容必然不同。

## 架构：规范原样平移

```
core/       零业务语义的基础设施（paths/errors/store/fs/diff/archive/git/envvars/link）
modules/    功能域，每个自包含（system/skills/settings/env/bundled/worktrees）
runtime/    装配层：把 action 表编译成 CLI 命令表与 HTTP 路由表
frontend/   JS 版 `vite build` 的产物，编译期嵌进二进制（include_dir 嵌入）
assets/     内置 skill 包（SKILL.md + references/），同样嵌进二进制
```

三条核心不变量在 Rust 侧**由编译器而非 lint 保证**：

1. **一条 action 定义，三端同时暴露** —— `Action { cli, http, run, render }`，
   CLI 命令表 / HTTP 路由表 / help 文本全部由此派生（`src/runtime/spec.rs`）。
   别名是 `cli: Vec<Vec<&str>>`，注册期自检「CLI 路径不得重复」。
2. **依赖只能向下** —— core 不 import modules / runtime；越层是编译错误。
3. **失败抛异常，业务结果返回 `{ status }`** —— `Res<T> = Result<T, AppError>`；
   `AppError` 的 code 是封闭集合，HTTP 状态只在一处映射。新增一个 status 变体，
   所有 `match` 都会编译失败，不存在漏处理 Conflict。

## 构建

```bash
cd prev/nx-rh-rs

# 面板产物不在 git 里（../../src/web/public/ 是 gitignore 的），先构建再拷进来
(cd ../.. && pnpm install --frozen-lockfile && pnpm run build)
rm -rf frontend && mkdir -p frontend && cp -r ../../src/web/public/. frontend/

# Windows + GNU 工具链（本机路径示例）
export RUSTUP_HOME="D:\\a_asm\\rust\\rustup"
export CARGO_HOME="D:\\a_asm\\rust\\cargo"
export PATH="/d/a_asm/rust/mingw/mingw64/bin:/d/a_asm/rust/cargo/bin:$PATH"

cargo +stable-x86_64-pc-windows-gnu build --release
cargo +stable-x86_64-pc-windows-gnu test --release
```

> 仓库里带了一份 `frontend/` 快照，所以**不跑 vite 也能编译**（用的是上次的产物）。
> 发版工作流每次都会重新构建并覆盖它 —— 发布出去的二进制里嵌的一定是本版本的面板。

> MSVC 工具链需要 Visual Studio Build Tools（本机未装，故用 GNU；
> `dlltool` 由 MinGW-w64 提供）。CI 上 msvc / gnu 两套都构建。

## 运行

```bash
./target/release/nx-rh-rs help
./target/release/nx-rh-rs serve            # 面板在 :7801
./target/release/nx-rh-rs skill hub list --json
```

## npm 分发

主包只有几十行 JS 壳；二进制按平台分包，npm 按 `os`/`cpu` 自动装：

```
nx-rh-rs                       ← 主包：bin/nx-rh-rs.mjs
                                 + binaries/win32-x64-msvc/、binaries/win32-x64-gnu/
nx-rh-rs-darwin-x64            ← 平台包：bin/nx-rh-rs
nx-rh-rs-darwin-arm64
nx-rh-rs-linux-x64-gnu
nx-rh-rs-linux-x64-musl
```

**为什么 win32 跟着主包走**：npm 账号的新建包通道被 spam detection 封了
（已存在的包发新版本不受影响），`nx-rh-rs-win32-x64-*` 这两个新包名发不出去。
壳里本来就有 `binaries/<key>/` 兜底路径，于是 win32 二进制随主包内嵌。
等账号解禁，把工作流矩阵里的 `embedded` 改回 `false`、`pkg` 改回 `nx-rh-rs-win32-*`
即可，发布链路不用动。

内置 skill（`assets/`）**不进 npm 包**：它们已经用 `include_dir` 编进二进制，
主包里再放一份只会与 crate 里那份漂移。所以 `nx-rh-rs skill install` 在没有
`assets/` 目录的机器上照样能装。

## 发版

`.github/workflows/release-nx-rh-rs.yml`（手动触发 / tag 触发）：

- `workflow_dispatch`（`publish: false`）→ 只构建 + 冒烟，不发布
- `workflow_dispatch`（`publish: true`）→ 构建矩阵 → 发布平台包 → 发布主包
- push `nx-rh-rs-v*` tag → 直接发布

版本号不用先提交一次：

```bash
gh workflow run release-nx-rh-rs.yml -f version=0.19.0 -f publish=true
# 留空 version 则读 Cargo.toml
```

流水线里各段的分工（每段都有断言，缺一步就红，不做静默跳过）：

1. build 矩阵：`pnpm build` → 面板拷进 `frontend/` → `cargo build --release --locked`
   → 二进制冒烟 → JS 壳解析冒烟 → 打 artifact
2. publish：下载 artifact → 归一化布局 → 版本戳 → 摊内嵌二进制进 `npm/binaries/<key>/`
   → 逐个发平台包（已发布跳过、spam detection 退避重试）→ 发主包 → 建 GitHub Release
3. verify（不发布时）：`cargo build` + `cargo test` + `version/help/routes` 冒烟

发布用 `NPM_TOKEN`（secret）+ `--provenance`（OIDC 签名）。

## 与 JS 版的差异（刻意为之）

| 项 | 差异 | 原因 |
| --- | --- | --- |
| 配置文件目录 | `~/.nx-rh-rs/` | 两版同时跑不打架 |
| 面板端口 | 7801 | 同上 |
| 命令名 | `nx-rh-rs` | npm 包名不同 |
| 静态资源 | 嵌入二进制（`include_dir`） | 单文件分发，不落临时目录 |
| HTTP 客户端 | `curl` 子进程（下载 / skills.sh 搜索） | 避免引入 TLS 依赖 |
| env 驱动 | PowerShell（与 JS 版同款） | 注入防线是结构性的，不靠转义 |
| 默认组推导 | 用 `DEFAULT_SKILL_NAME` 而不是「自己的包名」 | 包名 `nx-rh-rs` 不是任何 group 的键 |

## 对齐断言

`src/tests.rs`（28 条）覆盖：action id 唯一 / CLI 路径唯一 / 路由唯一 /
每条 action 必有 CLI / usage 串形状（布尔 flag 的方括号、hint 占位符、可选位置参数）/
**别名集合** / 平台命令 usage / 路由匹配 / 参数校验 / 错误契约 / HTTP 状态映射 /
名称模式（`--include` 的 glob 语义）/ 安全名校验 / frontmatter / gitignore / markdown outline。

改任何一边而另一边没跟上，这些断言会红 —— 它们就是「客户端 0 感知」的守卫。
