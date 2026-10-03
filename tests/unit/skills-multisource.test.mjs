// 多订阅源的选择池回归：migrate 的候选必须来自**全部**已订阅源，而非只有主源。
// 背景：hub add 会把新源设为主源，旧源里的 skill 不该因此「消失」
// （CI 上 smoke 的 `skill adapt demo-skill` 就是这么红的——加了第二个源后
// demo-skill 不在主源里，被判 NOT_FOUND）。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'nxrh-multisrc-'));
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

const hub1 = join(tmp, 'hub1');
const hub2 = join(tmp, 'hub2');
function putSkill(hub, name, desc) {
  mkdirSync(join(hub, name), { recursive: true });
  writeFileSync(join(hub, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n`);
}
// only-hub1：只在非主源；dup-same：两源同内容；dup-diff：两源不同内容（真冲突）
putSkill(hub1, 'only-hub1', '住在旧源');
putSkill(hub1, 'dup-same', '一样的');
putSkill(hub1, 'dup-diff', '旧源的版本');
putSkill(hub2, 'dup-same', '一样的');
putSkill(hub2, 'dup-diff', '新源的版本');

try {
  await svc.addSource(hub1);
  await svc.addSource(hub2); // 新增即主源 → hub2 是主源，hub1 变成非主源

  const pool = await svc.listAllSourceSkills();
  const names = pool.map((s) => s.name).sort();
  check('选择池聚合全部订阅源', names.join(',') === 'dup-diff,dup-same,only-hub1', names.join(','));

  const picked = await svc.selectSourceSkills({ names: ['only-hub1'] });
  check('点名非主源的 skill 不再 NOT_FOUND', picked.length === 1 && picked[0].source === hub1);

  // 语义锁定：点名搜全部源，但 --all 全量只铺当前主源（主源 = hub2，里面 2 个）
  const allPicked = await svc.selectSourceSkills({ all: true });
  check('--all 只取当前主源', allPicked.length === 2 && allPicked.every((s) => s.source === hub2),
    JSON.stringify(allPicked.map((s) => s.name + '@' + s.source)));

  // 非主源 skill 可直接迁移
  const project = join(tmp, 'proj');
  mkdirSync(project, { recursive: true });
  const mig = await svc.migrateSkill({ name: 'only-hub1', to: 'project', platform: 'claude-code', project });
  check('非主源 skill 迁移成功', mig.status === 'ok' && mig.count === 1, JSON.stringify(mig).slice(0, 160));

  // 同名同内容 = duplicate，不阻止迁移
  const dup = await svc.migrateSkill({ name: 'dup-same', to: 'project', platform: 'claude-code', project });
  check('跨源同内容不 blocked', dup.status === 'ok');

  // 同名不同内容 = 真冲突 → blocked；--source 显式指定后放行
  const conf = await svc.migrateSkill({ name: 'dup-diff', to: 'project', platform: 'claude-code', project });
  check('跨源冲突 blocked', conf.status === 'blocked' && conf.blocked.length === 1);
  const resolved = await svc.migrateSkill({ name: 'dup-diff', to: 'project', platform: 'claude-code', project, source: hub2 });
  check('--source 指定后放行', resolved.status === 'ok' && resolved.count === 1);
} finally {
  const failed = results.filter((r) => !r.ok);
  log(`\n${results.length - failed.length}/${results.length} passed`);
  rmSync(tmp, { recursive: true, force: true });
  if (failed.length) process.exit(1);
}
