// 看板（主题容器）service：仓库的多项目编排层。
// 一个看板 = 一个主题；成员关系挂 board.repoIds（有序），不在任何看板里的仓库 = 未分组。
// 与 repo 登记的关系：看板只存 id 引用，登记数据（name/desc/path…）的唯一真相在 s.repos——
// 删看板不动登记，删登记要同步摘引用（见 service.js 的 removeRepo）。
// 本文件不含传输层概念（不认识 argv 与 HTTP）。
import { loadStore, mutateStore, newId } from '../../core/store.js';
import { badInput, notFound, conflict } from '../../core/errors.js';

// 卡片投影：面板方格与 CLI 速览共用的最小字段
const card = (r) => ({ id: r.id, name: r.name, desc: r.desc, path: r.path, tags: r.tags || [] });

const cleanText = (v) => String(v || '').trim();

export async function listBoards() {
  const s = await loadStore();
  const inBoard = new Set(s.boards.flatMap((b) => b.repoIds));
  const reposOf = (ids) =>
    ids.map((id) => s.repos.find((r) => r.id === id)).filter(Boolean).map(card);
  return {
    boards: s.boards.map((b) => ({ id: b.id, name: b.name, desc: b.desc, repos: reposOf(b.repoIds) })),
    unassigned: s.repos.filter((r) => !inBoard.has(r.id)).map(card),
  };
}

export async function getBoard(id) {
  const s = await loadStore();
  const b = s.boards.find((x) => x.id === id);
  if (!b) throw notFound('看板不存在: ' + id);
  const repos = b.repoIds.map((rid) => s.repos.find((r) => r.id === rid)).filter(Boolean).map(card);
  return { id: b.id, name: b.name, desc: b.desc, repos };
}

export async function createBoard({ name, desc } = {}) {
  const nm = cleanText(name);
  if (!nm) throw badInput('看板名称不能为空');
  return mutateStore((s) => {
    if (s.boards.some((b) => b.name === nm)) throw conflict('同名看板已存在: ' + nm);
    const b = { id: newId('b'), name: nm, desc: cleanText(desc), createdAt: new Date().toISOString(), repoIds: [] };
    s.boards.push(b);
    return { id: b.id, name: b.name, desc: b.desc, repos: [] };
  });
}

export async function updateBoard(id, { name, desc } = {}) {
  const nm = name === undefined ? undefined : cleanText(name);
  if (nm !== undefined && !nm) throw badInput('看板名称不能为空');
  return mutateStore((s) => {
    const b = s.boards.find((x) => x.id === id);
    if (!b) throw notFound('看板不存在: ' + id);
    if (nm !== undefined && s.boards.some((x) => x.id !== id && x.name === nm)) {
      throw conflict('同名看板已存在: ' + nm);
    }
    if (nm !== undefined) b.name = nm;
    if (desc !== undefined) b.desc = cleanText(desc);
    return { id: b.id, name: b.name, desc: b.desc };
  });
}

// 删看板 = 摘容器：repoIds 随之消失，里面的仓库自动回未分组（登记不动）
export async function removeBoard(id) {
  return mutateStore((s) => {
    const at = s.boards.findIndex((x) => x.id === id);
    if (at < 0) throw notFound('看板不存在: ' + id);
    const [b] = s.boards.splice(at, 1);
    return { removed: b.name, released: b.repoIds.length };
  });
}

// 移动卡片：board = 目标看板 id；board 为空串/null = 移回未分组；
// before = 插到某张卡片之前（缺省追加到末尾）。
export async function assignRepo({ id, board, before } = {}) {
  if (!id) throw badInput('缺少仓库 id');
  return mutateStore((s) => {
    const repo = s.repos.find((r) => r.id === id);
    if (!repo) throw notFound('repo 不存在: ' + id);
    let target = null;
    if (board) {
      target = s.boards.find((b) => b.id === board);
      if (!target) throw notFound('看板不存在: ' + board);
    }
    // 先从所有看板摘出（拖拽是移动不是复制）
    for (const b of s.boards) b.repoIds = b.repoIds.filter((x) => x !== id);
    if (target) {
      const at = before && before !== id ? target.repoIds.indexOf(before) : -1;
      if (at >= 0) target.repoIds.splice(at, 0, id);
      else target.repoIds.push(id);
    }
    return { id, board: target ? target.id : '', name: repo.name };
  });
}

// 导入：一段 JSON = 一批主题。{boards:[{name, desc?, repos:[{path|name, desc?}]}]}
// 条目按 path（大小写不敏感）或名称匹配**已登记**仓库——导入不硬造登记，
// 匹配不上的如实报告（数量与清单）。同名看板 = 合并（追加匹配到的仓库）。
export async function importBoards({ json } = {}) {
  let data;
  try {
    data = typeof json === 'string' ? JSON.parse(json) : json;
  } catch {
    throw badInput('看板 JSON 解析失败（请粘整个导出对象）');
  }
  const incoming = Array.isArray(data?.boards) ? data.boards : null;
  if (!incoming || !incoming.length) throw badInput('JSON 里没有 boards 数组');
  return mutateStore((s) => {
    // path 匹配把分隔符归一（Windows 登记是反斜杠，导入 JSON 里两种写法都常见）
    const normPath = (v) => String(v || '').toLowerCase().replace(/\\/g, '/');
    const byPath = new Map(s.repos.map((r) => [normPath(r.path), r.id]));
    const byName = new Map(s.repos.map((r) => [r.name, r.id]));
    let created = 0;
    let merged = 0;
    let matched = 0;
    const unmatched = [];
    for (const raw of incoming) {
      const nm = cleanText(raw?.name);
      if (!nm) continue;
      let b = s.boards.find((x) => x.name === nm);
      if (!b) {
        b = { id: newId('b'), name: nm, desc: cleanText(raw.desc), createdAt: new Date().toISOString(), repoIds: [] };
        s.boards.push(b);
        created += 1;
      } else {
        merged += 1;
      }
      for (const entry of Array.isArray(raw.repos) ? raw.repos : []) {
        if (typeof entry === 'string') entry = { name: entry };
        const id =
          (entry.path && byPath.get(normPath(entry.path))) ||
          (entry.name && byName.get(String(entry.name).trim())) ||
          null;
        if (!id) {
          unmatched.push({ board: nm, entry: entry.path || entry.name || '(空)' });
          continue;
        }
        if (!b.repoIds.includes(id)) {
          b.repoIds.push(id);
          matched += 1;
        }
      }
    }
    return { created, merged, matched, unmatched };
  });
}

// 导出：看板 + 仓库的 path/name/desc（可回灌给 import 的同一结构）
export async function exportBoards() {
  const s = await loadStore();
  return {
    version: 1,
    boards: s.boards.map((b) => ({
      name: b.name,
      desc: b.desc,
      repos: b.repoIds
        .map((id) => s.repos.find((r) => r.id === id))
        .filter(Boolean)
        .map((r) => ({ path: r.path, name: r.name, desc: r.desc })),
    })),
  };
}
