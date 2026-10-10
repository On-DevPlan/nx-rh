// 跨源唯一化（dedupe）：skill hub check 发现的重复/冲突，要能一键收敛为
// 「一份实文件（准份）+ 其余删除 / 转链接」，且收敛后迁移不再 blocked。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'nxrh-dedupe-'));
const home = join(tmp, 'home');
mkdirSync(home, { recursive: true });
process.env.NX_RH_STORE = join(tmp, 'store.json');
process.env.HOME = home;
process.env.USERPROFILE = home;

const results = [];
const log = console.log;
function check(name, cond, extra = '') {
  results.push({ name, ok: !!cond });
  log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  -- ' + extra : ''));
}

const svc = await import('../../src/modules/skills/service.js');
const { detectLinkType } = await import('../../src/core/link.js');

const hub1 = join(tmp, 'hub1');
const hub2 = join(tmp, 'hub2');
function putSkill(hub, name, desc) {
  mkdirSync(join(hub, name), { recursive: true });
  writeFileSync(join(hub, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n`);
}
// dup-same：两源同内容（重复订阅）；dup-diff：两源不同内容（真冲突）
putSkill(hub1, 'dup-same', '一样的');
putSkill(hub2, 'dup-same', '一样的');
putSkill(hub1, 'dup-diff', '旧源的版本');
putSkill(hub2, 'dup-diff', '新源的版本');

function errCode(fn) {
  return fn().then(() => null, (e) => e.code || null);
}

try {
  await svc.addSource(hub1);
  await svc.addSource(hub2); // 新增即主源 → hub2 是主源

  const audit0 = await svc.sourceAudit();
  const names0 = audit0.conflicts.map((c) => c.name).sort();
  check('检查发现 dup-same / dup-diff', names0.join(',') === 'dup-diff,dup-same', names0.join(','));

  // ── 重复订阅（同内容）：as=link → 非准份转指向准份的链接 ──
  const r1 = await svc.dedupeSkill({ name: 'dup-same', source: hub1, as: 'link', force: true });
  check(
    'link 模式转出 1 处链接',
    r1.status === 'ok' && r1.linked.length === 1 && r1.removed.length === 0,
    JSON.stringify({ linked: r1.linked.length, removed: r1.removed.length })
  );
  check('hub2 的那份已是链接', !!(await detectLinkType(join(hub2, 'dup-same'))));
  check('链接内容仍可读（指向准份）', readFileSync(join(hub2, 'dup-same', 'SKILL.md'), 'utf8').includes('dup-same'));
  check('实文件来源只剩 hub1', (await svc.sourceEntriesFor('dup-same')).length === 1);

  // 链接不算来源 → 重复组从审计里消失；真冲突还在
  const audit1 = await svc.sourceAudit();
  check('dup-same 不再算重复', !audit1.conflicts.some((c) => c.name === 'dup-same'));
  check('dup-diff 仍是冲突', audit1.conflicts.some((c) => c.name === 'dup-diff' && !c.same));

  // ── 冲突（不同内容）：无 force 先 blocked（非准份也是实文件，丢弃不可逆） ──
  const r2 = await svc.dedupeSkill({ name: 'dup-diff', source: hub1, as: 'delete' });
  check('无 force 先 blocked', r2.status === 'blocked' && r2.plan.others.length === 1, r2.reason || '');

  // dry-run：只出计划不动盘
  const r3 = await svc.dedupeSkill({ name: 'dup-diff', source: hub1, as: 'delete', dryRun: true });
  check('dry-run 只出计划', r3.dryRun === true && existsSync(join(hub2, 'dup-diff')));

  // ── as=delete + force → 非准份实文件删除 ──
  const r4 = await svc.dedupeSkill({ name: 'dup-diff', source: hub1, as: 'delete', force: true });
  check('delete 模式删掉 1 份', r4.status === 'ok' && r4.removed.length === 1);
  check('hub2 的实文件已删', !existsSync(join(hub2, 'dup-diff')));
  check('收敛后不再冲突', !(await svc.sourceAudit()).conflicts.some((c) => c.name === 'dup-diff'));

  // 收敛的最终目的：迁移不再 blocked、不必 --source
  const project = join(tmp, 'proj');
  mkdirSync(project, { recursive: true });
  const mig = await svc.migrateSkill({ name: 'dup-diff', to: 'project', platform: 'claude-code', project });
  check('唯一化后迁移直接放行', mig.status === 'ok' && mig.count === 1);

  // 指定的准份来源里没有实文件（如已转成链接）→ NOT_FOUND
  const bad = await errCode(() => svc.dedupeSkill({ name: 'dup-same', source: hub2, force: true }));
  check('准份来源无实文件报 NOT_FOUND', bad === 'NOT_FOUND', String(bad));
} finally {
  const failed = results.filter((r) => !r.ok);
  log(`\n${results.length - failed.length}/${results.length} passed`);
  rmSync(tmp, { recursive: true, force: true });
  if (failed.length) process.exit(1);
}
