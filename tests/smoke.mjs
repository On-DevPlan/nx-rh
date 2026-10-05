// 冒烟测试：CLI 全链路 + Web API + 静态页。
// 使用临时存储（NX_RH_STORE），并把 HOME/USERPROFILE 指到临时目录——
// 用户级迁移（~/.claude/skills、~/.workbuddy/skills）因此绝不碰真实用户目录。
// 运行：pnpm test（或 node tests/smoke.mjs）
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const BIN = join(ROOT, '..', 'bin', 'cli.mjs');

const tmp = mkdtempSync(join(tmpdir(), 'nx-rh-smoke-'));
const storePath = join(tmp, 'store.json');
const home = join(tmp, 'home');
mkdirSync(home, { recursive: true });
// 本进程（含稍后动态 import 的 web server）也必须指向临时存储与临时 home
process.env.NX_RH_STORE = storePath;
process.env.HOME = home;
process.env.USERPROFILE = home;
const hub = join(tmp, 'hub');
const project = join(tmp, 'project');
const project2 = join(tmp, 'project2');

const results = [];
function check(name, cond, extra = '') {
  results.push({ name, ok: !!cond });
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  -- ' + extra : ''));
}

function cli(args) {
  return spawnSync(process.execPath, [BIN, ...args], {
    env: { ...process.env, NX_RH_STORE: storePath, HOME: home, USERPROFILE: home },
    encoding: 'utf8',
  });
}

function cliJson(args) {
  const r = cli([...args, '--json']);
  if (r.status !== 0) {
    return { __error: r.stdout + r.stderr };
  }
  return JSON.parse(r.stdout);
}

