// 模块内前后端共用的纯函数与常量。禁 node:*——本文件会被视图层打进浏览器包。
//
// SCOPE_MARK：user/project 的中文短标（CLI 渲染与面板标签共用一份，
// 前端以 `SCOPE_MARK as SCOPE_SHORT` 引入）。
export const SCOPE_MARK = { user: '用户', project: '项目' };

export const pathSegs = (p) => String(p || '').replace(/\\/g, '/').split('/').filter(Boolean);
export const lastSeg = (p) => pathSegs(p).slice(-1)[0] || String(p || '');

// 订阅源的展示名：多源时取「最短能唯一区分」的尾部段。
//
// 从前是「取末两段」：`D:\a_other\md\sl\skills` → `sl/skills`。能区分，但每一行都拖着
// 那个毫无信息量的 `skills` 尾巴；而订阅源目录**几乎都叫 skills**，所以这段尾巴在
// 整个列表里重复出现几十次。多源列表里本来就该只留「能区分」的那一小段。
//
// 做法：先剥掉**所有源共有**的尾部段（通常就是 `skills`），再取「最短能唯一区分」的尾部；
// 父目录也重名时继续往上退。all = 全部来源路径（不传就只能退回末段）。
export function sourceLabel(p, all) {
  if (!p) return '';
  const uniq = [...new Set([...(all || []), p].filter(Boolean))];
  if (uniq.length < 2) return lastSeg(p);

  const all2 = uniq.map(pathSegs);
  let common = 0;
  const minLen = Math.min(...all2.map((s) => s.length));
  while (common + 1 < minLen) {
    const i = common + 1;
    const tail = all2[0][all2[0].length - i].toLowerCase();
    if (all2.every((s) => s[s.length - i].toLowerCase() === tail)) common += 1;
    else break;
  }
  const pools = all2.map((s) => (s.length > common ? s.slice(0, s.length - common) : s));

  const idx = uniq.indexOf(p);
  const own = pools[idx];
  let n = 1;
  while (n < own.length) {
    const tail = own.slice(-n).join('/').toLowerCase();
    if (!pools.some((o, j) => j !== idx && o.slice(-n).join('/').toLowerCase() === tail)) break;
    n += 1;
  }
  return own.slice(-n).join('/') || lastSeg(p);
}

// 把一组来源渲染成可区分的短名串。来源元素可以是路径字符串，也可以是 {path} / {source}
export function sourceLabels(items, sep = ' / ') {
  const all = (items || []).map((x) => (typeof x === 'string' ? x : x.path || x.source));
  return all.map((p) => sourceLabel(p, all)).join(sep);
}
