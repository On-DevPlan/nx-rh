# 05 · 发版：GitHub Actions + gh secret

> 归属主文档 [[server-cli-web-scaffold]]。读它当你要**配发布流水线**时。
>
> 目标：push 到 main 就自动发版，**不依赖开发者本机环境**。
> 配好之后，发版 = 改 `package.json` 的 version + push。

## 一、SOP：先探测，再补全

不要一上来就问用户要 token。**先自己查**，只问确实缺的东西。

### Step 1 · 确保远端仓库存在（不存在就建，默认公开）

```bash
# gh 可用且已登录？
gh auth status
```

失败就停下，让用户自己跑（**登录是交互式的，不要代为执行**）：

```
需要先安装并登录 GitHub CLI：
  gh auth login
完成后告诉我，我继续配置发布流水线。
```

登录正常后，先看本地是否已经关联远端：

```bash
git remote -v
gh repo view --json nameWithOwner,visibility,url    # 已在仓库目录里才有输出
```

**没有任何远端 → 直接建一个并推上去**（一条命令搞定关联与首次推送）：

```bash
gh repo create <包名> --public --source=. --remote=origin --push
```

| 参数 | 作用 |
| --- | --- |
| `--public` | **本骨架的默认**——这类工具的价值在于被复用，公开才能被 `npx` 到 |
| `--source=.` | 用当前目录作为仓库内容，不必先手动 `git init` 再关联 |
| `--remote=origin` | 自动加好远端，省掉 `git remote add` |
| `--push` | 顺手把当前分支推上去 |

**执行前先告知用户**：创建的是**公开**仓库。除非用户明确要私有，否则不要自作主张
换成 `--private`，也不要反过来偷偷建公开的——说一句"将创建公开仓库 `owner/name`"
再执行，成本极低。

已有的仓库要用 `--private`/`--public` 改可见性，得走
`gh repo edit <owner>/<name> --visibility public --accept-visibility-change-consequences`，
比新建敏感得多，**必须先问**。

拿到 `nameWithOwner`（如 `On-DevPlan/nx-rh`）写进 `package.json`：

```json
{
  "repository": { "type": "git", "url": "https://github.com/<owner>/<name>.git" },
  "homepage": "https://github.com/<owner>/<name>#readme",
  "bugs": { "url": "https://github.com/<owner>/<name>/issues" }
}
```

> 本地已经 `git init` 且只想补远端时，用
> `gh repo create <owner>/<name> --public --source=. --remote=origin --push`。
> 指定了 `owner/` 前缀就建在组织下，否则建在当前登录用户名下。

### Step 2 · 探测已有密钥

```bash
gh secret list
```

看 `NPM_TOKEN` 是否已存在。存在就跳过 Step 3。

### Step 3 · 缺什么问什么

只在确实缺失时才问，且**一次问清**，不要挤牙膏：

| 需要什么 | 怎么问 | 用户从哪拿 |
| --- | --- | --- |
| npm 发布令牌 | 「请提供 npm Automation Token（在 npmjs.com → Access Tokens → Generate New Token → **Automation**，这样能绕过 2FA）」 | npm 网站 |
| npm 包名 | 「包名打算叫什么？我会先查 npm 上是否被占用」 | 用户决定 |

拿到后**直接用 `gh` 写入仓库密钥**，不要让用户手动去网页点：

```bash
gh secret set NPM_TOKEN --body "<token>"
gh secret list          # 确认写入成功
```

说明给用户：GitHub 上的 secret 是加密存储的，仓库成员也需要有权限才能查看，
写在仓库设置里比留在本地 `.npmrc` 更安全。

若项目没配 `NPM_TOKEN` 也想发布，可改用 **OIDC Trusted Publishing**（npm 侧配置
可信发布者，工作流只需 `id-token: write`，完全不需要长期令牌）——这是更现代的方案，
能配就优先配。

### Step 4 · 确认包名可用

```bash
npm view <包名> version    # 有输出说明已被占用
```

被占用就让用户改名，不要硬发。

## 二、工作流文件

`.github/workflows/npm-publish.yml`：

