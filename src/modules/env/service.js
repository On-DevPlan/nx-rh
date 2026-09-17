// 环境变量业务层：快照 / dry-run / PATH 条目 / 遮蔽分析。
//
// 危险逻辑全部落在这里，而不是散在各 action 里——这样「写前自动快照」是每条写路径的
// **必经之路**，而不是每个 action 各自记得调。action 只负责参数整形与渲染。
//
// 另一半职责是**把纯逻辑从 I/O 里剥出来**：PATH 切分、类型决策、遮蔽分析都不碰注册表，
// 因此能在 CI（ubuntu-latest）上完整单测。真正的平台调用只有 core/envvars.js 一处。
import fsp from 'node:fs/promises';
import { join } from 'node:path';
import { envSnapshotDir } from '../../core/paths.js';
import { unifiedDiff } from '../../core/diff.js';
import { badInput, notFound, blocked } from '../../core/errors.js';
import * as driver from '../../core/envvars.js';

export const { SCOPES, KINDS } = driver;

// ─── 纯逻辑：PATH 条目 ────────────────────────────────────────────────

const PATH_NAME = 'path';

export function isPathName(name) {
  return String(name).toLowerCase() === PATH_NAME;
}

// Windows PATH 的分隔符是分号。空段（`;;`、尾随 `;`）是噪声，丢弃；
// **非空条目原样保留**——修剪内容会静默改掉用户的 PATH（尾随空格、带引号的路径
// 都是合法写法），而 join(split(v)) !== v 这件事必须让用户从 dry-run 的 diff 里看到。
export function splitPathEntries(value) {
  return String(value ?? '')
    .split(';')
    .filter((s) => s.trim() !== '');
}

export function joinPathEntries(entries) {
  return entries.join(';');
}

