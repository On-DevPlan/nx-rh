// 一次性排查脚本：比对两版每条 action 声明的「全部 CLI 路径（含别名）」。
// help --json 只暴露主路径，别名不在里面 —— 而别名也是对外契约
// （`bundled list` / `skill scan` / `skill adapt` 这些老名字必须照样能敲）。
//
// 用法：node prev/nx-rh-rs/tests/_alias-diff.mjs   （在仓库根跑）
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SRC = 'prev/nx-rh-rs/src';

function rsCliPaths() {
  const files = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (f.endsWith('.rs')) files.push(p);
    }
  })(SRC);

  const out = {};
  const paths = (raw) => {
    const nested = [...raw.matchAll(/vec!\[([^\]]*)\]/g)].map((x) =>
      [...x[1].matchAll(/"([^"]*)"/g)].map((y) => y[1])
    );
    return nested.length ? nested : [[...raw.matchAll(/"([^"]*)"/g)].map((y) => y[1])];
  };
  for (const f of files) {
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
    // 同一个 Action 的 id 与 cli 相邻（id 在前），逐行记住当前 id 即可。
    let curId = null;
    for (const line of lines) {
      const idm = line.match(/id:\s*"([^"]+)"/);
      if (idm) curId = idm[1];
      // 两种声明形态：
      //   Action { id: "x", cli: vec![...] }        —— 手写结构体
      //   wt_action!("x", vec![...], ...)           —— 宏（cli 是第 2 个位置参数）
      const macro = line.match(/wt_action!\("([^"]+)",\s*(vec!\[[\s\S]*?\]\])\s*,/);
      if (macro) {
        out[macro[1]] = paths(macro[2]);
        curId = macro[1];
        continue;
      }
      const cli = line.match(/cli:\s*vec!\[(.*)\],\s*$/);
      if (cli && curId) out[curId] = paths(cli[1]);
    }
  }
  return out;
}

const { ACTIONS } = await import(pathToFileURL(path.resolve('src/runtime/registry.js')).href);
const js = {};
for (const a of ACTIONS) js[a.id] = Array.isArray(a.cli[0]) ? a.cli : [a.cli];

const rs = rsCliPaths();
let bad = 0;
for (const [id, paths] of Object.entries(js)) {
  const r = rs[id];
  if (!r) {
    console.log(`  缺 action: ${id}`);
    bad++;
    continue;
  }
  const A = JSON.stringify(paths);
  const B = JSON.stringify(r);
  if (A !== B) {
    console.log(`  别名不一致 ${id}\n    js ${A}\n    rs ${B}`);
    bad++;
  }
}
for (const id of Object.keys(rs)) {
  // serve / help / version 在 JS 侧是 runtime/cli.js 里的平台命令，不在 modules 里，
  // Rust 侧为了统一形状也放进了 registry —— 这 3 个属于已知差异。
  if (['serve', 'help', 'version'].includes(id)) continue;
  if (!js[id]) {
    console.log(`  rs 多出: ${id}`);
    bad++;
  }
}
console.log(bad === 0 ? '别名全部一致' : `${bad} 处不一致`);
process.exit(bad === 0 ? 0 : 1);
