# nx-rh-rs — npx-repo-hub 的 Rust 原生实现

> **试验版**：与 JS 版 `nx-rh` 命令面与功能完全一致，但用 Rust 重写了一遍运行时。
> 目的是验证「server-cli-web 规范」能否平移到原生二进制上。

## 与 nx-rh 的关系

| | nx-rh（JS） | nx-rh-rs（本目录） |
| --- | --- | --- |
| npm 包名 | `nx-rh` | `nx-rh-rs` |
| 命令名 | `nx-rh` | `nx-rh-rs` |
| 配置文件 | `~/.nx-rh/store.json` | `~/.nx-rh-rs/store.json` |
| 面板端口 | 7800 | **7801** |
| action 条数 | 79 | 79（逐条对齐） |
| HTTP 路由数 | 71 | 71（逐条对齐） |

**两版可以同时跑**（端口 +1、配置目录分离），方便逐条对比。

## 命令面完全一致

```
nx-rh <命令>       ≡   nx-rh-rs <命令>
```

包括别名（`skill hub list` / `skill scan` / `skill list` …）、`--json` 输出形状、
`--store` 覆盖、错误文案里的「用法:」「未设置」「不存在」锚点，全部一致。

对照脚本见 `tests/compare.cjs`（需先构建两版二进制）。

## 架构：规范原样平移

```
core/       零业务语义的基础设施（paths/errors/store/fs/diff/archive/git/envvars/link）
modules/    功能域，每个自包含（system/skills/settings/env/bundled/worktrees）
runtime/    装配层：把 action 表编译成 CLI 命令表与 HTTP 路由表
web/        同一份前端产物，编译进二进制（include_dir 嵌入）
```

三条核心不变量在 Rust 侧**由编译器而非 lint 保证**：

1. **一条 action 定义，三端同时暴露** —— `Action { cli, http, run, render }`，
   CLI 命令表 / HTTP 路由表 / help 文本全部由此派生（`src/runtime/spec.rs`）。
2. **依赖只能向下** —— crate 依赖图由编译器拒绝越层 import。
3. **失败抛异常，业务结果返回 `{ status }`** —— `Res<T> = Result<T, AppError>`；
   `AppError` 的 code 是封闭集合，HTTP 状态只在一处映射。

## 构建

```bash
cd prev/nx-rh-rs

# Windows + GNU 工具链（本机路径示例）
export RUSTUP_HOME="D:\\a_asm\\rust\\rustup"
export CARGO_HOME="D:\\a_asm\\rust\\cargo"
export PATH="/d/a_asm/rust/mingw/mingw64/bin:/d/a_asm/rust/cargo/bin:$PATH"

cargo +stable-x86_64-pc-windows-gnu build --release
cargo +stable-x86_64-pc-windows-gnu test --release
```

> MSVC 工具链需要 Visual Studio Build Tools（本机未装，故用 GNU；
> `dlltool` 由 MinGW-w64 提供）。

## 运行

```bash
./target/release/nx-rh-rs help
./target/release/nx-rh-rs serve            # 面板在 :7801
./target/release/nx-rh-rs skill hub list --json
```

## npm 分发（与 nx-rh 同一形状）

主包只有几十行 JS 壳，各平台二进制在独立平台包里，npm 按 `os`/`cpu` 自动安装：

```
nx-rh-rs                      ← 主包：bin/nx-rh-rs.mjs + assets/（内置 skill）
nx-rh-rs-win32-x64-msvc       ← 平台包：bin/nx-rh-rs.exe
nx-rh-rs-win32-x64-gnu
nx-rh-rs-darwin-x64
nx-rh-rs-darwin-arm64
nx-rh-rs-linux-x64-gnu
nx-rh-rs-linux-x64-musl
```

**二进制不随主包走**——`npm/` 目录只有壳与 assets。

## 发版

`.github/workflows/release.yml`（手动触发 / tag 触发）：

- `workflow_dispatch` → 只构建 + 冒烟，不发布（`publish: false`）
- `workflow_dispatch` + `publish: true` → 构建矩阵 → 发布平台包 → 发布主包
- push `nx-rh-rs-v*` tag → 直接发布

发布走 npm Trusted Publishing（OIDC 零 token）。

## 与 JS 版的差异（刻意为之）

| 项 | 差异 | 原因 |
| --- | --- | --- |
| 配置文件目录 | `~/.nx-rh-rs/` | 两版同时跑不打架 |
| 面板端口 | 7801 | 同上 |
| 命令名 | `nx-rh-rs` | npm 包名不同 |
| 静态资源 | 嵌入二进制（`include_dir`） | 单文件分发，不落临时目录 |
| HTTP 客户端 | `curl` 子进程（下载 / skills.sh 搜索） | 避免引入 TLS 依赖 |
| env 驱动 | PowerShell（与 JS 版同款） | 注入防线是结构性的，不靠转义 |

## 对齐断言

`src/tests.rs`（22 条）覆盖：action id 唯一 / CLI 路径唯一 / 路由唯一 /
每条 action 必有 CLI / 用法串反推 / 路由匹配 / 参数校验 / 错误契约 /
HTTP 状态映射 / 安全名校验 / frontmatter / gitignore / markdown outline。

改任何一边而另一边没跟上，这些断言会红。
