// 基础冲突算法：LCS 行级 diff + 统一格式输出 + diff3-lite 三方合并。
// 用途：
// - skill 同步时两侧文本差异的展示与选择（Web 弹窗 / CLI 文本）
// - /api/util/merge 与 CLI skill merge 暴露 merge3 原语，供 agent 编排
// git 仓库自身的冲突由 git 的 3-way 机制处理（见 core/git.js gitResolve）。

function lcsDp(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp;
}

// 行级 diff：[{t:'='|'-'|'+', bi, oi, text}]，bi/oi 为两侧行号
export function diffOps(aText, bText) {
  const a = String(aText ?? '').split('\n');
  const b = String(bText ?? '').split('\n');
  const dp = lcsDp(a, b);
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ t: '=', bi: i, oi: j, text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ t: '-', bi: i, oi: j, text: a[i] });
      i++;
    } else {
      ops.push({ t: '+', bi: i, oi: j, text: b[j] });
      j++;
    }
  }
  while (i < a.length) {
    ops.push({ t: '-', bi: i, oi: j, text: a[i++] });
  }
  while (j < b.length) {
    ops.push({ t: '+', bi: i, oi: j, text: b[j++] });
  }
  return ops;
}

export function diffLines(aText, bText) {
  return diffOps(aText, bText).map((o) => ({ t: o.t, text: o.text }));
}

// 统一 diff 文本（带近似行号定位）
export function unifiedDiff(aText, bText, aName = 'a', bName = 'b') {
  const ops = diffOps(aText, bText);
  const lines = [`--- ${aName}`, `+++ ${bName}`];
  let ai = 0;
  let bi = 0;
  let idx = 0;
  while (idx < ops.length) {
    if (ops[idx].t === '=') {
      ai++;
      bi++;
      idx++;
      continue;
    }
    const startAi = ai + 1;
    const startBi = bi + 1;
    let end = idx;
    let del = 0;
    let add = 0;
    while (end < ops.length && ops[end].t !== '=') {
      if (ops[end].t === '-') {
        del++;
        ai++;
      } else {
        add++;
        bi++;
      }
      end++;
    }
    lines.push(`@@ -${startAi},${del} +${startBi},${add} @@`);
    for (let k = Math.max(0, idx - 2); k < idx; k++) {
      if (ops[k].t === '=') lines.push('  ' + ops[k].text);
    }
    for (let k = idx; k < end; k++) {
      lines.push((ops[k].t === '-' ? '- ' : '+ ') + ops[k].text);
    }
    for (let k = end; k < Math.min(ops.length, end + 2); k++) {
      if (ops[k].t !== '=') break;
      lines.push('  ' + ops[k].text);
    }
    idx = end;
  }
  return lines.join('\n');
}

// diff3-lite 三方合并：
// 仅单侧变更的区域自动采用该侧；两侧同时变更且结果相同则取其一；
// 两侧同时变更且不同 -> 输出 <<<<<<< / ======= / >>>>>>> 冲突块。
export function merge3(baseText, aText, bText, labels = { a: 'ours', b: 'theirs' }) {
  const base = String(baseText ?? '').split('\n');
  const a = String(aText ?? '').split('\n');
  const b = String(bText ?? '').split('\n');

  const hA = hunksAgainst(base, diffOps(baseText, aText));
  const hB = hunksAgainst(base, diffOps(baseText, bText));

  const all = [
    ...hA.map((h) => ({ ...h, side: 'a' })),
    ...hB.map((h) => ({ ...h, side: 'b' })),
  ].sort((x, y) => x.start - y.start);

  // 聚类：重叠（半开区间 [start,end) 相交）的变更合并为一个决策单元；
  // 相邻但不重叠的 hunk 保持独立，才能正确自动合入两侧的非冲突改动
  const clusters = [];
  for (const h of all) {
    const last = clusters[clusters.length - 1];
    if (last && h.start < last.end) {
      last.end = Math.max(last.end, h.end);
      last.items.push(h);
    } else {
      clusters.push({ start: h.start, end: h.end, items: [h] });
    }
  }

  const out = [];
  const conflicts = [];
  let pos = 0;
  for (const c of clusters) {
    out.push(...base.slice(pos, c.start));
    const repA = applySide(base, c, c.items.filter((i) => i.side === 'a'));
    const repB = applySide(base, c, c.items.filter((i) => i.side === 'b'));
    const hasA = c.items.some((i) => i.side === 'a');
    const hasB = c.items.some((i) => i.side === 'b');
    if (!hasB) out.push(...repA);
    else if (!hasA) out.push(...repB);
    else if (JSON.stringify(repA) === JSON.stringify(repB)) out.push(...repA);
    else {
      conflicts.push({ start: c.start, end: c.end });
      out.push(`<<<<<<< ${labels.a}`, ...repA, '=======', ...repB, `>>>>>>> ${labels.b}`);
    }
    pos = c.end;
  }
  out.push(...base.slice(pos));
  return { merged: out.join('\n'), conflicts };
}

// 将一侧的若干 hunk 应用到 base 的 [cluster.start, cluster.end) 区间
function applySide(base, cluster, items) {
  if (!items.length) return base.slice(cluster.start, cluster.end);
  const out = [];
  let i = cluster.start;
  for (const h of [...items].sort((x, y) => x.start - y.start)) {
    out.push(...base.slice(i, h.start));
    out.push(...h.replacement);
    i = Math.max(i, h.end);
  }
  out.push(...base.slice(i, cluster.end));
  return out;
}

// 把 diff ops 折叠为 base 坐标上的替换块 {start, end, replacement}
function hunksAgainst(base, ops) {
  const hunks = [];
  let cur = null;
  for (const op of ops) {
    if (op.t === '=') {
      cur = null;
      continue;
    }
    if (!cur) {
      cur = { start: op.bi, end: op.bi, replacement: [] };
      hunks.push(cur);
    }
    if (op.t === '-') cur.end = op.bi + 1;
    else cur.replacement.push(op.text);
  }
  return hunks;
}
