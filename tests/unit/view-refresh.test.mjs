// 一致性测试：「写操作成功后界面自动反映新状态」从口头约定变成可执行断言。
//
// 改造前的真实缺口（用户在面板上反复遇到的）：
//   · 在「平台范围」里停用一个平台 → 关掉弹窗，总览的平台卡片仍是「已启用」；
//   · 迁移 / 收进 / 彻底删除几个 skill → 回总览，平台统计数与订阅源计数还是旧的；
//   · 订阅一个新目录 → 当前 hash 没变，网格里不出新卡片，看着像点了没反应。
//   ——共同点：写完之后「谁该重拉」全靠各处调用方自觉，漏一处就非 F5 不可见。
//
// 现在的结构约定（见 src/web/frontend/store.jsx「写后失效」）：
//   1. 写操作的收尾只有一个：store 的 afterWrite()（广播 dataEpoch + 重拉 bootstrap）；
//   2. 取数据的钩子把 dataEpoch 放进 effect 依赖，纪元一变就重拉；
//   3. 视图层不再直接调 refreshBoot —— 它只刷 bootstrap，刷不到视图自己的数据。
//
// 这组断言守的就是这三条：重新出现「局部刷新」的写法时，这里立刻红。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MODULES_DIR = join(ROOT, 'src', 'modules');
const STORE = join(ROOT, 'src', 'web', 'frontend', 'store.jsx');

const read = (p) => readFileSync(p, 'utf8');

// 模块目录下全部视图源文件（view.jsx + parts/* js(x)），递归一层：
// 目前布局是 modules/<mod>/view.jsx 与 modules/<mod>/parts/*，不做无限递归以免扫进构建产物。
function viewFiles(id) {
  const dir = join(MODULES_DIR, id);
  const files = [];
  const view = join(dir, 'view.jsx');
  try { readFileSync(view); files.push(view); } catch { /* 无 view.jsx 的模块（纯 CLI） */ }
  const parts = join(dir, 'parts');
  try {
    if (statSync(parts).isDirectory()) {
      for (const e of readdirSync(parts)) {
        if (/\.(jsx|js)$/.test(e)) files.push(join(parts, e));
      }
    }
  } catch { /* 无 parts/ */ }
  return files;
}

const moduleIds = readdirSync(MODULES_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

// ─── 1. 视图层不得直接 refreshBoot ───────────────────────────────────
// refreshBoot 只重拉 /api/bootstrap。写操作之后如果只调它，视图自己那份
// /api/skills、/api/env 数据不会动 —— 正是「非 F5 不可见」的成因。
test('视图层不直接调用 refreshBoot（写后统一走 store 的 afterWrite）', () => {
  const offenders = [];
  for (const id of moduleIds) {
    for (const file of viewFiles(id)) {
      const src = read(file);
      // 只抓调用形态（refreshBoot(），不抓注释里提到的名字
      if (/\brefreshBoot\s*\(/.test(src)) {
        offenders.push(relative(ROOT, file));
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `这些视图文件仍在直接调 refreshBoot（应改用 afterWrite，见 store.jsx「写后失效」）:\n${offenders.join('\n')}`
  );
});

// ─── 2. store 暴露写后失效的四个入口 ────────────────────────────────
test('store 暴露 dataEpoch / invalidate / afterWrite / dropSel', () => {
  const src = read(STORE);
  assert.match(src, /const \[dataEpoch, setDataEpoch\] = useState\(0\)/, 'store 缺 dataEpoch 状态');
  for (const name of ['invalidate', 'afterWrite', 'dropSel']) {
    assert.match(
      src,
      new RegExp(`const ${name} = useCallback`),
      `store 缺 ${name}——写后失效的统一入口不能少`
    );
  }
  // 必须真的注入 context：只定义不导出等于没写
  for (const name of ['dataEpoch', 'invalidate', 'afterWrite', 'dropSel']) {
    assert.ok(
      new RegExp(`\\b${name}\\b[^\\n]*,(\\s|\\n)`).test(src.split('const value = useMemo')[1] || ''),
      `${name} 没有出现在 StoreCtx 的 value 里`
    );
  }
});

// ─── 3. 取数据的钩子订阅 dataEpoch ──────────────────────────────────
// 列的是「按需拉 /api 数据」的钩子所在文件：少了 dataEpoch 就退回
// 「只有本页 reload 才更新」的老毛病。
const DATA_HOOKS = [
  join('src', 'modules', 'skills', 'parts', 'shared.jsx'),          // useSkillsData
  join('src', 'modules', 'skills', 'parts', 'ProjectPage.jsx'),      // useProjectSkills
  join('src', 'modules', 'skills', 'parts', 'SkillDetail.jsx'),      // 详情 / 安装矩阵
  join('src', 'modules', 'skills', 'parts', 'RemotePage.jsx'),       // 远程订阅清单
  join('src', 'modules', 'env', 'view.jsx'),                         // 环境变量四象限
];

test('取数据的钩子把 dataEpoch 放进 effect 依赖', () => {
  const missing = [];
  for (const rel of DATA_HOOKS) {
    const src = read(join(ROOT, rel));
    // 两种合法写法：从 store 取 dataEpoch，或直接写进 useEffect 依赖数组
    const subscribes = /\bdataEpoch\b/.test(src);
    assert.ok(subscribes, `${rel} 没有订阅 dataEpoch —— 写后不会重拉`);
    // 依赖数组里必须出现它（否则取了不用，等于没订阅）
    if (!/\[\s*[^\]]*dataEpoch[^\]]*\]/.test(src)) missing.push(rel);
  }
  assert.deepEqual(missing, [], `这些钩子的 effect 依赖里没有 dataEpoch:\n${missing.join('\n')}`);
});

// ─── 4. skills 模块：有写操作的文件必须有 afterWrite 收尾 ────────────
// 为什么只圈 skills：它的数据（/api/skills）与 boot 是两套投影，
// 写后只刷其中一套就是这次 bug 的根源。env / worktrees 的数据全部由
// 本页 load() 或 boot 承载，收尾方式不同（env 写后自 load，worktrees 走 afterWrite）。
const WRITE_RE = /method:\s*'(POST|PATCH|PUT|DELETE)'/;

test('skills 模块里发出写请求的文件，写后统一调 afterWrite', () => {
  const problems = [];
  for (const file of viewFiles('skills')) {
    const src = read(file);
    if (!WRITE_RE.test(src)) continue;
    if (!/\bafterWrite\s*\(/.test(src)) problems.push(relative(ROOT, file));
  }
  assert.deepEqual(
    problems,
    [],
    `这些文件发了写请求却没有 afterWrite 收尾（写完界面不会自动刷新）:\n${problems.join('\n')}`
  );
});
