// 对齐检查：两版 CLI 的 action 表 / 路由表 / usage 串 / help 版面 / 只读命令输出逐条比对。
//
// 用法（在 prev/nx-rh-rs 下）：
//   node tests/compare.cjs node ./target/release/nx-rh-rs.exe
//
// 第一个参数是 JS 版的启动器（默认 node，会跑 <仓库根>/bin/cli.mjs），
// 第二个参数是 Rust 版二进制（默认 target/release/nx-rh-rs[.exe]）。
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const JS = process.argv[2] || 'node';
const ROOT = process.env.NX_RH_ROOT || '../..';
const RS_DIR = process.env.NX_RS_DIR || __dirname + '/..';
// 二进制名带平台后缀：Windows 是 .exe，POSIX 没有
const RS_EXT = process.platform === 'win32' ? '.exe' : '';
const RS = process.argv[3] || RS_DIR + '/target/release/nx-rh-rs' + RS_EXT;

// ── 两版读同一份 store ─────────────────────────────────────────────────
//
// 两版的配置目录本来就不同（~/.nx-rh vs ~/.nx-rh-rs），这是刻意设计——
// 但「比对」时它会让 recents / setting get / hub sources 天然一边有数据、
// 一边是空数组，比出来的差异全是配置不同造成的噪声，不是实现不同。
//
// 所以这里把两版都指向同一份临时 store：内容优先取 JS 版真实 store
// （有数据才能压出字段形状差异），取不到就写一份最小种子。
// 不写回任何真实目录 —— 比对过程不动用户数据。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-rh-cmp-'));
const sharedStore = path.join(tmpDir, 'store.json');
const realStore = path.join(os.homedir(), '.nx-rh', 'store.json');
if (fs.existsSync(realStore)) {
  fs.copyFileSync(realStore, sharedStore);
} else {
  fs.writeFileSync(
    sharedStore,
    JSON.stringify(
      {
        settings: {
          skillHubPath: '',
          skillSyncMode: 'symlink',
          platforms: ['claude-code'],
          defaultPlatform: 'claude-code',
          skillHubSources: [],
          skillProjectCandidates: [],
        },
        recents: [],
      },
      null,
      2
    )
  );
}
const STORE = ['--store', sharedStore];

function run(cmd, args, opts = {}) {
  try {
    return { code: 0, out: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }) };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') };
  }
}
// JS 版在仓库根跑（它读自己 package.json）；Rust 版在 crate 目录跑
const jsRun = (args) => run(JS, args, { cwd: ROOT });
const rsRun = (args) => run(RS, args, { cwd: ROOT });

