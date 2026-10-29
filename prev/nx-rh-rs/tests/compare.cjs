// 对齐检查：两版 CLI 的 action 表 / 路由表 / 若干只读命令的输出形状逐条比对。
// 用法: node .tmp-cmp/compare.js <jsBin> <rsBin>
const { execFileSync } = require('child_process');
const fs = require('fs');

const JS = process.argv[2] || 'node';
const ROOT = process.env.NX_RH_ROOT || '../..';
const RS_DIR = process.env.NX_RS_DIR || __dirname + '/..';
// 二进制名带平台后缀：Windows 是 .exe，POSIX 没有
const RS_EXT = process.platform === 'win32' ? '.exe' : '';
const RS = process.argv[3] || RS_DIR + '/target/release/nx-rh-rs' + RS_EXT;

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
  ['wt', 'config'],
  ['wt', 'list'],
  ['env', 'status'],
];
for (const cmd of READ_CMDS) {
  const j = jsRun(['bin/cli.mjs', ...cmd, '--json']);
  const r = rsRun([...cmd, '--json']);
  let ok = j.code === r.code;
  let detail = `exit JS ${j.code} / RS ${r.code}`;
  if (ok && j.out.trim() && r.out.trim()) {
    try {
      const jsShape = JSON.stringify(shape(JSON.parse(j.out)));
      const rsShape = JSON.stringify(shape(JSON.parse(r.out)));
      ok = jsShape === rsShape;
      if (!ok) detail = '字段形状不同';
    } catch (e) {
      ok = false;
      detail = 'JSON 解析失败: ' + e.message;
    }
  }
  check(`${cmd.join(' ')} --json 形状一致`, ok, detail);
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