```yaml
name: Publish to npm

on:
  push:
    branches: [main]

permissions:
  contents: write   # 写 tag 需要
  id-token: write   # --provenance 签名需要（OIDC）

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0                    # 必须 0：tag 检测要完整历史
          token: ${{ secrets.GITHUB_TOKEN }}

      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          registry-url: 'https://registry.npmjs.org'
          cache: 'pnpm'

      - run: pnpm install --frozen-lockfile
      - run: pnpm run build
      - run: pnpm test                       # 发版前必须全绿

      - name: 读版本号
        id: pkg
        run: |
          echo "name=$(node -p "require('./package.json').name")" >> $GITHUB_OUTPUT
          echo "version=$(node -p "require('./package.json').version")" >> $GITHUB_OUTPUT
          echo "tag=v$(node -p "require('./package.json').version")" >> $GITHUB_OUTPUT

      - name: 已存在则跳过（幂等）
        id: check
        run: |
          if git rev-parse "${{ steps.pkg.outputs.tag }}" >/dev/null 2>&1; then
            echo "tag_exists=true" >> $GITHUB_OUTPUT
          else
            echo "tag_exists=false" >> $GITHUB_OUTPUT
          fi
          if npm view ${{ steps.pkg.outputs.name }}@${{ steps.pkg.outputs.version }} version >/dev/null 2>&1; then
            echo "published=true" >> $GITHUB_OUTPUT
          else
            echo "published=false" >> $GITHUB_OUTPUT
          fi
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}

      - name: 打 tag
        if: steps.check.outputs.tag_exists == 'false'
        run: |
          git config user.name  "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git tag -a "${{ steps.pkg.outputs.tag }}" -m "Release ${{ steps.pkg.outputs.tag }}"
          git push origin "${{ steps.pkg.outputs.tag }}"

      - name: 发布
        if: steps.check.outputs.published == 'false'
        run: npm publish --provenance --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

### pnpm 版本要锁死

在 `package.json` 里写 `packageManager`，工作流**不要再另外指定 version**——
`pnpm/action-setup@v4` 会自动读它，两边都写反而容易不一致：

```json
{ "packageManager": "pnpm@10.33.0" }
```

**另一个坑**：较新的 pnpm 默认不执行依赖的构建脚本，`pnpm install` 会因
`ERR_PNPM_IGNORED_BUILDS`（典型是 esbuild）**以非 0 退出**，CI 直接失败。
处理方式二选一：

- 在 `package.json` 里声明允许构建的依赖（新版 pnpm 的位置与旧版 `pnpm` 字段不同，以
  pnpm 的提示为准）
- 或明确知道不需要构建脚本。esbuild 带预编译二进制，跳过构建脚本仍能正常
  `vite build`——但**不要靠这个侥幸**，CI 里 `pnpm install` 的退出码要当真

写完工作流后**先在本地把整条链跑一遍**（`pnpm install && pnpm test`），
确认退出码为 0 再 push，否则第一次发版就是一次失败的 CI。

### 三条关键设计

1. **幂等**：tag 已存在、或该版本已发布，都跳过而不是报错。
   否则重复 push（rebase、重跑工作流）会失败，用户被迫手工处理。
2. **`fetch-depth: 0`**：浅克隆下 `git rev-parse <tag>` 查不到历史 tag，
   会重复打 tag。
3. **`--provenance`**：让 npm 页面显示"由哪个仓库的哪次提交构建"，
   用户能看到包的真实来源。需要 `id-token: write`。

## 三、push 之后：用 gh 盯住流水线

**发布不是 push 完就结束。** 流水线跑在远端，本地不盯就不知道结果——
而 npm 上的坏版本撤不回来（只能 `npm deprecate`，包还在那里）。

### 等它跑完

```bash
# 取刚触发的那一次 run：按工作流文件名过滤，避免抓到别的仓库/别的 workflow 的 run
RUN=$(gh run list --workflow=npm-publish.yml --limit 1 \
        --json databaseId --jq '.[0].databaseId')

gh run watch "$RUN" --exit-status
```

`--exit-status` 是关键：**流水线失败时 `gh run watch` 以非 0 退出**，
可以直接当脚本或 agent 的判据，不用去解析输出文本。

它会阻塞到本次 run 结束。不想阻塞就先看一眼：

```bash
gh run list --limit 5          # 最近几次：状态、耗时、分支
gh run view "$RUN"             # 单次的步骤明细
```

### 失败了怎么办

```bash
gh run view "$RUN" --log-failed      # 只打失败步骤的日志，不用翻全文
```

常见三类：

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| `pnpm install` 非 0 退出 | 依赖构建脚本未获批（`ERR_PNPM_IGNORED_BUILDS`） | 见上文「pnpm 版本要锁死」 |
| `npm publish` 401 / 403 | token 无效或过期；也可能是用了普通 token 而账号开了 2FA | 重新生成 **Automation** token，再 `gh secret set NPM_TOKEN` |
| 日志显示"跳过"而非发布 | 幂等分支生效（tag 已存在 / 版本已发布），**这不是失败** | 确认是跳过即可；真要重发就改 `version` |

改完直接重新 push——工作流是幂等的，可以安全重跑。

### 可选：给 tag 建 GitHub Release

npm 发布成功后顺手建 Release，仓库页上就有变更记录了：

```bash
TAG="v$(node -p "require('./package.json').version")"
gh release create "$TAG" --title "$TAG" --generate-notes
```

`--generate-notes` 从提交/PR 自动生成说明；想用自己写的 CHANGELOG 就换
`--notes-file`。这一步也可以写进工作流（CI 里用 `GITHUB_TOKEN` 即可）。

### 全部跑通后确认三件事

```bash
gh run list --limit 1                  # 最近一次是成功
npm view <包名> version                 # npm 上确实有新版本
gh release view --json tagName,url      # （若建了 Release）页面存在
```

## 四、发版流程（配好之后）

```bash
# 1. 改版本号
npm version patch   # 或 minor / major（会同时打本地 tag，视习惯而定）
#    —— 也可以只手工改 package.json 的 version，tag 交给 CI 打