let failures = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? '  → ' + detail : ''}`);
  }
}

// 文本比对失败时汇报「第一个不同的行」，别让人去翻几千行 help。
function firstDiff(a, b) {
  const la = a.split('\n');
  const lb = b.split('\n');
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] !== lb[i]) {
      return `第 ${i + 1} 行起不同\n    JS: ${JSON.stringify(la[i] ?? '<缺>')}\n    RS: ${JSON.stringify(lb[i] ?? '<缺>')}`;
    }
  }
  return '内容相同';
}

// ---- 1. action 表（help --json）----
const jsHelp = JSON.parse(jsRun(['bin/cli.mjs', 'help', '--json']).out);
const rsHelp = JSON.parse(rsRun(['help', '--json']).out);
const key = (e) => e.command.replace(/^nx-rh(-rs)? /, '');
const jsM = new Map(jsHelp.map((e) => [key(e), e]));
const rsM = new Map(rsHelp.map((e) => [key(e), e]));
const missing = [...jsM.keys()].filter((k) => !rsM.has(k));
const extra = [...rsM.keys()].filter((k) => !jsM.has(k));
check('action 表条数一致', jsHelp.length === rsHelp.length, `JS ${jsHelp.length} vs RS ${rsHelp.length}`);
check('无缺失 action', missing.length === 0, missing.join(', '));
check('无多余 action', extra.length === 0, extra.join(', '));

// ---- 2. 路由表 ----
const jsR = jsHelp.filter((e) => e.http).map((e) => e.http.method + ' ' + e.http.path).sort();
const rsR = rsHelp.filter((e) => e.http).map((e) => e.http.method + ' ' + e.http.path).sort();
check('HTTP 路由条数一致', jsR.length === rsR.length, `JS ${jsR.length} vs RS ${rsR.length}`);
check(
  '路由集合一致',
  jsR.filter((r) => !rsR.includes(r)).length === 0 && rsR.filter((r) => !jsR.includes(r)).length === 0,
  'only JS: ' + jsR.filter((r) => !rsR.includes(r)).join(';') + ' | only RS: ' + rsR.filter((r) => !jsR.includes(r)).join(';')
);

// ---- 3. 只读命令的 --json 形状（字段集合一致，值可能因路径/时间而异）----
function shape(v, depth = 0) {
  if (Array.isArray(v)) return v.length ? [shape(v[0], depth + 1)] : [];
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = shape(v[k], depth + 1);
    return out;
  }
  return typeof v;
}
const READ_CMDS = [
  ['bootstrap'],
  ['health'],
  ['recents'],
  ['setting', 'get'],
  ['skill', 'hub', 'sources'],
  ['skill', 'hub', 'adapters'],
  ['skill', 'list'],
  ['skill', 'groups'],
  ['bundled', 'list'],
  ['bundled', 'groups'],
  ['wt', 'config'],
  ['wt', 'list'],
  ['wt', 'ext', 'list'],
  ['env', 'status'],
  ['env', 'list'],
  ['env', 'path', 'list'],
  ['env', 'snapshot', 'list'],
];
// 这几条读的是**各自的应用目录**（env 快照落在 <appDir>/env_snapshots），
// 两版目录本来就不同，内容不可能一样。只要求：同类型、同条数语义的 JSON。
const DATA_TOLERANT = new Set(['env snapshot list']);
for (const cmd of READ_CMDS) {
  const name = cmd.join(' ');
  const j = jsRun(['bin/cli.mjs', ...cmd, '--json', ...STORE]);
  const r = rsRun([...cmd, '--json', ...STORE]);
  let ok = j.code === r.code;
  let detail = `exit JS ${j.code} / RS ${r.code}`;
  if (ok && j.out.trim() && r.out.trim()) {
    try {
      const a = JSON.parse(j.out);
      const b = JSON.parse(r.out);
      if (DATA_TOLERANT.has(name)) {
        ok = Array.isArray(a) === Array.isArray(b);
        if (!ok) detail = '一边是数组一边不是';
      } else {
        const jsShape = JSON.stringify(shape(a));
        const rsShape = JSON.stringify(shape(b));
        ok = jsShape === rsShape;
        if (!ok) detail = `字段形状不同\n    JS: ${jsShape.slice(0, 300)}\n    RS: ${rsShape.slice(0, 300)}`;
      }
    } catch (e) {
      ok = false;
      detail = 'JSON 解析失败: ' + e.message;
    }
  }
  check(`${name} --json 形状一致`, ok, detail);
}

// 文本比对前先归一化「刻意不同」的三处：命令名、配置目录、面板端口。
// 除了这三处，两版的文案必须逐字相同 —— 这些文本是 agent 的契约。
const norm = (s) =>
  s
    .replace(/nx-rh-rs/g, 'nx-rh') // 命令名（.nx-rh-rs 里的也一并归一）
    .replace(/7801/g, '7800') // 面板端口（Rust 版 +1，方便同时启动对比）
    .replace(/v\d+\.\d+\.\d+/g, 'v<ver>') // 版本号各自独立推进
    .replace(/\r/g, '');

// ---- 3b. 用法串：从 action 表反推的 usage 必须逐字一致（只差命令名）----
{
  const jsU = new Map(jsHelp.map((e) => [key(e), norm(e.usage || '')]));
  const rsU = new Map(rsHelp.map((e) => [key(e), norm(e.usage || '')]));
  const bad = [...jsU.keys()].filter((k) => rsU.has(k) && jsU.get(k) !== rsU.get(k));
  check(
    'usage 串逐条一致',
    bad.length === 0,
    bad.slice(0, 5).map((k) => `${k}: 「${jsU.get(k)}」 vs 「${rsU.get(k)}」`).join(' | ')
  );
}

// ---- 3c. help 人读文案（除命令名/端口外必须逐字一致）----
//
// 表格列宽是按「最长 usage 的字符数」算的，而 Rust 版的命令名比 JS 长 3 个字符，
// 归一化之后每行的填充空格必然多 3 个 —— 这是 padding 的算术结果，不是排版错误。
// 所以这里把 2 个以上空格压成一个分隔符再比：内容、顺序、分组仍逐字校验，
// 只有「列对不对齐」不比（那条由各域自己的列表输出用例盯着）。
const helpNorm = (s) =>
  s
    .split('\n')
    .map((l) => l.replace(/\s{2,}/g, '\u0001').replace(/\u0001+$/, ''))
    .join('\n');
{
  const j = helpNorm(norm(jsRun(['bin/cli.mjs', 'help']).out));
  const r = helpNorm(norm(rsRun(['help']).out));
  check('help 人读文案一致', j === r, j === r ? '' : firstDiff(j, r.replace(/\u0001/g, '|')));
}

// ---- 3d. 每个功能域的人读列表输出（除命令名/端口外一致）----
const RENDER_CMDS = [
  ['skill', 'list'],
  ['skill', 'hub', 'adapters'],
  ['bundled', 'list'],
  ['wt', 'config'],
  ['env', 'status'],
  ['env', 'list'],
];
for (const cmd of RENDER_CMDS) {
  const j = norm(jsRun(['bin/cli.mjs', ...cmd, ...STORE]).out);
  const r = norm(rsRun([...cmd, ...STORE]).out);
  check(`${cmd.join(' ')} 人读输出一致`, j === r, j === r ? '' : firstDiff(j, r));
}

// ---- 4. 错误契约（缺参数 → 用法: 前缀 + exit 1）----
const jErr = jsRun(['bin/cli.mjs', 'skill', 'hub', 'show']);
const rErr = rsRun(['skill', 'hub', 'show']);
check(
  '缺参数时报错含「用法:」且 exit 1',
  jErr.code === 1 && rErr.code === 1 && rErr.out.includes('用法:'),
  `JS exit ${jErr.code} / RS exit ${rErr.code}; RS out: ${rErr.out.slice(0, 120)}`
);

// ---- 5. 未知 flag 报错 ----
const jBad = jsRun(['bin/cli.mjs', 'health', '--fiile', 'x']);
const rBad = rsRun(['health', '--fiile', 'x']);
check(
  '未知 flag 被拒',
  jBad.code === 1 && rBad.code === 1 && rBad.out.includes('未知参数'),
  `RS out: ${rBad.out.slice(0, 120)}`
);

// ---- 6. 未知命令 ----
const jUnknown = jsRun(['bin/cli.mjs', 'no-such-cmd']);
const rUnknown = rsRun(['no-such-cmd']);
check(
  '未知命令 exit 1',
  jUnknown.code === 1 && rUnknown.code === 1,
  `JS ${jUnknown.code} / RS ${rUnknown.code}`
);

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项不通过`);
process.exit(failures === 0 ? 0 : 1);