// 条目比较：Windows 路径大小写不敏感，且用户可能手写尾随空格。
// 比较用归一形式，但**写入时保留原始拼写**，避免把我们自己的归一强加给用户。
export function sameEntry(a, b) {
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

export function addPathEntry(entries, dir, position = 'last') {
  if (!String(dir).trim()) throw badInput('目录不能为空');
  const hit = entries.find((e) => sameEntry(e, dir));
  if (hit) return { entries: [...entries], added: false, existing: hit };
  const next = position === 'first' ? [dir, ...entries] : [...entries, dir];
  return { entries: next, added: true };
}

export function removePathEntry(entries, dir) {
  const kept = entries.filter((e) => !sameEntry(e, dir));
  return { entries: kept, removed: entries.length - kept.length };
}

// ─── 纯逻辑：值类型决策（本模块最容易静默损坏 PATH 的一处）─────────────
//
// 规则有两半，方向相反，别把它们混成「已有类型优先」：
//
//   1. **绝不降级**：已存在的 REG_EXPAND_SZ 永远保持 ExpandString。
//      实测过的两个反面教材都会降级：`reg add`（不带 /t）与 .NET 的
//      `Environment::SetEnvironmentVariable`。降级的后果是值里的
//      `%USERPROFILE%` 永远不再展开——这是最容易静默损坏用户 PATH 的一处。
//
//   2. **该升级就升级**：值里出现 `%` 时要变成 ExpandString，哪怕原来是 String。
//      只做第 1 条的话，用户往一个已存在的 String 变量里写
//      `%USERPROFILE%\bin`，得到的是一段字面量、永不展开——他以为写进去的是变量引用。
//      （存的是字面 `100%` 也无害：`100%` 不是合法的 %VAR%，展开后原样返回。）
export function decideKind(existingKind, value, explicitKind) {
  if (explicitKind) {
    if (!KINDS.includes(explicitKind)) throw badInput(`kind 只能是 ${KINDS.join(' | ')}`);
    return explicitKind;
  }
  if (existingKind === 'ExpandString') return 'ExpandString'; // 规则 1：不降级
  if (String(value).includes('%')) return 'ExpandString'; // 规则 2：含 %VAR% 就升级
  return KINDS.includes(existingKind) ? existingKind : 'String';
}

// 结构性编辑（PATH 条目增删）专用：**只保留已有类型，不做「含 % 就升级」**。
//
// 这条区分是实测逼出来的。用过 decideKind 的后果：某台机器的用户级 PATH 是 REG_SZ，
// 里面存着 `%JAVA_HOME%\bin`、`%MAVEN_HOME%\bin` 两条**字面量**（REG_SZ 从不展开，
// 所以它们实际是死条目）。`env path add` 加一个无关目录时，拼出来的整串含 `%`，
// 于是被升级成 ExpandString —— 整条 PATH 的展开语义被改掉，那两条突然生效，
// 机器上 JAVA_HOME / MAVEN_HOME 的 bin 凭空上了 PATH。
//
// 用户只是加了一个目录，不该承受这种全局语义变更。**`%` 是 PATH 里早已存在的，
// 不是用户这次输入的**——只有 env set（用户亲手写下一个值）才适用那条升级规则。
// 新建 PATH 时用 ExpandString：这是 Windows 对 PATH 的惯例类型。
export function kindForStructuralEdit(existingKind) {
  return KINDS.includes(existingKind) ? existingKind : 'ExpandString';
}

// ─── 纯逻辑：变量名匹配 ───────────────────────────────────────────────
//
// Windows 环境变量名大小写不敏感。更新已有变量时必须**沿用注册表里的原始拼写**，
// 否则会造出 `Path` 和 `PATH` 两个条目——而 Windows 对重复项的行为是未定义的。
export function findVar(values, name) {
  const key = String(name).toLowerCase();
  return values.find((v) => v.name.toLowerCase() === key) || null;
}

// ─── 纯逻辑：遮蔽分析 ─────────────────────────────────────────────────

// 用户级与系统级同名时，用户级**静默遮蔽**系统级。这不是错误，是 Windows 的既定行为，
// 但用户看不见——面板要把它显式标出来（本机上 TEMP / TMP 都是双份的，
// 看到的和系统里存的不是一回事）。
export function analyzeShadowing(userValues, systemValues) {
  const names = new Map(); // lower -> 原始拼写（用户级优先）
  for (const v of systemValues) names.set(v.name.toLowerCase(), v.name);
  for (const v of userValues) names.set(v.name.toLowerCase(), v.name);

  const out = [];
  for (const [lower, name] of names) {
    const u = userValues.find((v) => v.name.toLowerCase() === lower) || null;
    const s = systemValues.find((v) => v.name.toLowerCase() === lower) || null;
    const both = !!(u && s);
    const isPath = isPathName(name);
    out.push({
      name,
      user: u ? { value: u.value, kind: u.kind } : null,
      system: s ? { value: s.value, kind: s.kind } : null,
      scope: u ? 'user' : 'system',
      // PATH 是唯一的例外：它**不是遮蔽，而是拼接**（生效值 = 系统 + 用户）。
      // 把 Path 标成遮蔽会误导用户去删用户级 PATH —— 那会直接丢掉他加的那些条目。
      shadow: !isPath && both && u.value !== s.value,
      // 两份都在但值相同：不是遮蔽，只是重复登记，分开标注避免误报
      duplicate: both && u.value === s.value,
      concat: isPath && both,
    });
  }
  return out.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

// PATH 是唯一的例外：它**不是遮蔽，而是拼接**。
// 新会话生效的 PATH = 系统 PATH + 用户 PATH。把它按遮蔽展示会误导用户去删用户级 PATH。
export function composeEffectivePath(systemPath, userPath) {
  const system = splitPathEntries(systemPath).map((p) => ({ path: p, scope: 'system' }));
  const user = splitPathEntries(userPath).map((p) => ({ path: p, scope: 'user' }));
  const seen = new Set();
  return [...system, ...user].map((e) => {
    const key = e.path.trim().toLowerCase();
    const dup = seen.has(key);
    seen.add(key);
    return { ...e, duplicate: dup };
  });
}

// ─── 纯逻辑：渲染与 diff ──────────────────────────────────────────────

function sortByName(values) {
  return [...values].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

// PATH 拆成逐条目的行——否则一个 2000 字符的 PATH 在 diff 里就是一条巨行，
// 加了哪个目录根本看不出来。
export function scopeToText(values) {
  const lines = [];
  for (const v of sortByName(values)) {
    if (isPathName(v.name)) {
      lines.push(`${v.name} [${v.kind}]（PATH 条目）:`);
      splitPathEntries(v.value).forEach((e, i) => lines.push(`  ${String(i).padStart(3)}: ${e}`));
    } else {
      lines.push(`${v.name} [${v.kind}] = ${v.value}`);
    }
  }
  return lines.join('\n');
}

function diffOf(beforeAll, afterValues, scope) {
  const label = scope === 'user' ? 'HKCU\\Environment' : 'HKLM\\...\\Session Manager\\Environment';
  return unifiedDiff(
    scopeToText(beforeAll[scope].values),
    scopeToText(afterValues),
    `${label} (当前)`,
    `${label} (写入后)`
  );
}

// ─── 快照 ─────────────────────────────────────────────────────────────

const SNAPSHOT_KEEP = 50;

// 文件名用的时间戳。不依赖 Date.now() 的可读格式化之外的东西，便于测试注入。
export function snapshotId(now, rand) {
  const d = new Date(now);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const stamp =
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${stamp}-${String(rand).slice(0, 6)}`;
}

export function snapshotPath(id) {
  return join(envSnapshotDir(), `env_${id}.json`);
}

async function writeSnapshot(reason, all) {
  const id = snapshotId(Date.now(), Math.random().toString(16).slice(2, 8));
  const snap = {
    id,
    createdAt: new Date().toISOString(),
    reason,
    // 两个 scope 都存全量，恢复才可能是完整的
    user: { values: all.user.values },
    system: { values: all.system.values },
  };
  await fsp.mkdir(envSnapshotDir(), { recursive: true });
  await fsp.writeFile(snapshotPath(id), JSON.stringify(snap, null, 2), 'utf8');
  await pruneSnapshots();
  return snap;
}

async function pruneSnapshots() {
  const list = await listSnapshots();
  for (const s of list.slice(SNAPSHOT_KEEP)) {
    await fsp.rm(s.file, { force: true }).catch(() => {});
  }
}

export async function listSnapshots() {
  let entries = [];
  try {
    entries = await fsp.readdir(envSnapshotDir());
  } catch {
    return []; // 目录还不存在 = 还没有快照
  }
  const out = [];
  for (const name of entries) {
    if (!name.startsWith('env_') || !name.endsWith('.json')) continue;
    const file = join(envSnapshotDir(), name);
    try {
      const snap = JSON.parse(await fsp.readFile(file, 'utf8'));
      out.push({
        id: snap.id,
        createdAt: snap.createdAt,
        reason: snap.reason || '',
        userCount: (snap.user?.values || []).length,
        systemCount: (snap.system?.values || []).length,
        file,
      });
    } catch {
      // 损坏的快照跳过而不是让整个列表失败
    }
  }
  // 新的在前（文件名里的时间戳是零填充的，字典序即时间序）
  return out.sort((a, b) => String(b.id).localeCompare(String(a.id)));
}

export async function saveSnapshot(label) {
  const all = await driver.readAll();
  return writeSnapshot(label || '手动快照', all);
}

export async function readSnapshot(id) {
  if (!id) throw badInput('快照 id 不能为空');
  const file = snapshotPath(id);
  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch {
    // 「不存在」是 errors.js 里定下的锚点串，agent 靠它分类失败
    throw notFound(`快照不存在: ${id}（用 nx-rh env snapshot list 查看）`);
  }
  return JSON.parse(raw);
}

// ─── 编排：读 ─────────────────────────────────────────────────────────

export async function status() {
  const p = await driver.probe();
  return {
    platform: process.platform,
    supported: p.supported,
    elevated: p.elevated,
    user: p.user,
    scopeWritable: p.writable,
    snapshotDir: envSnapshotDir(),
    // 把「改完什么时候生效」直接说给调用方，省掉一轮「为什么没生效」的追问
    note:
      '写入的是注册表里的持久化值，新开的终端/应用会读到；' +
      '已经启动的进程（含本机已开的终端）不会自动跟变。',
  };
}

export async function list({ scope, shadow = true } = {}) {
  const all = await driver.readAll();
  if (scope) {
    if (!SCOPES.includes(scope)) throw badInput(`scope 只能是 ${SCOPES.join(' | ')}`);
    return { scope, values: sortByName(all[scope].values) };
  }
  const merged = shadow
    ? analyzeShadowing(all.user.values, all.system.values)
    : null;
  return {
    scopes: {
      user: { writable: true, values: sortByName(all.user.values) },
      system: { values: sortByName(all.system.values) },
    },
    merged,
    path: composeEffectivePath(
      findVar(all.system.values, 'Path')?.value,
      findVar(all.user.values, 'Path')?.value
    ),
  };
}

export async function get(name) {
  if (!name) throw badInput('变量名不能为空');
  const all = await driver.readAll();
  const u = findVar(all.user.values, name);
  const s = findVar(all.system.values, name);
  if (!u && !s) throw notFound(`环境变量不存在: ${name}`);

  const isPath = isPathName(name);
  return {
    name: u?.name || s?.name || name,
    user: u ? { value: u.value, kind: u.kind } : null,
    system: s ? { value: s.value, kind: s.kind } : null,
    // PATH 是拼接不是遮蔽，这条判断直接决定用户该不该去删用户级 PATH
    shadow: !isPath && !!(u && s) && u.value !== s.value,
    pathEntries: isPath ? composeEffectivePath(s?.value, u?.value) : null,
  };
}

export async function pathList({ scope } = {}) {
  const all = await driver.readAll();
  const pick = (s) => splitPathEntries(findVar(all[s].values, 'Path')?.value);
  if (scope) {
    if (!SCOPES.includes(scope)) throw badInput(`scope 只能是 ${SCOPES.join(' | ')}`);
    return { scope, entries: pick(scope) };
  }
  return { user: pick('user'), system: pick('system') };
}

// ─── 编排：写（安全网在这里）──────────────────────────────────────────

// 每条写路径的唯一出口。顺序固定：
//   算目标 → dry-run? 到此为止 → 自动快照 → 落盘 → （广播）
// 快照用的是**写之前**已经读到的那份，所以不额外多一次读。
async function guardedWrite({ reason, scope, dryRun, notify, apply }) {
  const before = await driver.readAll();
  const plan = apply(before);

  if (plan.status === 'skipped') return plan;
  if (plan.blocked) throw blocked(plan.blocked);

  const diff = diffOf(before, plan.values, scope);

  if (dryRun) {
    return {
      dryRun: true,
      scope,
      reason,
      changed: scopeToText(before[scope].values) !== scopeToText(plan.values),
      diff,
      writes: plan.writes,
    };
  }

  const snapshot = await writeSnapshot(reason, before);

  // 逐条落盘：action 的语义单元是「一条变量」，不是「整个 scope 的快照覆盖」。
  // 删掉再重建会让变量的注册表顺序与创建时间全部重置，也让失败后果被放大。
  for (const w of plan.writes) {
    if (w.op === 'set') await driver.writeValue(scope, w.name, w.value, w.kind, { notify });
    else if (w.op === 'delete') await driver.deleteValue(scope, w.name, { notify });
    else throw badInput(`未知写操作: ${w.op}`);
  }

  const after = await driver.readAll();
  return {
    dryRun: false,
    scope,
    reason,
    snapshot: snapshot.id,
    diff: diffOf(before, after[scope].values, scope),
    writes: plan.writes,
  };
}

export async function setVariable({ name, value, scope = 'user', kind, dryRun = false, notify = true }) {
  if (!name) throw badInput('变量名不能为空');
  if (value === undefined || value === null) throw badInput('值不能为空');
  if (!SCOPES.includes(scope)) throw badInput(`scope 只能是 ${SCOPES.join(' | ')}`);

  return guardedWrite({
    reason: `env set ${name} (${scope})`,
    scope,
    dryRun,
    notify,
    apply: (all) => {
      const existing = findVar(all[scope].values, name);
      const resolvedKind = decideKind(existing?.kind, value, kind);
      // 大小写不敏感：更新已有变量时沿用注册表里的原始拼写，
      // 否则会造出 Path / PATH 两个条目
      const finalName = existing ? existing.name : name;
      const rest = all[scope].values.filter((v) => v !== existing);
      return {
        values: [...rest, { name: finalName, kind: resolvedKind, value: String(value) }],
        writes: [{ op: 'set', name: finalName, value: String(value), kind: resolvedKind }],
      };
    },
  });
}

export async function removeVariable({ name, scope = 'user', dryRun = false, notify = true }) {
  if (!name) throw badInput('变量名不能为空');
  if (!SCOPES.includes(scope)) throw badInput(`scope 只能是 ${SCOPES.join(' | ')}`);

  return guardedWrite({
    reason: `env remove ${name} (${scope})`,
    scope,
    dryRun,
    notify,
    apply: (all) => {
      const existing = findVar(all[scope].values, name);
      if (!existing) return { status: 'skipped', reason: `${scope} 级不存在变量 ${name}` };
      return {
        values: all[scope].values.filter((v) => v !== existing),
        writes: [{ op: 'delete', name: existing.name }],
      };
    },
  });
}

export async function pathAdd({ dir, scope = 'user', position = 'last', dryRun = false, notify = true }) {
  if (!String(dir || '').trim()) throw badInput('目录不能为空');
  if (!SCOPES.includes(scope)) throw badInput(`scope 只能是 ${SCOPES.join(' | ')}`);

  return guardedWrite({
    reason: `env path add ${dir} (${scope})`,
    scope,
    dryRun,
    notify,
    apply: (all) => {
      const existing = findVar(all[scope].values, 'Path');
      const entries = splitPathEntries(existing?.value);
      const res = addPathEntry(entries, dir, position);
      // 已存在不是错误，是幂等跳过（与 setting 的 removeCandidate 同一立场）
      if (!res.added) return { status: 'skipped', reason: `PATH 中已存在: ${res.existing}` };
      const value = joinPathEntries(res.entries);
      const kind = kindForStructuralEdit(existing?.kind);
      const name = existing?.name || 'Path';
      return {
        values: [...all[scope].values.filter((v) => v !== existing), { name, kind, value }],
        writes: [{ op: 'set', name, value, kind }],
      };
    },
  });
}

export async function pathRemove({ dir, scope = 'user', dryRun = false, notify = true }) {
  if (!String(dir || '').trim()) throw badInput('目录不能为空');
  if (!SCOPES.includes(scope)) throw badInput(`scope 只能是 ${SCOPES.join(' | ')}`);

  return guardedWrite({
    reason: `env path remove ${dir} (${scope})`,
    scope,
    dryRun,
    notify,
    apply: (all) => {
      const existing = findVar(all[scope].values, 'Path');
      if (!existing) return { status: 'skipped', reason: `${scope} 级没有 Path` };
      const res = removePathEntry(splitPathEntries(existing.value), dir);
      if (!res.removed) return { status: 'skipped', reason: `PATH 中没有: ${dir}` };
      // 把 PATH 删空 = 让这台机器的命令行不可用，属于「业务规则主动阻止」
      if (!res.entries.length) return { blocked: '拒绝执行：这会让 PATH 变成空值，命令行将不可用' };
      const value = joinPathEntries(res.entries);
      const kind = kindForStructuralEdit(existing.kind);
      return {
        values: [...all[scope].values.filter((v) => v !== existing), { name: existing.name, kind, value }],
        writes: [{ op: 'set', name: existing.name, value, kind }],
      };
    },
  });
}

// ─── 编排：恢复快照 ───────────────────────────────────────────────────

export async function restoreSnapshot({ id, dryRun = false, notify = true }) {
  const snap = await readSnapshot(id);
  const before = await driver.readAll();
  const probe = await driver.probe();

  const plans = [];
  const skippedScopes = [];
  for (const scope of SCOPES) {
    const target = snap[scope]?.values;
    if (!target) continue;
    if (!probe.writable[scope]) {
      // 未提权时系统级恢复不了。这不是错误，是部分完成——
      // UI 要拿它展示「哪一半没恢复」，所以按 errors.js 的约定返回 status 而不是抛
      skippedScopes.push(scope);
      continue;
    }
    plans.push({ scope, values: target });
  }

  if (!plans.length) {
    throw blocked(
      '没有可恢复的 scope：系统级恢复需要以管理员身份运行 nx-rh，' +
        '而快照里也没有用户级数据'
    );
  }

  const diff = plans
    .map((p) => diffOf(before, p.values, p.scope))
    .join('\n\n');

  if (dryRun) {
    return { dryRun: true, id, diff, scopes: plans.map((p) => p.scope), skippedScopes };
  }

  // 恢复本身也是写操作 → 先自动快照，于是「恢复」可被「恢复」回去
  const guard = await writeSnapshot(`env snapshot restore ${id}（恢复前自动备份）`, before);

  for (const p of plans) {
    const targetNames = new Set(p.values.map((v) => v.name.toLowerCase()));
    const writes = [];
    // 先把当前多出来的变量删掉：快照的语义是「回到那个时刻」，不是「叠加」
    for (const cur of before[p.scope].values) {
      if (!targetNames.has(cur.name.toLowerCase())) writes.push({ op: 'delete', name: cur.name });
    }
    for (const v of p.values) writes.push({ op: 'set', name: v.name, value: v.value, kind: v.kind });

    for (const w of writes) {
      if (w.op === 'set') await driver.writeValue(p.scope, w.name, w.value, w.kind, { notify });
      else await driver.deleteValue(p.scope, w.name, { notify });
    }
  }

  const after = await driver.readAll();
  return {
    dryRun: false,
    status: skippedScopes.length ? 'partial' : 'ok',
    id,
    restored: plans.map((p) => p.scope),
    skippedScopes,
    snapshot: guard.id,
    diff: plans.map((p) => diffOf(before, after[p.scope].values, p.scope)).join('\n\n'),
  };
}
