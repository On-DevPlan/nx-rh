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

  // ── 批量快捷唯一化：全部组都以主源实文件为准，其余转链接（一键处理所有冲突）──
  putSkill(hub1, 'batch-same', '批量一致');
  putSkill(hub2, 'batch-same', '批量一致');
  putSkill(hub1, 'batch-diff', '旧源版本b');
  putSkill(hub2, 'batch-diff', '新源版本b');

  const auditB = await svc.sourceAudit();
  const batchNames = auditB.conflicts.filter((c) => c.name.startsWith('batch-')).map((c) => c.name).sort();
  check('批量 fixtures 进入审计', batchNames.join(',') === 'batch-diff,batch-same', batchNames.join(','));

  const pb = await svc.dedupeAll({ dryRun: true });
  check('批量 dry-run 只出计划（2 组，不动盘）', pb.dryRun === true && pb.totals.groups === 2
    && existsSync(join(hub1, 'batch-same')) && existsSync(join(hub1, 'batch-diff')));

  const bb = await svc.dedupeAll();
  check('批量无 force 先 blocked', bb.status === 'blocked' && bb.totals.groups === 2, bb.reason || '');

  const b2 = await svc.dedupeAll({ as: 'link', force: true });
  check('批量唯一化 ok：2 组各转 1 链接', b2.status === 'ok' && b2.totals.linked === 2 && b2.totals.removed === 0,
    JSON.stringify(b2.totals));
  check('以主源为准：两组准份都是 hub2', b2.groups.every((g) => g.winner.source === hub2),
    JSON.stringify(b2.groups.map((g) => g.name + '@' + g.winner.source)));
  check('非主源 hub1 的两份已是链接', !!(await detectLinkType(join(hub1, 'batch-same')))
    && !!(await detectLinkType(join(hub1, 'batch-diff'))));
  check('链接内容仍可读（指向主源版本）', readFileSync(join(hub1, 'batch-diff', 'SKILL.md'), 'utf8').includes('新源版本b'));
  check('实文件来源只剩主源', (await svc.sourceEntriesFor('batch-same')).length === 1
    && (await svc.sourceEntriesFor('batch-same'))[0].source === hub2);

  const auditAfter = await svc.sourceAudit();
  check('批量唯一化后审计全绿', auditAfter.conflicts.length === 0, JSON.stringify(auditAfter.conflicts.map((c) => c.name)));

  // ── 多选勾选：names 点名只处理勾选的组，未点名的原样不动 ──
  putSkill(hub1, 'sel-a', '勾选甲');
  putSkill(hub2, 'sel-a', '勾选甲');
  putSkill(hub1, 'sel-b', '勾选乙');
  putSkill(hub2, 'sel-b', '勾选乙');

  const m1 = await svc.dedupeAll({ names: ['sel-a'], force: true });
  check('点名只处理 sel-a', m1.status === 'ok' && m1.totals.groups === 1 && m1.groups[0].name === 'sel-a' && m1.totals.linked === 1,
    JSON.stringify(m1.totals));
  check('未点名的 sel-b 两份原样不动', existsSync(join(hub1, 'sel-b')) && existsSync(join(hub2, 'sel-b'))
    && !(await detectLinkType(join(hub1, 'sel-b'))));
  check('sel-b 仍在审计里', (await svc.sourceAudit()).conflicts.some((c) => c.name === 'sel-b'));

  const m2 = await svc.dedupeAll({ names: ['sel-b', 'nope'], dryRun: true });
  check('点名不存在的组进 ignored 不报错', m2.dryRun === true && m2.groups.length === 1 && m2.groups[0].name === 'sel-b'
    && m2.ignored.join(',') === 'nope', JSON.stringify(m2.ignored));

  const m3 = await svc.dedupeAll({ names: ['sel-b'], force: true });
  check('再点名 sel-b 收敛后审计全绿', m3.status === 'ok' && m3.totals.groups === 1 && (await svc.sourceAudit()).conflicts.length === 0);

  const b3 = await svc.dedupeAll({ force: true });
  check('没有重复时再调用只回 note', b3.status === 'ok' && b3.totals.groups === 0 && !!b3.note);
} finally {
  const failed = results.filter((r) => !r.ok);
  log(`\n${results.length - failed.length}/${results.length} passed`);
  rmSync(tmp, { recursive: true, force: true });
  if (failed.length) process.exit(1);
}
