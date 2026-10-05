// 扩展文件：盘点 / 登记 / 发现 / 改 / 删。
// .gitignore 里那些不会被 worktree 带走的文件，按全路径登记 + 指纹跟踪。
import { isAbsolute, join, relative, resolve } from 'node:path';
import fsp from 'node:fs/promises';
import { newId } from '../../../core/store.js';
import { badInput, blocked, conflict, notFound } from '../../../core/errors.js';
import { checkIgnore, git } from '../../../core/git.js';
import { concreteEntries, parseGitignore } from '../../../core/gitignore.js';
import { getBucket, patchBucket, statOrNull, fingerprint } from './bucket.js';
import { inspectAt } from './inspect.js';
import { listWorktrees, matchWorktree } from './list.js';

// 默认评估目标：显式 --target > 当前所在工作树 > 主仓库
export async function listExtensions(opts = {}) {
  const bucket = await getBucket();
  if (!bucket.main.git) {
    return { target: bucket.main.path, isMain: true, items: [], summary: { registered: 0 } };
  }
  let target = bucket.main.path;
  if (opts.target) {
    const { worktrees } = await listWorktrees();
    const wt = matchWorktree(worktrees, opts.target);
    if (!wt) throw notFound('工作树不存在: ' + opts.target);
    target = wt.path;
  } else if (bucket.main.linked) {
    target = bucket.main.top;
  }
  return inspectAt(target, bucket);
}

export async function addExtension(input) {
  const abs0 = String(input.abspath ?? input.abs ?? input.path ?? '').trim();
  if (!abs0) throw badInput('用法: nx-rh wt ext add <绝对路径> [--label L] [--force] —— 缺少路径');
  const bucket = await getBucket();
  if (!bucket.main.git) throw blocked('当前目录不是 git 仓库: ' + bucket.main.path);

  const abs = resolve(abs0);
  const st = await statOrNull(abs);
  if (!st) throw notFound('文件不存在: ' + abs);

  const rel = relative(bucket.main.path, abs).replace(/\\/g, '/');
  const outside = rel.startsWith('..');

  if (!input.force) {
    const code = checkIgnore(bucket.main.path, abs);
    if (code === 1) {
      throw blocked(
        `文件未被 git 忽略（被跟踪或不在 .gitignore）: ${outside ? abs : rel}；扩展文件用于登记被忽略文件，确认登记加 --force`
      );
    }
  }

  const fp = await fingerprint(abs, st);
  const record = {
    id: newId('x'),
    absPath: abs,
    relPath: rel,
    outside,
    label: String(input.label || '').trim(),
    kind: st.isDirectory() ? 'dir' : 'file',
    fingerprint: fp,
    size: st.size,
    mtime: st.mtime.toISOString(),
    registeredAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await patchBucket(bucket.main.path, (b) => {
    if (b.extensions.some((e) => e.absPath.toLowerCase() === abs.toLowerCase())) {
      throw conflict('扩展文件已登记: ' + abs);
    }
    b.extensions.push(record);
  });
  return { status: 'ok', ...record };
}

// 发现被忽略文件：.gitignore 具体条目 + git ls-files（目录折叠，避免 node_modules 爆炸）。
// 默认只给建议（零副作用），--apply 才登记。
export async function discoverExtensions(input = {}) {
  const apply = input.apply === true;
  const bucket = await getBucket();
  if (!bucket.main.git) throw blocked('当前目录不是 git 仓库: ' + bucket.main.path);

  const proposals = new Map();
  // 工作树根（若在主仓库内）绝不能被当成扩展文件——它不是要登记的参考项
  const rootRel0 = relative(bucket.main.path, bucket.config.worktreeRoot);
  const wtRootRel =
    !isAbsolute(rootRel0) && !rootRel0.startsWith('..')
      ? rootRel0.replace(/\\/g, '/').replace(/\/+$/, '')
      : null;

  const addP = (p0, source) => {
    const p = p0.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
    if (!p || p === '.git') return;
    if (wtRootRel && (p === wtRootRel || p.startsWith(wtRootRel + '/'))) return;
    if (!proposals.has(p)) proposals.set(p, { rel: p, source });
  };

  let giText = '';
  try {
    giText = await fsp.readFile(join(bucket.main.path, '.gitignore'), 'utf8');
  } catch {
    giText = '';
  }
  for (const e of concreteEntries(parseGitignore(giText))) {
    // 防御：只收解析后仍落在主仓库内的条目（忽略跨盘符/含 .. 的异常规则）
    const rel = relative(bucket.main.path, join(bucket.main.path, e.path));
    if (!rel.startsWith('..') && !isAbsolute(rel)) addP(e.path, 'gitignore');
  }

  const ls = git(
    bucket.main.path,
    ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory'],
    { allowFail: true }
  );
  if (ls.code === 0) {
    for (const line of ls.stdout.split(/\r?\n/)) {
      const p = line.trim();
      if (p) addP(p, 'git');
    }
  }

  const registered = new Set(bucket.extensions.map((e) => e.relPath));
  const items = [];
  for (const p of [...proposals.values()].slice(0, 1000)) {
    const abs = join(bucket.main.path, p.rel);
    const st = await statOrNull(abs);
    items.push({
      rel: p.rel,
      source: p.source,
      exists: !!st,
      kind: st ? (st.isDirectory() ? 'dir' : 'file') : null,
      alreadyRegistered: registered.has(p.rel),
    });
  }

  const registrable = items.filter((i) => i.exists && !i.alreadyRegistered);
  const added = [];
  if (apply) {
    for (const i of registrable) {
      try {
        added.push(await addExtension({ abspath: join(bucket.main.path, i.rel), force: true }));
      } catch {
        /* 重复等，跳过 */
      }
    }
  }

  return {
    apply,
    proposals: items,
    summary: {
      found: items.length,
      registrable: registrable.length,
      alreadyRegistered: items.filter((i) => i.alreadyRegistered).length,
      added: added.length,
    },
    added,
  };
}

export function matchExtension(list, ref) {
  const r = String(ref || '').trim();
  let target;
  try {
    target = resolve(r);
  } catch {
    target = r;
  }
  return (
    list.find(
      (e) =>
        e.id === r ||
        e.relPath === r ||
        e.absPath.toLowerCase() === target.toLowerCase()
    ) || null
  );
}

export async function getExtension(ref) {
  const bucket = await getBucket();
  const rec = matchExtension(bucket.extensions, ref);
  if (!rec) throw notFound('扩展文件不存在: ' + ref);
  const inspected = await inspectAt(bucket.main.path, bucket);
  return { ...rec, state: inspected.items.find((i) => i.id === rec.id) };
}

export async function updateExtension(ref, patch) {
  const bucket = await getBucket();
  return patchBucket(bucket.main.path, (b) => {
    const rec = matchExtension(b.extensions, ref);
    if (!rec) throw notFound('扩展文件不存在: ' + ref);
    if (patch.label !== undefined) rec.label = String(patch.label).trim();
    rec.updatedAt = new Date().toISOString();
    return rec;
  });
}

export async function removeExtension(ref) {
  const bucket = await getBucket();
  return patchBucket(bucket.main.path, (b) => {
    const idx = b.extensions.findIndex((e) => matchExtension([e], ref));
    if (idx < 0) throw notFound('扩展文件不存在: ' + ref);
    const [removed] = b.extensions.splice(idx, 1);
    return { status: 'ok', removed: removed.relPath, diskUntouched: true };
  });
}