# 2. 更新 CHANGELOG
# 3. push
git push

# 4. 盯住流水线（别 push 完就不管了）
RUN=$(gh run list --workflow=npm-publish.yml --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$RUN" --exit-status
```

四步走完才算发完。CI 会自动：构建 → 测试 → 打 tag → `npm publish --provenance`。

**提醒用户**：这个流水线是 **push 到 main 即发布**。改 `package.json` 的 version
就等于"准备发版"，推之前要确认改动确实就绪。

## 五、CHANGELOG 约定

用 [Keep a Changelog](https://keepachangelog.com/) 的分类，中文正文即可：

```markdown
## [0.6.0] - 2026-09-16

### Added
### Changed
### Fixed
### Removed
```

对**破坏性变更**要单独说清楚，并且给出迁移方式。特别是：

- CLI 命令名变化 → 列出旧名 → 新名
- `--json` 输出形状变化 → 说明老消费方要改什么
- HTTP 接口路径变化 → 说明前端是否同步更新

这些是 agent 与脚本直接依赖的契约，改了就写进 CHANGELOG，
不要指望用户去翻 diff。

## 六、踩过的坑

| 坑 | 后果 | 正确做法 |
| --- | --- | --- |
| 一上来就问用户要 token | 用户被迫回答本可自动探测的问题 | 先 `gh auth status` / `gh secret list` 探测 |
| 让用户手动去网页设 secret | 步骤多、易错、用户可能设错名字 | 用 `gh secret set` 代劳 |
| 工作流不幂等 | 重跑必失败，被迫手工干预 | tag 存在 / 版本已发布 → 跳过 |
| `fetch-depth` 用默认（1） | 查不到历史 tag，重复打 tag 报错 | 显式 `fetch-depth: 0` |
| 发版前不跑测试 | 坏版本进了 npm，且不可撤销（只能 deprecate） | workflow 里 `pnpm test` 是前置步骤 |
| 忘记 `assets/` 在 `files` 里 | 内置 skill 没进包，`skill install` 找不到 | `package.json` 的 `files` 必须含 `assets/` |
| 用普通 npm token | 账号开了 2FA 时 CI 发布失败 | 用 Automation Token（或 OIDC 可信发布） |
| 破坏性变更只写在 diff 里 | 依赖方（尤其 agent）静默失效 | CHANGELOG 明确列出并给迁移方式 |
| 没锁 pnpm 版本 | 本地能过、CI 因版本差异失败 | `packageManager` 锁死，工作流不另写 version |
| 忽略 `pnpm install` 的非 0 退出 | CI 带病继续，发布出不可用的包 | 本地先跑通整条链；`ERR_PNPM_IGNORED_BUILDS` 要显式处理 |
| 让用户自己去网页建仓库 | 步骤多、易错，还可能忘了关联远端 | `gh repo create <name> --public --source=. --remote=origin --push` 一条搞定 |
| 不打招呼就建公开仓库 | 用户的代码被公开了，而他没预期 | 执行前说一句「将创建公开仓库 owner/name」；改已有仓库可见性必须**先问** |
| **push 完就不管流水线** | 坏版本进了 npm，撤不回来 | `gh run watch "$RUN" --exit-status`，非 0 退出即失败 |
| 用 `gh run watch` 不带 run id | 可能盯到别的 run（别的分支/别的 workflow） | 先 `gh run list --workflow=<file> --json databaseId` 取准 |
| 失败时翻全量日志 | 几千行里找一行错误 | `gh run view "$RUN" --log-failed` 只打失败步骤 |
| 把「跳过」当成失败 | 白折腾一轮去"修复"幂等分支 | 日志说跳过就是成功，要重发得改 version |
