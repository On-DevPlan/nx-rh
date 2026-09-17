// 冒烟测试：CLI 全链路 + Web API + 静态页。
// 使用临时存储（NX_RH_STORE），不污染用户目录 ~/.nx-rh。
// 运行：pnpm test（或 node tests/smoke.mjs）
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const BIN = join(ROOT, '..', 'bin', 'cli.mjs');

const tmp = mkdtempSync(join(tmpdir(), 'nx-rh-smoke-'));
const storePath = join(tmp, 'store.json');
// 本进程（含稍后动态 import 的 web server）也必须指向临时存储
process.env.NX_RH_STORE = storePath;
const central = join(tmp, 'central');
const project = join(tmp, 'project');
const project2 = join(tmp, 'project2');

const results = [];
function check(name, cond, extra = '') {
  results.push({ name, ok: !!cond });
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  -- ' + extra : ''));
}

function cli(args) {
  return spawnSync(process.execPath, [BIN, ...args], {
    env: { ...process.env, NX_RH_STORE: storePath },
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

// ---- fixtures ----
mkdirSync(join(central, 'skills', 'demo-skill'), { recursive: true });
writeFileSync(
  join(central, 'skills', 'demo-skill', 'SKILL.md'),
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

  // ---- 2. 设置 ----
  check('skill central set', cli(['skill', 'central', central]).status === 0);
  const settings = cliJson(['setting', 'get']);
  check('setting get', settings.skillCentralPath === central);

  // ---- 3. 仓库 CRUD ----
  check('repo add', cli(['repo', 'add', central, '--name', 'central-repo', '--tags', 'test,fixture']).status === 0);
  check('repo add 重复路径报错', cli(['repo', 'add', central]).status === 1);
  const list = cliJson(['repo', 'list']);
  check('repo list --json', Array.isArray(list) && list.length === 1 && list[0].name === 'central-repo');

  // CRUD 完备性（CLI 侧）。HTTP 侧由 tests/unit/registry.test.mjs 的 resource 断言覆盖——
  // 那里保证五个操作同时具备 cli 与 http，这里保证它们在 CLI 上真的跑得通。
  const repoId = list[0].id;
  check('repo get 取单条', cliJson(['repo', 'get', repoId]).name === 'central-repo');
  check('repo get 不存在时失败', cli(['repo', 'get', 'r_not_exist']).status === 1);
  check('repo update 改描述', cliJson(['repo', 'update', repoId, '--desc', '改过的']).desc === '改过的');
  check('repo update 后再 get 能读到', cliJson(['repo', 'get', repoId]).desc === '改过的');

  // git 仓库状态：测试内自建 git fixture（不依赖 .claude/repo 参考克隆——CI 上不存在）
  const gitRepo = join(tmp, 'git-fixture');
  mkdirSync(gitRepo, { recursive: true });
  const gitStep = (args) => {
    const r = spawnSync('git', args, { cwd: gitRepo, encoding: 'utf8' });
    if (r.status !== 0) throw new Error('git fixture ' + args.join(' ') + ' 失败: ' + (r.stderr || '').trim());
  };
  gitStep(['init', '-q', '-b', 'main']);
  gitStep(['config', 'user.email', 't@t']);
  gitStep(['config', 'user.name', 't']);
  writeFileSync(join(gitRepo, 'a.txt'), 'a\n');
  gitStep(['add', '.']);
  gitStep(['commit', '-qm', 'init']);
  check('repo add git repo', cli(['repo', 'add', gitRepo, '--name', 'git-ref']).status === 0);
  const statuses = cliJson(['repo', 'status']);
  const gitRow = Array.isArray(statuses) ? statuses.find((r) => r.name === 'git-ref') : null;
  check('git status 解析', !!gitRow && !!gitRow.git.branch && !gitRow.git.error,
    gitRow ? `branch=${gitRow.git.branch} err=${gitRow.git.error}` : 'gitRow=null（git-ref 未出现在 status 列表）');
  const nonGit = Array.isArray(statuses) ? statuses.find((r) => r.name === 'central-repo') : null;
  check('非 git 目录状态容错', !!nonGit && !!nonGit.git.error);

  // ---- 4. skill 识别 ----
  const centralSkills = cliJson(['skill', 'list', '--side', 'central']);
  check('central skill 识别', Array.isArray(centralSkills) && centralSkills.length === 1 && centralSkills[0].name === 'demo-skill');

  // ---- 5. 软链接同步（Windows 上应为 junction） ----
  const sync = cliJson(['skill', 'sync', 'demo-skill', '--project', project, '--mode', 'symlink']);
  check('skill sync symlink', sync.status === 'ok' && (sync.linkType === 'junction' || sync.linkType === 'symlink'), JSON.stringify(sync));
  const projSkills = cliJson(['skill', 'list', '--side', 'project', '--path', project]);
  check('项目侧识别为链接', Array.isArray(projSkills) && projSkills.length === 1 && !!projSkills[0].linkType, String(projSkills[0] && projSkills[0].linkType));
  const syncAgain = cliJson(['skill', 'sync', 'demo-skill', '--project', project, '--mode', 'symlink']);
  check('重复同步幂等跳过', syncAgain.status === 'ok' && syncAgain.skipped === true);

  // ---- 6. 复制模式同步 ----
  const syncCopy = cliJson(['skill', 'sync', 'demo-skill', '--project', project2, '--mode', 'copy']);
  check('skill sync copy', syncCopy.status === 'ok' && syncCopy.mode === 'copy', JSON.stringify(syncCopy));

  // ---- 7. 物化 ----
  const mat = cliJson(['skill', 'materialize', 'demo-skill', '--project', project]);
  check('materialize 转实体', mat.converted === true);
  const projSkills2 = cliJson(['skill', 'list', '--side', 'project', '--path', project]);
  check('物化后无链接形态', Array.isArray(projSkills2) && projSkills2.length === 1 && !projSkills2[0].linkType);

  // ---- 8. 冲突检测与选侧 ----
  const skillMd = join(project, '.claude', 'skills', 'demo-skill', 'SKILL.md');
  writeFileSync(skillMd, readFileSync(skillMd, 'utf8').replace('hello', 'hello-edited'));
  const conf = cliJson(['skill', 'conflict', 'demo-skill', '--project', project]);
  check('冲突检测', conf.files.length === 1 && conf.files[0].side === 'both-differ' && !!conf.files[0].diff.includes('@@'));
  const syncConf = cliJson(['skill', 'sync', 'demo-skill', '--project', project, '--mode', 'copy']);
  check('同步遇冲突返回 conflict', syncConf.status === 'conflict');
  check('apply 选中心侧', cli(['skill', 'apply', 'demo-skill', '--project', project, '--file', 'SKILL.md', '--side', 'central']).status === 0);
  const conf2 = cliJson(['skill', 'conflict', 'demo-skill', '--project', project]);
  check('冲突已解决', conf2.files.length === 0);

  // 前导点文件（.gitignore）必须能走完 conflict -> apply 全流程。
  // 文件路径校验一度复用了「目录名」的规则（拒绝前导点），结果是 conflict 列得出、
  // apply 却报「非法文件路径」——冲突永远无法按文件落地。
  writeFileSync(join(project, '.claude', 'skills', 'demo-skill', '.gitignore'), 'node_modules\n');
  writeFileSync(join(central, 'skills', 'demo-skill', '.gitignore'), 'dist\n');
  const dotConf = cliJson(['skill', 'conflict', 'demo-skill', '--project', project]);
  check('.gitignore 冲突被列出', dotConf.files.some((f) => f.file === '.gitignore' && f.side === 'both-differ'));
  check(
    'apply --file .gitignore 成功（前导点文件不被当非法路径）',
    cli(['skill', 'apply', 'demo-skill', '--project', project, '--file', '.gitignore', '--side', 'central']).status === 0
  );

  // 参数缺失时的报错必须带「用法:」——agent-workflow.md 教 agent 用它判定参数错误。
  const usageErr = cli(['skill', 'sync', 'demo-skill']);
  check('参数缺失报错含「用法:」锚点', usageErr.status === 1 && (usageErr.stdout + usageErr.stderr).includes('用法:'));

  // ---- 9. 推送到中心 ----
  writeFileSync(skillMd, readFileSync(skillMd, 'utf8').replace('hello', 'hello-pushed'));
  const pushed = cliJson(['skill', 'push', 'demo-skill', '--project', project, '--force']);
  check('skill push 到中心', pushed.status === 'ok');
  const centralAfter = cliJson(['skill', 'list', '--side', 'central']);
  check('中心内容已更新', centralAfter[0].md5 !== centralSkills[0].md5);

  // ---- 10. 路径穿越防护 ----
  check('非法 skill 名称拒绝', cli(['skill', 'sync', '../evil', '--project', project]).status === 1);

  // ---- 11. merge3 原语 ----
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

  // ---- 12. SKILL.md frontmatter 解析（CRLF / 块标量 / 引号） ----
  const crlfProject = join(tmp, 'crlf-project');
  mkdirSync(join(crlfProject, '.claude', 'skills', 'crlf-skill'), { recursive: true });
  writeFileSync(
    join(crlfProject, '.claude', 'skills', 'crlf-skill', 'SKILL.md'),
    '---\r\nname: crlf-skill\r\ndescription: 换行是 CRLF 时也要能读出描述\r\n---\r\n\r\n# body\r\n'
  );
  mkdirSync(join(crlfProject, '.claude', 'skills', 'block-skill'), { recursive: true });
  writeFileSync(
    join(crlfProject, '.claude', 'skills', 'block-skill', 'SKILL.md'),
    '---\nname: block-skill\ndescription: >\n  折叠块标量\n  要合并成一行\n---\n\n# body\n'
  );
  mkdirSync(join(crlfProject, '.claude', 'skills', 'quoted-skill'), { recursive: true });
  writeFileSync(
    join(crlfProject, '.claude', 'skills', 'quoted-skill', 'SKILL.md'),
    '---\nname: quoted-skill\ndescription: "带引号的描述"\n---\n\n# body\n'
  );
  const parsed = cliJson(['skill', 'list', '--side', 'project', '--path', crlfProject]);
  const byName = Object.fromEntries((parsed || []).map((s) => [s.name, s.description]));
  check('CRLF frontmatter 描述解析', byName['crlf-skill'] === '换行是 CRLF 时也要能读出描述', JSON.stringify(byName['crlf-skill']));
  check('折叠块标量描述解析', byName['block-skill'] === '折叠块标量 要合并成一行', JSON.stringify(byName['block-skill']));
  check('引号描述解析', byName['quoted-skill'] === '带引号的描述', JSON.stringify(byName['quoted-skill']));

  // ---- 13. 内置 skill 包安装（repo-hub） ----
  const skillsHome = join(tmp, 'claude-skills');
  const bundleList = cliJson(['skill', 'install', '--list']);
  check(
    'bundled 列表含 repo-hub',
    Array.isArray(bundleList) && bundleList.some((s) => s.name === 'repo-hub' && s.files >= 4),
    JSON.stringify(bundleList && bundleList.map((s) => s.name + ':' + s.files))
  );

  const inst = cliJson(['skill', 'install', '--to', skillsHome]);
  check('skill install 安装成功', inst.status === 'ok' && inst.installed === true && inst.files >= 4, JSON.stringify(inst));
  const installedMd = readFileSync(join(skillsHome, 'repo-hub', 'SKILL.md'), 'utf8');
  check('SKILL.md 落地且含 ref-map', installedMd.includes('场景路由（ref-map）') && installedMd.includes('[[repo-ops]]'));
  check('references 一并复制', existsSync(join(skillsHome, 'repo-hub', 'references', 'skill-sync.md')));

  const again = cliJson(['skill', 'install', '--to', skillsHome]);
  check('重复安装幂等跳过', again.status === 'ok' && again.skipped === true);

  writeFileSync(join(skillsHome, 'repo-hub', 'SKILL.md'), installedMd + '\n<!-- local edit -->\n');
  const conflicted = cliJson(['skill', 'install', '--to', skillsHome]);
  check('内容被改后返回 conflict', conflicted.status === 'conflict' && conflicted.count >= 1);
  const notForced = readFileSync(join(skillsHome, 'repo-hub', 'SKILL.md'), 'utf8');
  check('未加 --force 不覆盖', notForced.includes('local edit'));

  const forced = cliJson(['skill', 'install', '--to', skillsHome, '--force']);
  check('--force 覆盖为包内版本', forced.status === 'ok' && forced.replaced === true);
  check('覆盖后本地改动消失', !readFileSync(join(skillsHome, 'repo-hub', 'SKILL.md'), 'utf8').includes('local edit'));

  check('非法包名被拒', cli(['skill', 'install', '../evil', '--to', skillsHome]).status === 1);

  // ---- 13. 中心根目录布局 + 平台开关 + 多选比较 ----
  const central2 = join(tmp, 'central-root'); // 根目录直接是 skill（新布局）
  mkdirSync(join(central2, 'root-skill'), { recursive: true });
  writeFileSync(
    join(central2, 'root-skill', 'SKILL.md'),
    '---\nname: root-skill\ndescription: 根布局 skill\n---\n\n# R\n'
  );
  const proj3 = join(tmp, 'proj3');
  mkdirSync(join(proj3, '.claude'), { recursive: true });

  check('skill central add', cli(['skill', 'central', 'add', central2]).status === 0);
  const cs2 = cliJson(['skill', 'list', '--side', 'central', '--path', central2]);
  check('中心根目录布局识别', Array.isArray(cs2) && cs2.length === 1 && cs2[0].name === 'root-skill', JSON.stringify(cs2 && cs2.map((x) => x.name)));

  const syncP = cliJson(['skill', 'sync', 'root-skill', '--project', proj3, '--adapter', 'claude-code']);
  check('同步到指定平台', syncP.status === 'ok', JSON.stringify(syncP));

  const platOn = cliJson(['skill', 'platform-set', 'root-skill', '--project', proj3, '--adapter', 'cursor']);
  check('平台开关-开(cursor)', platOn.status === 'ok' && platOn.platform === 'cursor', JSON.stringify(platOn));

  const cmp = cliJson(['skill', 'compare', '--central', central2, '--project', proj3]);
  check(
    '多选比较汇总',
    cmp.summary && cmp.summary.linked >= 1 && cmp.rows.length === 1 && cmp.rows[0].platforms.length === 2,
    JSON.stringify(cmp.summary)
  );

  const platOff = cliJson(['skill', 'platform-set', 'root-skill', '--project', proj3, '--adapter', 'cursor', '--off']);
  check('平台开关-关(cursor)', platOff.removed === true, JSON.stringify(platOff));
  const cmp2 = cliJson(['skill', 'compare', '--central', central2, '--project', proj3]);
  check('关闭后平台计数更新', cmp2.rows[0].platforms.length === 1, JSON.stringify(cmp2.rows[0].platforms));

  // 实体锚点：删掉唯一实体时，自动物化旁系软链接兜底
  mkdirSync(join(central2, 'anchor-skill'), { recursive: true });
  writeFileSync(
    join(central2, 'anchor-skill', 'SKILL.md'),
    '---\nname: anchor-skill\ndescription: anchor\n---\n\n# A\n'
  );
  check('同步实体 anchor-skill', cli(['skill', 'sync', 'anchor-skill', '--project', proj3, '--adapter', 'claude-code', '--mode', 'copy']).status === 0);
  // 此时 proj3: root-skill=链接(claude-code)，anchor-skill=实体(claude-code)
  const rmReal = cliJson(['skill', 'remove', 'anchor-skill', '--project', proj3]);
  check(
    '删除实体 skill 触发锚点物化',
    rmReal.removed.length >= 1 && rmReal.anchor?.converted?.name === 'root-skill',
    JSON.stringify(rmReal.anchor)
  );
  const cmpA = cliJson(['skill', 'compare', '--central', central2, '--project', proj3]);
  const rowRoot = cmpA.rows.find((r) => r.name === 'root-skill');
  check(
    '兜底后 root-skill 变实体',
    rowRoot && rowRoot.state === 'same' && rowRoot.platforms.length === 1 && !rowRoot.platforms[0].linkType,
    JSON.stringify(rowRoot && rowRoot.platforms)
  );

  // 悬空链接：中心侧删除后，项目侧仍可识别并删除
  mkdirSync(join(central2, 'goner-skill'), { recursive: true });
  writeFileSync(
    join(central2, 'goner-skill', 'SKILL.md'),
    '---\nname: goner-skill\ndescription: will vanish\n---\n\n# G\n'
  );
  check('同步 goner-skill', cli(['skill', 'sync', 'goner-skill', '--project', proj3, '--adapter', 'claude-code']).status === 0);
  rmSync(join(central2, 'goner-skill'), { recursive: true, force: true });
  const dList = cliJson(['skill', 'list', '--side', 'project', '--path', proj3]);
  const dGoner = (dList || []).find((x) => x.name === 'goner-skill');
  check('悬空链接仍可识别', !!dGoner && dGoner.linkType && dGoner.description.includes('链接目标缺失'), JSON.stringify(dGoner));
  const dRm = cliJson(['skill', 'remove', 'goner-skill', '--project', proj3]);
  check('悬空链接可删除', dRm.removed.length >= 1, JSON.stringify(dRm));

  // 本地 skill（中心不存在）：平台开关从旁支本地创建，不强依赖中心
  mkdirSync(join(proj3, '.claude', 'skills', 'local-skill'), { recursive: true });
  writeFileSync(
    join(proj3, '.claude', 'skills', 'local-skill', 'SKILL.md'),
    '---\nname: local-skill\ndescription: 只在项目里\n---\n\n# L\n'
  );
  const platLocal = cliJson(['skill', 'platform-set', 'local-skill', '--project', proj3, '--adapter', 'cursor']);
  check(
    '本地 skill 平台开关从旁支创建',
    platLocal.status === 'ok' && platLocal.platform === 'cursor' && platLocal.from === 'sibling',
    JSON.stringify(platLocal)
  );
  const platLocal2 = cliJson(['skill', 'platform-set', 'local-skill', '--project', proj3, '--adapter', 'cursor']);
  check('旁支创建幂等', platLocal2.status === 'ok' && platLocal2.skipped === true, JSON.stringify(platLocal2));

  check('project 候选添加', cli(['skill', 'project', 'add', proj3]).status === 0);
  const pList = cliJson(['skill', 'project', 'list']);
  check('project 候选列表', Array.isArray(pList) && pList.some((x) => x === proj3));

  const rmSkill = cliJson(['skill', 'remove', 'root-skill', '--project', proj3]);
  check('skill remove 删除项目侧', rmSkill.removed.length >= 1, JSON.stringify(rmSkill));
  const cmp3 = cliJson(['skill', 'compare', '--central', central2, '--project', proj3]);
  check('删除后变仅中心', cmp3.rows[0].state === 'only-central');

  // ---- 14. 环境变量（只读 + dry-run：这里绝不真写注册表）----
  //
  // 本模块是唯一「状态不在临时 store 里」的模块——它改的是操作系统注册表。
  // 所以冒烟只走两条安全路径：读，以及按设计就不落盘的 --dry-run。
  // 写操作永远不进冒烟测试：那会改掉跑测试这台机器的 PATH。
  if (process.platform !== 'win32') {
    // CI 跑在 ubuntu-latest 上，这条才是 CI 实际覆盖的路径：
    // 非 win32 必须报**可分类的**错，而不是崩溃、也不是假装成功。
    const st = cliJson(['env', 'status']);
    check('env status 在非 win32 上 supported=false', st.supported === false, JSON.stringify(st));

    const list = cli(['env', 'list', '--json']);
    let code = null;
    try { code = JSON.parse(list.stdout).code; } catch { /* 非 JSON 输出说明崩了，下面会失败 */ }
    check('env list 在非 win32 报 BLOCKED 而不是崩溃', list.status === 1 && code === 'BLOCKED', list.stdout.slice(0, 120));
    check('env 写在非 win32 上同样被拦下', cli(['env', 'set', 'X', '1', '--json']).status === 1);
  } else {
    const st = cliJson(['env', 'status']);
    check('env status 报告平台 / 提权 / 两个 scope 的可写性',
      st.supported === true && typeof st.elevated === 'boolean' && !!st.scopeWritable, JSON.stringify(st));
    check('env status 的用户级始终可写（HKCU 属于当前用户）', st.scopeWritable.user === true);

    const ls = cliJson(['env', 'list']);
    check('env list 返回合并视图 + 生效 PATH',
      Array.isArray(ls.merged) && Array.isArray(ls.path) && !!ls.scopes?.user, JSON.stringify(ls).slice(0, 140));
    check('env list 的每条都带来源与遮蔽标记',
      ls.merged.every((m) => (m.scope === 'user' || m.scope === 'system') &&
        typeof m.shadow === 'boolean' && typeof m.duplicate === 'boolean'));

    const pl = cliJson(['env', 'path', 'list']);
    check('env path list 按条目返回两个 scope 的 PATH', Array.isArray(pl.user) && Array.isArray(pl.system));

    check('env snapshot list 可读', Array.isArray(cliJson(['env', 'snapshot', 'list'])));

    // ---- dry-run 的惰性：本模块最该被断言的一条 ----
    // PATH 是唯一「改错就让整台机器命令行不可用」的东西，所以必须证明
    // dry-run 路径连一个字节都没写。
    const probe = 'NX_RH_SMOKE_PROBE_' + process.pid;
    const before = cliJson(['env', 'path', 'list']);

    const dry = cliJson(['env', 'set', probe, 'x', '--dry-run']);
    check('env set --dry-run 返回 diff 而不是结果', dry.dryRun === true && typeof dry.diff === 'string');
    check('env set --dry-run 之后变量仍不存在', cli(['env', 'get', probe]).status === 1);
    check('env set --dry-run 不产生快照副作用', dry.snapshot === undefined);

    const pathDry = cliJson(['env', 'path', 'add', 'C:\\nx-rh-smoke-nonexistent', '--dry-run']);
    check('env path add --dry-run 给出将发生的改动',
      pathDry.dryRun === true && /nx-rh-smoke-nonexistent/.test(pathDry.diff));

    const after = cliJson(['env', 'path', 'list']);
    check('env path add --dry-run 真的没动 PATH',
      JSON.stringify(before.user) === JSON.stringify(after.user) &&
      JSON.stringify(before.system) === JSON.stringify(after.system));

    // 删除不存在的条目是幂等跳过，不是错误（与 setting 的 removeCandidate 同一立场）
    check('env path remove 不存在的条目时幂等跳过',
      cliJson(['env', 'path', 'remove', 'C:\\nx-rh-smoke-nonexistent']).status === 'skipped');

    // 保类型：往一个含 %VAR% 的新变量写值，默认应为 ExpandString
    const kindDry = cliJson(['env', 'set', probe + '_KIND', '%USERPROFILE%\\bin', '--dry-run']);
    check('env set 含 %VAR% 的新值默认落 ExpandString', /ExpandString/.test(kindDry.diff), kindDry.diff);
  }

  // ---- 15. Web API ----
  const { startServer } = await import(pathToFileURL(join(ROOT, '..', 'src', 'runtime', 'server.js')).href);
  const server = await startServer({ port: 0 });
  const base = 'http://127.0.0.1:' + server.address().port;

  const boot = await (await fetch(base + '/api/bootstrap')).json();
  check('api bootstrap', boot.ok && boot.data.repos.length === 2);

  // ---- 环境变量的 HTTP 侧（同样只走读与 dry-run）----
  // 这段的存在理由：面板调的每条路由都必须真的能通，而 CLI 与 HTTP 虽同源于
  // action 声明，参数整形（body vs flag）却是两条路径——只测 CLI 会漏掉这一半。
  const envStatusRes = await (await fetch(base + '/api/env/status')).json();
  check('api env status', envStatusRes.ok && typeof envStatusRes.data.supported === 'boolean');

  if (process.platform === 'win32') {
    const envListRes = await (await fetch(base + '/api/env')).json();
    check('api env list', envListRes.ok && Array.isArray(envListRes.data.merged));

    const envPathRes = await (await fetch(base + '/api/env/path')).json();
    check('api env path list', envPathRes.ok && Array.isArray(envPathRes.data.user));

    // PUT /api/env/:name 带 dry-run —— 面板的编辑弹窗就走这条
    const envDryRes = await (
      await fetch(base + '/api/env/NX_RH_SMOKE_HTTP', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: 'x', scope: 'user', 'dry-run': true }),
      })
    ).json();
    check('api env set 走 dry-run 返回 diff', envDryRes.ok && envDryRes.data.dryRun === true && !!envDryRes.data.diff);
    check('api env set dry-run 之后变量仍不存在',
      (await fetch(base + '/api/env/NX_RH_SMOKE_HTTP')).status === 404);

    // 字面量路由必须压过 :name 参数路由（/api/env/path 不能被当成变量名 "path" 之外的路径）
    check('api /api/env/path 未被 /api/env/:name 抢走', envPathRes.ok);

    // POST /api/env/path 带 dry-run
    const pathDryRes = await (
      await fetch(base + '/api/env/path', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dir: 'C:\\nx-rh-smoke-http', scope: 'user', 'dry-run': true }),
      })
    ).json();
    check('api env path add 走 dry-run', pathDryRes.ok && pathDryRes.data.dryRun === true);
  } else {
    const envListRes = await (await fetch(base + '/api/env')).json();
    check('api env list 在非 win32 返回可分类错误',
      !envListRes.ok && envListRes.code === 'BLOCKED', JSON.stringify(envListRes).slice(0, 120));
  }

  const html = await (await fetch(base + '/')).text();
  check('web 首页', html.includes('npx-repo-hub') && !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(html));

  const addRes = await (
    await fetch(base + '/api/repos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: project2, name: 'proj2' }),
    })
  ).json();
  check('api repo add', addRes.ok && addRes.data.name === 'proj2');

  const skillsRes = await (
    await fetch(base + '/api/skills?side=project&path=' + encodeURIComponent(project))
  ).json();
  check('api skills project', skillsRes.ok && skillsRes.data.length === 1);

  // 平台开关有两条入口：CLI 用 --off，面板传 enabled。二者必须走同一条分支。
  // 这里曾经出过严重回归——action 里写成 `enabled: !ctx.off`，面板传来的 false
  // 被 !undefined 顶成 true，于是面板上「关闭平台」永远关不掉；而当时的测试
  // 只覆盖了 CLI 的 --off，所以完全没被发现。
  const postPlatform = async (body) =>
    (await (await fetch(base + '/api/skills/platform', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })).json()).data;

  const viaCli = cliJson([
    'skill', 'platform-set', 'demo-skill', '--project', project, '--adapter', 'claude-code', '--off',
  ]);
  const viaPanel = await postPlatform({
    name: 'demo-skill', project, adapter: 'claude-code', enabled: false,
  });
  check(
    '平台开关：面板 enabled:false 与 CLI --off 走同一分支',
    viaPanel.status === viaCli.status,
    `panel=${JSON.stringify(viaPanel)} cli=${JSON.stringify(viaCli)}`
  );

  const panelOn = await postPlatform({
    name: 'demo-skill', project, adapter: 'claude-code', enabled: true,
  });
  check('平台开关：面板 enabled:true 能重新开启', panelOn.status === 'ok' && !panelOn.removed, JSON.stringify(panelOn));

  // /api/skills 不带 side 时应默认 central，而不是 400
  const defSide = await (await fetch(base + '/api/skills')).json();
  check('GET /api/skills 默认 side=central', defSide.ok === true, JSON.stringify(defSide).slice(0, 120));

  const bundledRes = await (await fetch(base + '/api/bundled')).json();
  check(
    'api bundled 列表',
    bundledRes.ok && bundledRes.data.skills.some((s) => s.name === 'repo-hub') && !!bundledRes.data.defaultDir
  );

  const badRes = await (
    await fetch(base + '/api/repos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: central }),
    })
  ).json();
  check('api 重复添加报错', !badRes.ok && /已登记/.test(badRes.error));

  const notFound = await (await fetch(base + '/api/nothing')).json();
  check('api 404', !notFound.ok);

  await new Promise((r) => server.close(r));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log('失败项: ' + failed.map((f) => f.name).join(', '));
  process.exit(1);
}