// 异步版 cli：子进程运行期间本进程的事件循环保持可用。
// 「同端口 serve 认领」那条必须用它——被探测的服务器就跑在本进程里，
// spawnSync 会把事件循环冻住，服务器永远应答不了 probe（800ms 超时 → 误判无人）。
function cliAsync(args) {
  return new Promise((resolvePromise) => {
    const p = spawn(process.execPath, [BIN, ...args], {
      env: { ...process.env, NX_RH_STORE: storePath, HOME: home, USERPROFILE: home },
    });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (c) => { stdout += c; });
    p.stderr.on('data', (c) => { stderr += c; });
    p.on('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
}

// ---- fixtures ----
// 订阅源 1：目录下直接是 skill（新布局）
mkdirSync(join(hub, 'demo-skill'), { recursive: true });
writeFileSync(
  join(hub, 'demo-skill', 'SKILL.md'),
  '---\nname: demo-skill\ndescription: smoke test skill\n---\n\n# Demo\n\nhello\n'
);
mkdirSync(join(project, '.claude'), { recursive: true });
mkdirSync(project2, { recursive: true });

try {
  // ---- 1. 基础命令 ----
  const pkgVersion = JSON.parse(readFileSync(join(ROOT, '..', 'package.json'), 'utf8')).version;
  check('cli version', cli(['version']).stdout.trim() === pkgVersion);
  check('cli help', cli(['help']).stdout.includes('repo add'));
  check('cli unknown -> exit 1', cli(['nope']).status === 1);

  // ---- 2. 订阅源（Skill Hub） ----
  check('skill hub subscribe', cli(['skill', 'hub', 'subscribe', hub]).status === 0);
  const settings = cliJson(['setting', 'get']);
  check('setting get', settings.skillHubPath === hub, String(settings.skillHubPath));
  check('skill hub sources', (cliJson(['skill', 'hub', 'sources']).sources || []).some((s) => s.path === hub && s.current));

  // ---- 3. 仓库登记 CRUD ----
  // 仓库模块只做登记，不碰 git：状态 / diff / pull / push / resolve 已随 git 能力移除。
  check('repo add', cli(['repo', 'add', hub, '--name', 'hub-repo', '--tags', 'test,fixture']).status === 0);
  check('repo add 重复路径报错', cli(['repo', 'add', hub]).status === 1);
  const list = cliJson(['repo', 'list']);
  check('repo list --json', Array.isArray(list) && list.length === 1 && list[0].name === 'hub-repo');

  // CRUD 完备性（CLI 侧）。HTTP 侧由 tests/unit/registry.test.mjs 的 resource 断言覆盖——
  // 那里保证五个操作同时具备 cli 与 http，这里保证它们在 CLI 上真的跑得通。
  const repoId = list[0].id;
  check('repo get 取单条', cliJson(['repo', 'get', repoId]).name === 'hub-repo');
  check('repo get 不存在时失败', cli(['repo', 'get', 'r_not_exist']).status === 1);
  check('repo update 改描述', cliJson(['repo', 'update', repoId, '--desc', '改过的']).desc === '改过的');
  check('repo update 后再 get 能读到', cliJson(['repo', 'get', repoId]).desc === '改过的');
  // 改路径要能定位单条，也要防重复登记（否则两条记录指向同一目录，扫描结果无从判断）
  const renameTarget = join(tmp, 'rename-target');
  mkdirSync(renameTarget, { recursive: true });
  const repo2 = cliJson(['repo', 'add', project, '--name', 'proj-early']);
  check('repo update 改路径', cliJson(['repo', 'update', repo2.id, '--path', renameTarget]).path === renameTarget);
  check('repo update 改到已登记路径报错', cli(['repo', 'update', repo2.id, '--path', hub]).status === 1);

  // 扫描：只按「有没有 .git」识别仓库，不跑任何 git 子命令
  const scanRoot = join(tmp, 'scan-root');
  mkdirSync(join(scanRoot, 'a', '.git'), { recursive: true });
  mkdirSync(join(scanRoot, 'b', '.git'), { recursive: true });
  mkdirSync(join(scanRoot, 'not-a-repo'), { recursive: true });
  const scanned = cliJson(['repo', 'scan', scanRoot, '--depth', '2']);
  check('repo scan 只登记含 .git 的目录', scanned.scanned === 2 && scanned.added.length === 2, JSON.stringify(scanned.added.map((x) => x.path)));

  const dryScan = cliJson(['repo', 'scan', scanRoot, '--depth', '2', '--dry-run']);
  check(
    'repo scan --dry-run 只发现不登记（零副作用）',
    dryScan.dryRun === true && dryScan.scanned === 2 && dryScan.added.length === 0
      && dryScan.found.every((x) => x.known === true),
    JSON.stringify(dryScan).slice(0, 220)
  );

  // ---- 4. 订阅源 skill 识别 ----
  const listed = cliJson(['skill', 'hub', 'list']);
  check(
    '订阅源 skill 识别（含来源）',
    listed.skills.length === 1 && listed.skills[0].name === 'demo-skill' && listed.skills[0].source === hub,
    JSON.stringify(listed.skills?.[0])
  );
  check('skill show 给出描述与来源', cliJson(['skill', 'show', 'demo-skill']).description === 'smoke test skill');
  check('skill cat 输出全文', (cli(['skill', 'cat', 'demo-skill']).stdout || '').includes('hello'));

  // ---- 5. 迁移（订阅源 → 项目级，软链接） ----
  const mig = cliJson(['skill', 'migrate', 'demo-skill', '--to', 'project', '--project', project, '--platform', 'claude-code', '--mode', 'symlink']);
  check('migrate 软链接', mig.status === 'ok' && ['junction', 'symlink'].includes(mig.results[0].linkType), JSON.stringify(mig).slice(0, 160));
  const migAgain = cliJson(['skill', 'migrate', 'demo-skill', '--to', 'project', '--project', project, '--platform', 'claude-code']);
  check('重复迁移幂等跳过', migAgain.status === 'ok' && migAgain.skipped >= 1, JSON.stringify(migAgain).slice(0, 160));
  const projAfter = cliJson(['skill', 'hub', 'list', '--project', project]);
  const demoRow = projAfter.skills.find((s) => s.name === 'demo-skill');
  check(
    '迁移状态回读为已链接',
    demoRow && demoRow.cells.some((c) => c.on && c.platform === 'claude-code' && c.scope === 'project' && c.linkType),
    JSON.stringify(demoRow && demoRow.cells)
  );

  // ---- 6. 迁移到用户级（临时 home，绝不碰真实 ~/） ----
  const migUser = cliJson(['skill', 'migrate', 'demo-skill', '--to', 'user', '--platform', 'workbuddy']);
  check('迁移到用户级 workbuddy', migUser.status === 'ok', JSON.stringify(migUser).slice(0, 160));
  check('用户级落点正确', existsSync(join(home, '.workbuddy', 'skills', 'demo-skill', 'SKILL.md')));

  // ---- 7. 复制模式 ----
  const migCopy = cliJson(['skill', 'migrate', 'demo-skill', '--to', 'project', '--project', project2, '--platform', 'claude-code', '--mode', 'copy']);
  check('migrate 复制模式', migCopy.status === 'ok' && migCopy.mode === 'copy', JSON.stringify(migCopy).slice(0, 160));
  check(
    '复制模式落的是实体副本',
    existsSync(join(project2, '.claude', 'skills', 'demo-skill', 'SKILL.md')) &&
      !lstatSync(join(project2, '.claude', 'skills', 'demo-skill')).isSymbolicLink()
  );

  // ---- 8. 物化（链接 → 实体） ----
  const mat = cliJson(['skill', 'materialize', 'demo-skill', '--to', 'project', '--project', project, '--platform', 'claude-code']);
  check('materialize 转实体', mat.converted === true, JSON.stringify(mat).slice(0, 160));
  const projMat = cliJson(['skill', 'hub', 'list', '--project', project]);
  const demoRow2 = projMat.skills.find((s) => s.name === 'demo-skill');
  check('物化后该目标不再是链接', demoRow2.cells.find((c) => c.scope === 'project' && c.platform === 'claude-code').linkType === '');

  // ---- 9. 目的仓库直接覆盖（目的仓库不做冲突检测；冲突检测只在订阅源之间） ----
  const skillMd = join(project, '.claude', 'skills', 'demo-skill', 'SKILL.md');
  writeFileSync(skillMd, readFileSync(skillMd, 'utf8').replace('hello', 'hello-edited'));
  const conf = cliJson(['skill', 'migrate', 'demo-skill', '--to', 'project', '--project', project, '--platform', 'claude-code', '--mode', 'copy']);
  check('目的仓库直接被订阅源覆盖', conf.status === 'ok' && conf.migrated === 1, JSON.stringify(conf).slice(0, 200));
  check('覆盖后为订阅源内容（本地改动被替换）', !readFileSync(skillMd, 'utf8').includes('hello-edited'));

  // 参数缺失时的报错必须带「用法:」——agent-workflow.md 教 agent 用它判定参数错误。
  const usageErr = cli(['skill', 'migrate']);
  check('参数缺失报错含「用法:」锚点', usageErr.status === 1 && (usageErr.stdout + usageErr.stderr).includes('用法:'));

  // ---- 10. 提交（平台副本 → 订阅源，删目标实文件） ----
  mkdirSync(join(project, '.claude', 'skills', 'local-skill'), { recursive: true });
  writeFileSync(
    join(project, '.claude', 'skills', 'local-skill', 'SKILL.md'),
    '---\nname: local-skill\ndescription: 只在项目里\n---\n\n# L\n'
  );
  const beforeSubmit = cliJson(['skill', 'hub', 'list', '--project', project]);
  check('未入 Hub 的 skill 被单列', (beforeSubmit.orphans || []).some((o) => o.name === 'local-skill'));

  const submitted = cliJson(['skill', 'submit', 'local-skill', '--to', 'project', '--project', project, '--platform', 'claude-code']);
  check('submit 收进订阅源', submitted.status === 'ok' && !submitted.skipped, JSON.stringify(submitted).slice(0, 200));
  check('订阅源已有该 skill', existsSync(join(hub, 'local-skill', 'SKILL.md')));
  const localPath = join(project, '.claude', 'skills', 'local-skill');
  const localIsLink = lstatSync(localPath).isSymbolicLink();
  check('目标实文件已删除并改回链接', localIsLink, String(localIsLink));

  // ---- 11. 撤销迁移（链接可自由删；实体需 --force） ----
  const un = cliJson(['skill', 'unmigrate', 'local-skill', '--to', 'project', '--project', project, '--platform', 'claude-code']);
  check('unmigrate 撤销链接', un.status === 'ok' && un.removed.length >= 1, JSON.stringify(un).slice(0, 160));
  const unReal = cliJson(['skill', 'unmigrate', 'demo-skill', '--to', 'project', '--project', project, '--platform', 'claude-code']);
  check('unmigrate 实体副本被阻止（blocked）', unReal.status === 'blocked', JSON.stringify(unReal).slice(0, 200));

  // ---- 12. 路径穿越防护 ----
  check('非法 skill 名称拒绝', cli(['skill', 'migrate', '../evil', '--to', 'project', '--project', project]).status === 1);

  // ---- 13. merge3 原语 ----
  const baseF = join(tmp, 'base.txt');
  const aF = join(tmp, 'a.txt');
  const bF = join(tmp, 'b.txt');
  writeFileSync(baseF, 'line1\nline2\nline3\n');
  writeFileSync(aF, 'line1\nline2-a\nline3\n');
  writeFileSync(bF, 'line1\nline2\nline3-b\n');
  const merged = cliJson(['skill', 'merge', '--base', baseF, '--a', aF, '--b', bF]);
  check('merge3 无冲突自动合并', merged.merged.includes('line2-a') && merged.merged.includes('line3-b') && merged.conflicts.length === 0);
  writeFileSync(bF, 'line1\nline2-b\nline3\n');
  const merged2 = cliJson(['skill', 'merge', '--base', baseF, '--a', aF, '--b', bF]);
  check('merge3 双侧冲突标记', merged2.conflicts.length === 1 && merged2.merged.includes('<<<<<<<'));

  // ---- 14. SKILL.md frontmatter 解析（CRLF / 块标量 / 引号），同时验证多源订阅 ----
  const crlfSource = join(tmp, 'crlf-source');
  mkdirSync(join(crlfSource, 'crlf-skill'), { recursive: true });
  writeFileSync(
    join(crlfSource, 'crlf-skill', 'SKILL.md'),
    '---\r\nname: crlf-skill\r\ndescription: 换行是 CRLF 时也要能读出描述\r\n---\r\n\r\n# body\r\n'
  );
  mkdirSync(join(crlfSource, 'block-skill'), { recursive: true });
  writeFileSync(
    join(crlfSource, 'block-skill', 'SKILL.md'),
    '---\nname: block-skill\ndescription: >\n  折叠块标量\n  要合并成一行\n---\n\n# body\n'
  );
  mkdirSync(join(crlfSource, 'quoted-skill'), { recursive: true });
  writeFileSync(
    join(crlfSource, 'quoted-skill', 'SKILL.md'),
    '---\nname: quoted-skill\ndescription: "带引号的描述"\n---\n\n# body\n'
  );
  check('订阅第二个源', cli(['skill', 'hub', 'subscribe', crlfSource]).status === 0);
  const parsed = cliJson(['skill', 'hub', 'list', '--source', crlfSource]);
  const byName = Object.fromEntries((parsed.skills || []).map((s) => [s.name, s.description]));
  check('CRLF frontmatter 描述解析', byName['crlf-skill'] === '换行是 CRLF 时也要能读出描述', JSON.stringify(byName['crlf-skill']));
  check('折叠块标量描述解析', byName['block-skill'] === '折叠块标量 要合并成一行', JSON.stringify(byName['block-skill']));
  check('引号描述解析', byName['quoted-skill'] === '带引号的描述', JSON.stringify(byName['quoted-skill']));

  // ---- 15. 内置 skill 包安装（nx-rh，目录名 = 包名，见脚手架 A03 §二） ----
  const skillsHome = join(tmp, 'claude-skills');
  const bundleList = cliJson(['skill', 'list']);
  check(
    'skill list 是内置可装清单（B04 形状：skills 名字数组 + defaultGroup + groups）',
    Array.isArray(bundleList.skills) && bundleList.skills.includes('nx-rh')
      && bundleList.defaultGroup === 'nx-rh' && Array.isArray(bundleList.groups)
      && bundleList.groups.includes('rh-collect'),
    JSON.stringify(bundleList).slice(0, 220)
  );
  check('skill install --list 仍是别名（形状随主命令）',
    Array.isArray(cliJson(['skill', 'install', '--list']).skills));
  const bundleGroups = cliJson(['skill', 'groups']);
  check(
    'skill groups 给出 group → skills 映射',
    Array.isArray(bundleGroups.groups)
      && (bundleGroups.groupSkills['nx-rh'] || []).includes('nx-rh')
      && (bundleGroups.groupSkills['rh-collect'] || []).includes('rh-collect'),
    JSON.stringify(bundleGroups).slice(0, 220)
  );

  const inst = cliJson(['skill', 'install', '--to', skillsHome]);
  check('skill install 安装成功', inst.status === 'ok' && inst.installed === true && inst.files >= 4, JSON.stringify(inst));
  const installedMd = readFileSync(join(skillsHome, 'nx-rh', 'SKILL.md'), 'utf8');
  check('SKILL.md 落地且含 ref-map', installedMd.includes('场景路由（ref-map）') && installedMd.includes('[[repo-registry]]'));
  check('references 一并复制', existsSync(join(skillsHome, 'nx-rh', 'references', 'skill-hub.md')));

  const again = cliJson(['skill', 'install', '--to', skillsHome]);
  check('重复安装幂等跳过', again.status === 'ok' && again.skipped === true);

  writeFileSync(join(skillsHome, 'nx-rh', 'SKILL.md'), installedMd + '\n<!-- local edit -->\n');
  const conflicted = cliJson(['skill', 'install', '--to', skillsHome]);
  check('内容被改后返回 conflict', conflicted.status === 'conflict' && conflicted.count >= 1);
  const notForced = readFileSync(join(skillsHome, 'nx-rh', 'SKILL.md'), 'utf8');
  check('未加 --force 不覆盖', notForced.includes('local edit'));

  const forced = cliJson(['skill', 'install', '--to', skillsHome, '--force']);
  check('--force 覆盖为包内版本', forced.status === 'ok' && forced.replaced === true);
  check('覆盖后本地改动消失', !readFileSync(join(skillsHome, 'nx-rh', 'SKILL.md'), 'utf8').includes('local edit'));

  check('非法包名被拒', cli(['skill', 'install', '../evil', '--to', skillsHome]).status === 1);
  check('旧名 repo-hub 仍可作别名', cli(['skill', 'install', 'repo-hub', '--to', skillsHome]).status === 0);

  const groupInst = cliJson(['skill', 'install', '--group=rh-collect', '--to', skillsHome]);
  check(
    'skill install --group 装该组全部 skill（聚合形状用显式 group 字段判别）',
    groupInst.group === 'rh-collect' && groupInst.skills.length === 1 && groupInst.skills[0].name === 'rh-collect',
    JSON.stringify(groupInst).slice(0, 220)
  );
  check('未知 group 报错并列可用', cli(['skill', 'install', '--group=bogus', '--to', skillsHome]).status === 1);
  check('<name> 与 --group 互斥', cli(['skill', 'install', 'nx-rh', '--group=nx-rh', '--to', skillsHome]).status === 1);

  // skill get：三段拼接 + sentinel + 顺手安装；--json 是不含 prefix 的四元
  const got = cli(['skill', 'get']);
  check(
    'skill get 三段拼接',
    got.stdout.includes('# === nx-rh skill context ===') &&
      got.stdout.includes('# --- begin skill content (do not modify this line) ---') &&
      got.stdout.includes('-- install 状态 --') &&
      got.stdout.includes('场景路由（ref-map）'),
    got.stdout.slice(0, 120)
  );
  const gotJson = cliJson(['skill', 'get', '--json']);
  check(
    'skill get --json 四元（不含 prefix）',
    gotJson.skillName === 'nx-rh' && gotJson.ref === 'SKILL.md' && typeof gotJson.contentBytes === 'number' &&
      !!gotJson.install && !JSON.stringify(gotJson).includes('skill context ==='),
    JSON.stringify(Object.keys(gotJson))
  );
  // 第一个位置参数是 skill 名，第二个才是 ref（裸名解析）；裸 ref 不能放第一位
  const bare = cliJson(['skill', 'get', 'nx-rh', 'skill-hub', '--json']);
  check('skill get 裸名 ref 解析到 references/', bare.ref === 'references/skill-hub.md', bare.ref);
  check('skill get 拒绝越界 ref', cli(['skill', 'get', '..', '--json']).status === 1);
  check('skill get 未知名字报可用列表', /未找到内置 skill: nope（可用: /.test(cli(['skill', 'get', 'nope']).stderr || cli(['skill', 'get', 'nope']).stdout));

  // ---- 16. 平台范围与项目候选 ----
  check('project 候选添加', cli(['skill', 'project', 'add', project]).status === 0);
  const pList = cliJson(['skill', 'project', 'list']);
  check('project 候选列表', Array.isArray(pList) && pList.some((x) => x === project));
  check('skill adapters 含 workbuddy', cliJson(['skill', 'adapters']).some((a) => a.id === 'workbuddy'));
  check('skill platform 设置', cli(['skill', 'platform', 'claude-code', 'workbuddy']).status === 0);

  // ---- 16b. 零启动盘点：目录 + 完整描述 + 平台落点；平台别名；全局/项目化；可逆 ----
  const showOut = cli(['skill', 'show', 'demo-skill', '--project', project]);
  check('skill show 打印完整描述与平台落点矩阵',
    showOut.stdout.includes('smoke test skill') && showOut.stdout.includes('用户·') && showOut.stdout.includes('项目·'));

  const addrOut = cli(['skill', 'adapters', '--project', project]);
  check('skill adapters 打印项目级/用户级绝对落点',
    addrOut.stdout.includes(join(project, '.claude', 'skills')) &&
      addrOut.stdout.includes(join(home, '.claude', 'skills')));

  const listLong = cli(['skill', 'hub', 'list', '--long', '--project', project]);
  check('skill list --long 打印目录与完整描述',
    listLong.stdout.includes('目录: ') && listLong.stdout.includes('smoke test skill'));

  // 平台别名（claude / wb / cursor）+ adapt 动词别名 = 把 skill 变成 .cursor 形态
  const adaptAlias = cliJson(['skill', 'adapt', 'demo-skill', '--platform', 'cursor', '--to', 'project', '--project', project]);
  check('adapt 别名 + 平台别名 cursor', adaptAlias.status === 'ok', JSON.stringify(adaptAlias).slice(0, 140));
  check('cursor 项目落点生成', existsSync(join(project, '.cursor', 'skills', 'demo-skill', 'SKILL.md')));
  const unAlias = cliJson(['skill', 'unmigrate', 'demo-skill', '--platform', 'cursor', '--to', 'project', '--project', project]);
  check('迁移可逆（撤销链接）', unAlias.status === 'ok' && unAlias.removed.length >= 1 && !existsSync(join(project, '.cursor', 'skills', 'demo-skill')));

  const globalAlias = cliJson(['skill', 'adapt', 'demo-skill', '--platform', 'wb', '--to', 'global']);
  check('--to global 与平台别名 wb', globalAlias.status === 'ok' && existsSync(join(home, '.workbuddy', 'skills', 'demo-skill', 'SKILL.md')));
  check('未知平台报错并列可用项', cli(['skill', 'adapt', 'demo-skill', '--platform', 'nope']).status === 1);

  // ---- 16c. 批量选择：--all / --include / --exclude / --match / --dry-run ----
  // 前面「订阅第二个源」把主源切走了，这里切回来再测全量
  check('切回主源', cli(['skill', 'hub', hub]).status === 0);
  const bulkDir = join(tmp, 'bulk-proj');
  mkdirSync(bulkDir, { recursive: true });

  // ---- 16c-2. 当前项目子页数据（listProjectSkills）+ submit --into 选源 ----
  const projSk = cliJson(['skill', 'hub', 'project', 'skills', '--project', project]);
  check(
    'skill hub project skills 盘点项目目录并标注 inHub',
    Array.isArray(projSk.skills) && projSk.skills.some((s) => s.name === 'demo-skill' && s.inHub === true)
      && Array.isArray(projSk.dirs) && projSk.dirs.some((d) => d.platform === 'claude-code' && d.skills.length >= 1),
    JSON.stringify(projSk).slice(0, 200)
  );

  mkdirSync(join(project, '.claude', 'skills', 'into-skill'), { recursive: true });
  writeFileSync(
    join(project, '.claude', 'skills', 'into-skill', 'SKILL.md'),
    '---\nname: into-skill\ndescription: 收进指定订阅源\n---\n\n# I\n'
  );
  const intoRes = cliJson(['skill', 'submit', 'into-skill', '--to', 'project', '--project', project, '--into', crlfSource]);
  check(
    'submit --into 收进指定订阅源（而非主源）',
    intoRes.status === 'ok' && intoRes.into === resolve(crlfSource)
      && existsSync(join(crlfSource, 'into-skill', 'SKILL.md'))
      && !existsSync(join(hub, 'into-skill')),
    JSON.stringify(intoRes).slice(0, 200)
  );
  const intoBad = cli(['skill', 'submit', 'into-skill', '--to', 'project', '--project', project, '--into', join(tmp, 'scan-root'), '--json']);
  check('--into 未订阅的目录被拒并列出已订阅', intoBad.status === 1 && (intoBad.stdout + intoBad.stderr).includes('已订阅'));

  const dry = cliJson(['skill', 'migrate', '--all', '--dry-run', '--platform', 'claude-code', '--to', 'project', '--project', bulkDir]);
  check('批量 dry-run 列出计划且不落盘',
    dry.dryRun === true && dry.selected.length === 2 && !existsSync(join(bulkDir, '.claude')),
    JSON.stringify(dry.selected));

  const bulk = cliJson(['skill', 'migrate', '--all', '--platform', 'claude-code', '--to', 'project', '--project', bulkDir]);
  check('批量全量迁移', bulk.status === 'ok' && bulk.migrated === bulk.selected.length && bulk.selected.length === 2,
    JSON.stringify(bulk).slice(0, 160));
  check('批量落点齐全', ['demo-skill', 'local-skill'].every((n) => existsSync(join(bulkDir, '.claude', 'skills', n, 'SKILL.md'))));

  const ex = cliJson(['skill', 'migrate', '--all', '--exclude', 'demo*', '--platform', 'claude-code', '--to', 'project', '--project', bulkDir, '--dry-run']);
  check('--exclude 通配排除', !ex.selected.includes('demo-skill') && ex.selected.length === 1, JSON.stringify(ex.selected));
  const inc = cliJson(['skill', 'migrate', '--include', 'demo*', '--platform', 'claude-code', '--to', 'project', '--project', bulkDir, '--dry-run']);
  check('--include 模式筛选', JSON.stringify(inc.selected) === JSON.stringify(['demo-skill']), JSON.stringify(inc.selected));
  const mt = cliJson(['skill', 'migrate', '--all', '--match', 'smoke test', '--platform', 'claude-code', '--to', 'project', '--project', bulkDir, '--dry-run']);
  check('--match 按描述筛', JSON.stringify(mt.selected) === JSON.stringify(['demo-skill']), JSON.stringify(mt.selected));
  const multi = cliJson(['skill', 'migrate', 'demo-skill', 'local-skill', '--platform', 'claude-code', '--to', 'project', '--project', bulkDir]);
  check('多位置参数 <name...>', multi.selected.length === 2, JSON.stringify(multi.selected));

  const unDry = cliJson(['skill', 'unmigrate', '--all', '--exclude', 'demo*', '--to', 'project', '--project', bulkDir, '--dry-run']);
  check('撤销预演：排除项不在计划里',
    unDry.dryRun === true && unDry.plan.length === 1 && !unDry.plan.some((x) => x.name === 'demo-skill'),
    JSON.stringify(unDry.plan.map((x) => x.name)));
  check('撤销预演未落盘', existsSync(join(bulkDir, '.claude', 'skills', 'local-skill')));
  check('无选择方式报用法', cli(['skill', 'migrate']).status === 1);

  // ---- 17. 环境变量（只读 + dry-run：这里绝不真写注册表）----
  //
  // 本模块是唯一「状态不在临时 store 里」的模块——它改的是操作系统注册表。
  // 所以冒烟只走两条安全路径：读，以及按设计就不落盘的 --dry-run。
  // 写操作永远不进冒烟测试：那会改掉跑测试这台机器的 PATH。
  if (process.platform !== 'win32') {
    // CI 跑在 ubuntu-latest 上，这条才是 CI 实际覆盖的路径：
    // 非 win32 必须报**可分类的**错，而不是崩溃、也不是假装成功。
    const st = cliJson(['env', 'status']);
    check('env status 在非 win32 上 supported=false', st.supported === false, JSON.stringify(st));

    const envList = cli(['env', 'list', '--json']);
    let code = null;
    try { code = JSON.parse(envList.stdout).code; } catch { /* 非 JSON 输出说明崩了，下面会失败 */ }
    check('env list 在非 win32 报 BLOCKED 而不是崩溃', envList.status === 1 && code === 'BLOCKED', envList.stdout.slice(0, 120));
    check('env 写在非 win32 上同样被拦下', cli(['env', 'set', 'X', '1', '--json']).status === 1);
  } else {
    const st = cliJson(['env', 'status']);
    check('env status 报告平台 / 提权 / 两个 scope 的可写性',
      st.supported === true && typeof st.elevated === 'boolean' && !!st.scopeWritable, JSON.stringify(st));
    check('env status 的用户级始终可写（HKCU 属于当前用户）', st.scopeWritable.user === true);
    // 注意：env 读的是真实注册表（与 HOME 无关），所以这里只读、不写。
    const ls = cliJson(['env', 'list']);
    check('env list 返回合并视图 + 生效 PATH',
      Array.isArray(ls.merged) && Array.isArray(ls.path) && !!ls.scopes?.user, JSON.stringify(ls).slice(0, 140));

    const probe = 'NX_RH_SMOKE_PROBE_' + process.pid;
    const before = cliJson(['env', 'path', 'list']);
    const dry = cliJson(['env', 'set', probe, 'x', '--dry-run']);
    check('env set --dry-run 返回 diff 而不是结果', dry.dryRun === true && typeof dry.diff === 'string');
    check('env set --dry-run 之后变量仍不存在', cli(['env', 'get', probe]).status === 1);
    const after = cliJson(['env', 'path', 'list']);
    check('env path add --dry-run 真的没动 PATH',
      JSON.stringify(before.user) === JSON.stringify(after.user) &&
      JSON.stringify(before.system) === JSON.stringify(after.system));
  }

  // ---- 17. 启动目录作用域与最近项目 ----
  check('health 暴露 cwdScope', typeof cliJson(['health']).cwdScope === 'string');
  const boot0 = cliJson(['bootstrap']);
  check('bootstrap 暴露作用域与最近项目',
    typeof boot0.cwdScope === 'string' && Array.isArray(boot0.recents) && typeof boot0.projectRoot === 'string');
  check('recents add', (cliJson(['recents', 'add', project]) || []).some((r) => r.path === project));
  check('recents 幂等', (cliJson(['recents', 'add', project]) || []).filter((r) => r.path === project).length === 1);
  check('recents 带归一化 scope 键', typeof (cliJson(['recents']) || [])[0]?.scope === 'string');
  check('recents remove', !(cliJson(['recents', 'remove', project]) || []).some((r) => r.path === project));

  // ---- 18. Web API ----
  const { startServer } = await import(pathToFileURL(join(ROOT, '..', 'src', 'runtime', 'server.js')).href);
  const server = await startServer({ port: 0 });
  const base = 'http://127.0.0.1:' + server.address().port;

  const boot = await (await fetch(base + '/api/bootstrap')).json();
  check('api bootstrap', boot.ok && boot.data.repos.length === 4, JSON.stringify(boot.data.repos?.length));
  check('api bootstrap 带启动目录', typeof boot.data.projectRoot === 'string' && !!boot.data.projectRoot);
  check('api bootstrap 带最近项目与作用域键',
    Array.isArray(boot.data.recents) && typeof boot.data.cwdScope === 'string');
  check('api bootstrap 带 appStorePath（A03 SOP6 五字段）',
    typeof boot.data.appStorePath === 'string' && !!boot.data.appStorePath);

  // 作用域头：带上它，projectRoot 切到该目录——面板「切项目」靠的就是这一条，
  // 业务 action 完全不感知（见脚手架 ref B03 第四节）。
  const scoped = await (await fetch(base + '/api/bootstrap', { headers: { 'x-nx-rh-scope': project } })).json();
  check('x-nx-rh-scope 切换作用域', scoped.ok && scoped.data.projectRoot === project, scoped.data?.projectRoot);
  const health = await (await fetch(base + '/api/health')).json();
  check('api health 暴露 cwdScope（供端口探测认领）', health.ok && typeof health.data.cwdScope === 'string');

  const skillsRes = await (await fetch(base + '/api/skills?project=' + encodeURIComponent(project))).json();
  check(
    'api skills 返回订阅源与迁移状态',
    skillsRes.ok && Array.isArray(skillsRes.data.skills) && Array.isArray(skillsRes.data.sources),
    JSON.stringify(skillsRes).slice(0, 160)
  );

  const sourcesRes = await (await fetch(base + '/api/skills/sources')).json();
  check('api skills sources', sourcesRes.ok && sourcesRes.data.sources.length >= 2);

  const projSkRes = await (await fetch(base + '/api/skills/project-skills?project=' + encodeURIComponent(project))).json();
  check(
    'api skills project-skills',
    projSkRes.ok && Array.isArray(projSkRes.data.skills) && Array.isArray(projSkRes.data.dirs)
      && projSkRes.data.skills.some((s) => s.name === 'into-skill' && s.inHub === true),
    JSON.stringify(projSkRes).slice(0, 160)
  );

  mkdirSync(join(project, '.claude', 'skills', 'into-skill2'), { recursive: true });
  writeFileSync(
    join(project, '.claude', 'skills', 'into-skill2', 'SKILL.md'),
    '---\nname: into-skill2\ndescription: HTTP 侧 into\n---\n\n# I2\n'
  );
  const httpInto = await (
    await fetch(base + '/api/skills/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'into-skill2', to: 'project', project, into: crlfSource }),
    })
  ).json();
  check(
    'HTTP submit 带 into 收进指定源',
    httpInto.ok && httpInto.data.status === 'ok' && existsSync(join(crlfSource, 'into-skill2', 'SKILL.md')),
    JSON.stringify(httpInto).slice(0, 160)
  );

  // 面板走 HTTP 迁移：必须与 CLI 同源生效（用项目级目标，避免碰真实 home）
  const httpMig = await (
    await fetch(base + '/api/skills/migrate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'demo-skill', to: 'project', project: project2, platform: 'workbuddy', mode: 'symlink' }),
    })
  ).json();
  check('api skills migrate', httpMig.ok && httpMig.data.status === 'ok', JSON.stringify(httpMig).slice(0, 160));
  check('HTTP 迁移落到 .workbuddy/skills', existsSync(join(project2, '.workbuddy', 'skills', 'demo-skill', 'SKILL.md')));

  const httpUn = await (
    await fetch(base + '/api/skills/unmigrate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'demo-skill', to: 'project', project: project2, platform: 'workbuddy' }),
    })
  ).json();
  check('api skills unmigrate', httpUn.ok && httpUn.data.removed.length >= 1);

  const bundledRes = await (await fetch(base + '/api/bundled')).json();
  check(
    'api bundled 列表',
    bundledRes.ok && !!bundledRes.data.defaultDir
      && bundledRes.data.skills.some((s) => s.name === 'nx-rh' && s.files >= 4)
      && Array.isArray(bundledRes.data.groups)
  );

  const badRes = await (
    await fetch(base + '/api/repos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: hub }),
    })
  ).json();
  check('api 重复添加报错', !badRes.ok && /已登记/.test(badRes.error));

  const notFound = await (await fetch(base + '/api/nothing')).json();
  check('api 404', !notFound.ok);

  // 一个面板管所有项目：同端口再 serve 一次，应认领已有面板而不是起第二个进程。
  // 必须 cliAsync——服务器在本进程里，spawnSync 会冻住事件循环让 probe 永远超时。
  const claim = await cliAsync(['serve', '--port', String(server.address().port), '--no-open', project2]);
  check('同端口 serve 认领已有面板', claim.status === 0 && claim.stdout.includes('已在运行的面板'), claim.stdout.slice(0, 140));

  await new Promise((r) => server.close(r));

  // 静态页（构建产物存在时才有意义；未 build 时跳过）
  if (existsSync(join(ROOT, '..', 'src', 'web', 'public', 'index.html'))) {
    const server2 = await startServer({ port: 0 });
    const base2 = 'http://127.0.0.1:' + server2.address().port;
    const html = await (await fetch(base2 + '/')).text();
    check('web 首页', html.includes('npx-repo-hub') && !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(html));
    await new Promise((r) => server2.close(r));
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log('失败项: ' + failed.map((f) => f.name).join(', '));
  process.exit(1);
}
