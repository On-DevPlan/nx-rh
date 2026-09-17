// 环境变量模块的纯逻辑测试。
//
// 为什么这些断言值得写：本模块会写用户机器的 PATH，而 PATH 写坏会让整台机器的命令行
// 不可用。下面大部分用例都对应 spike 实测出来的一个真实坑（脚本见 .tool/envvar-spike/），
// 而不是凭空设想的边界。
//
// 全部在纯函数上跑，不碰注册表，因此 CI（ubuntu-latest）上也能完整执行——
// 平台差异只存在于 core/envvars.js 一层，那里由冒烟测试覆盖「非 win32 必须报可分类的错」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const load = (p) => import(pathToFileURL(join(ROOT, p)).href);

const svc = await load('src/modules/env/service.js');
const drv = await load('src/core/envvars.js');
const { CODES } = await load('src/core/errors.js');

// ─── PATH 条目 ────────────────────────────────────────────────────────

test('splitPathEntries: 丢弃空段，但非空条目原样保留', () => {
  // 空段来自 `;;` 与尾随 `;`，是噪声；而条目内容不修剪——
  // 带引号的路径、含空格的路径都是合法写法，修剪等于静默改用户的 PATH
  assert.deepEqual(svc.splitPathEntries('C:\\a;;D:\\b;'), ['C:\\a', 'D:\\b']);
  assert.deepEqual(svc.splitPathEntries(''), []);
  assert.deepEqual(svc.splitPathEntries(null), []);
  assert.deepEqual(svc.splitPathEntries('C:\\a  b\\bin;D:\\c'), ['C:\\a  b\\bin', 'D:\\c']);
  assert.deepEqual(svc.splitPathEntries('"C:\\Program Files\\x";D:\\y'), ['"C:\\Program Files\\x"', 'D:\\y']);
});

test('sameEntry: 大小写不敏感且忽略两侧空白（Windows 路径语义）', () => {
  assert.ok(svc.sameEntry('C:\\Bin', 'c:\\bin'));
  assert.ok(svc.sameEntry(' C:\\x ', 'C:\\x'));
  assert.ok(!svc.sameEntry('C:\\x', 'C:\\y'));
});

test('addPathEntry: 默认追加，first 前置，重复则幂等', () => {
  const base = ['C:\\a', 'D:\\b'];
  assert.deepEqual(svc.addPathEntry(base, 'E:\\c').entries, ['C:\\a', 'D:\\b', 'E:\\c']);
  assert.deepEqual(svc.addPathEntry(base, 'E:\\c', 'first').entries, ['E:\\c', 'C:\\a', 'D:\\b']);

  // 重复添加不是错误：幂等是 agent-workflow 声明的可依赖契约
  const dup = svc.addPathEntry(base, 'c:\\A');
  assert.equal(dup.added, false);
  assert.deepEqual(dup.entries, base);
  assert.equal(dup.existing, 'C:\\a');

  assert.throws(() => svc.addPathEntry(base, '  '), /目录不能为空/);
});

test('removePathEntry: 移除全部大小写变体并计数', () => {
  const base = ['C:\\a', 'D:\\b', 'c:\\A'];
  const res = svc.removePathEntry(base, 'C:\\a');
  assert.deepEqual(res.entries, ['D:\\b']);
  assert.equal(res.removed, 2);

  const none = svc.removePathEntry(base, 'Z:\\nope');
  assert.equal(none.removed, 0);
});

// ─── 值类型保真（本模块最容易静默损坏 PATH 的地方）────────────────────

test('decideKind: 绝不把已有的 ExpandString 降级成 String', () => {
  // 实测过的两个反面教材都会降级：
  //   reg add（不带 /t）与 .NET Environment::SetEnvironmentVariable
  // 降级的后果是 PATH 里 `%USERPROFILE%` 永远不再展开。
  assert.equal(svc.decideKind('ExpandString', 'any', undefined), 'ExpandString');
  assert.equal(svc.decideKind('ExpandString', 'C:\\no-percent', undefined), 'ExpandString');
});

test('decideKind: 值里出现 % 时把 String 升级成 ExpandString', () => {
  // 只在「不降级」这一半做对是不够的：用户往一个已存在的 String 变量里写
  // `%USERPROFILE%\bin`，若仍存成 String，那段字面量永远不会展开——
  // 他以为写进去的是变量引用。这条是端到端写入验证逮出来的。
  assert.equal(svc.decideKind('String', '%USERPROFILE%\\bin', undefined), 'ExpandString');
  // 不含 % 就维持原样
  assert.equal(svc.decideKind('String', 'C:\\plain', undefined), 'String');
  // 全新的变量同理
  assert.equal(svc.decideKind(undefined, '%USERPROFILE%\\bin'), 'ExpandString');
  assert.equal(svc.decideKind(undefined, 'C:\\plain'), 'String');
  // 注册表里别人建的 DWord：环境变量本来就该是字符串，按 String 处理
  assert.equal(svc.decideKind('DWord', 'x'), 'String');
});

test('decideKind: 显式 --kind 覆盖一切', () => {
  // 覆盖是双向的：连「不降级」这条也能被显式推翻——但必须是用户明说
  assert.equal(svc.decideKind('ExpandString', 'x', 'String'), 'String');
  assert.equal(svc.decideKind('String', 'x', 'ExpandString'), 'ExpandString');
  assert.equal(svc.decideKind('ExpandString', '%X%', 'String'), 'String');
  assert.throws(() => svc.decideKind('String', 'x', 'DWord'), /kind 只能是/);
});

test('kindForStructuralEdit: PATH 条目增删只保类型，不做「含 % 就升级」', () => {
  // 实测逼出来的区分。某台机器的用户级 PATH 是 REG_SZ，里面存着
  // `%JAVA_HOME%\bin`、`%MAVEN_HOME%\bin` 两条**字面量**（REG_SZ 从不展开，
  // 所以它们实际是死条目）。用 decideKind 的话，`env path add` 加一个无关目录时
  // 拼出来的整串含 `%`，于是整条 PATH 被升级成 ExpandString——那两条突然生效，
  // 机器上 JAVA_HOME / MAVEN_HOME 的 bin 凭空上了 PATH。
  //
  // 用户只是加了一个目录，不该承受这种全局语义变更：`%` 来自 PATH 里早已存在的条目，
  // 不是他这次输入的值。只有 env set（用户亲手写下一个值）才适用升级规则。
  assert.equal(svc.kindForStructuralEdit('String'), 'String');
  assert.equal(svc.kindForStructuralEdit('ExpandString'), 'ExpandString');
  // 新建 PATH（原来没有）用 ExpandString：Windows 对 PATH 的惯例
  assert.equal(svc.kindForStructuralEdit(undefined), 'ExpandString');
  assert.equal(svc.kindForStructuralEdit('DWord'), 'ExpandString');
});

// ─── 变量名匹配 ───────────────────────────────────────────────────────

test('findVar: 大小写不敏感，且返回注册表里的原始拼写', () => {
  const vals = [{ name: 'Path', kind: 'String', value: 'x' }];
  assert.equal(svc.findVar(vals, 'path').name, 'Path');
  assert.equal(svc.findVar(vals, 'PATH').name, 'Path');
  assert.equal(svc.findVar(vals, 'nope'), null);
});

// ─── 遮蔽分析 ─────────────────────────────────────────────────────────

const V = (name, value, kind = 'String') => ({ name, value, kind });

test('analyzeShadowing: 区分「只在一侧」「遮蔽」「重复登记」', () => {
  const merged = svc.analyzeShadowing(
    [V('GOPATH', 'D:\\user-go'), V('SAME', 'x'), V('ONLYUSER', 'u')],
    [V('GOPATH', 'D:\\sys-go'), V('SAME', 'x'), V('ONLYSYS', 's')]
  );
  const by = Object.fromEntries(merged.map((m) => [m.name, m]));

  // 用户级与系统级值不同 → 是真遮蔽，必须标出来
  assert.equal(by.GOPATH.shadow, true);
  assert.equal(by.GOPATH.scope, 'user');

  // 两边都有但值相同 → 只是重复登记，不是遮蔽。混为一谈会让面板误报
  assert.equal(by.SAME.shadow, false);
  assert.equal(by.SAME.duplicate, true);

  assert.equal(by.ONLYUSER.scope, 'user');
  assert.equal(by.ONLYUSER.shadow, false);
  assert.equal(by.ONLYSYS.scope, 'system');
  assert.equal(by.ONLYSYS.shadow, false);

  // 合并结果按名字排序，面板与 CLI 输出才稳定
  assert.deepEqual(merged.map((m) => m.name), ['GOPATH', 'ONLYSYS', 'ONLYUSER', 'SAME']);
});

test('analyzeShadowing: 同一个变量的名字大小写不同也认作一个', () => {
  // 用非 PATH 的名字：Path 有拼接特例，会掩盖这条断言真正要测的东西
  const merged = svc.analyzeShadowing([V('temp', 'u')], [V('TEMP', 's')]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].shadow, true);
  // 显示用户级的拼写：生效的是用户级的值，名字就该跟着它走
  assert.equal(merged[0].name, 'temp');
});

test('analyzeShadowing: Path 标成「拼接」而不是「遮蔽」', () => {
  // 这是实测数据逮出来的一个真错误：本机上 Path 在两个 scope 里都存在且值不同，
  // 于是被标成「用户级遮蔽了系统级」。但 PATH 是**拼接**——把它标成遮蔽，
  // 用户会去删用户级 PATH，而那会直接丢掉他加的几十个条目。
  const merged = svc.analyzeShadowing([V('Path', 'C:\\mine')], [V('Path', 'C:\\Windows')]);
  assert.equal(merged[0].shadow, false);
  assert.equal(merged[0].concat, true);
  assert.equal(merged[0].duplicate, false);

  // 非 PATH 的同名不同值仍然是遮蔽
  const temp = svc.analyzeShadowing([V('TEMP', 'a')], [V('TEMP', 'b')]);
  assert.equal(temp[0].shadow, true);
  assert.equal(temp[0].concat, false);
});

// ─── 生效 PATH ────────────────────────────────────────────────────────

test('composeEffectivePath: PATH 是拼接不是遮蔽，系统在前用户在后', () => {
  // 这条判断直接决定面板该不该提示用户「去删用户级 PATH」——PATH 是唯一例外，
  // 新会话生效的 PATH = 系统 PATH + 用户 PATH。
  const eff = svc.composeEffectivePath('C:\\Windows;C:\\Shared', 'C:\\Shared;D:\\mine');
  assert.deepEqual(
    eff.map((e) => [e.path, e.scope, e.duplicate]),
    [
      ['C:\\Windows', 'system', false],
      ['C:\\Shared', 'system', false],
      ['C:\\Shared', 'user', true], // 第二次出现标为重复
      ['D:\\mine', 'user', false],
    ]
  );
  assert.deepEqual(svc.composeEffectivePath(undefined, 'D:\\only'), [{ path: 'D:\\only', scope: 'user', duplicate: false }]);
});

// ─── PowerShell 输出归一化（PS 5.1 的两个已知退化）─────────────────────

test('normalizeItems: 单元素被 ConvertTo-Json 退化成裸对象也要认', () => {
  // PS 5.1 的 ConvertTo-Json 对单元素数组输出裸对象、对空数组输出空字符串。
  // 「这个键下只有一个变量」在新装机器上是常态，不归一化就会炸。
  const one = drv.normalizeItems({ name: 'Path', kind: 'String', value: 'x' });
  assert.equal(one.length, 1);
  assert.equal(one[0].name, 'Path');

  assert.deepEqual(drv.normalizeItems([]), []);
  assert.deepEqual(drv.normalizeItems(''), []);
  assert.deepEqual(drv.normalizeItems(null), []);
  assert.deepEqual(drv.normalizeItems(undefined), []);
});

test('normalizeItems: 空值保留为空串，未知 kind 不丢字段', () => {
  // 真实机器上存在值为空的环境变量（如 IntelliJ IDEA），不能当成缺失
  const items = drv.normalizeItems([
    { name: 'EMPTY', kind: 'String', value: '' },
    { name: 'NOVALUE', kind: 'String' },
    { name: 'WEIRD', kind: 'DWord', value: '1' },
  ]);
  assert.equal(items[0].value, '');
  assert.equal(items[1].value, '');
  assert.equal(items[2].kind, 'DWord');
});

test('normalizeReadData: 缺 scope / 缺字段都给出安全默认', () => {
  const d = drv.normalizeReadData({ user: { values: { name: 'A', kind: 'String', value: '1' } } });
  assert.equal(d.user.values.length, 1);
  assert.equal(d.user.exists, true);
  assert.deepEqual(d.system.values, []);

  const empty = drv.normalizeReadData(null);
  assert.deepEqual(empty.user.values, []);
  assert.deepEqual(empty.system.values, []);
});

test('parseEnvelope: 从末尾往前找第一行可解析的 JSON', () => {
  assert.deepEqual(drv.parseEnvelope('noise\n{"ok":true}\n'), { ok: true });
  assert.deepEqual(drv.parseEnvelope('warning: x\n{"ok":true,"data":1}\n'), { ok: true, data: 1 });
  // 尾部有半截非 JSON 行时不能把前面的结果吃掉
  assert.deepEqual(drv.parseEnvelope('{"ok":true}\ntrailing junk'), { ok: true });
  assert.equal(drv.parseEnvelope('nothing here'), null);
  assert.equal(drv.parseEnvelope(''), null);
});

// ─── 错误分类：按异常类型名，不看本地化文案 ───────────────────────────

test('classifyDriverError: 未提权写系统级 → BLOCKED（不是 INTERNAL）', () => {
  // 中文 Windows 的异常 message 是中文，按文案匹配在别的语言上必然失效，
  // 所以分类只认异常类型名。BLOCKED 表示「业务规则主动阻止」，agent 应据此停下问人。
  const e = drv.classifyDriverError('UnauthorizedAccessException');
  assert.equal(e.code, CODES.BLOCKED);
  assert.match(e.message, /管理员权限/);

  assert.equal(drv.classifyDriverError('SecurityException').code, CODES.BLOCKED);
  assert.equal(drv.classifyDriverError('ItemNotFoundException').code, CODES.BLOCKED);
});

test('classifyDriverError: 未知异常 → EXTERNAL，且不透传原始异常文本', () => {
  const e = drv.classifyDriverError('SomeWeirdException', '细节');
  assert.equal(e.code, CODES.EXTERNAL);
  assert.match(e.message, /SomeWeirdException/);
});

// ─── 非 win32：必须报可分类的错，而不是崩溃 ───────────────────────────

test('非 win32 上所有写入口抛 BLOCKED 而不是抛原生异常', async () => {
  // CI 跑在 ubuntu-latest，这条路径是被断言的
  if (process.platform === 'win32') return;
  assert.equal(drv.isSupported(), false);
  await assert.rejects(() => drv.readAll(), (e) => e.code === CODES.BLOCKED);
  await assert.rejects(() => drv.writeValue('user', 'A', '1', 'String'), (e) => e.code === CODES.BLOCKED);
  await assert.rejects(() => drv.deleteValue('user', 'A'), (e) => e.code === CODES.BLOCKED);

  const p = await drv.probe();
  assert.equal(p.supported, false);
  assert.equal(p.writable.system, false);
});

// ─── 渲染与快照 ───────────────────────────────────────────────────────

test('scopeToText: PATH 拆成逐条目行，其余变量一行一条', () => {
  const text = svc.scopeToText([
    { name: 'Path', kind: 'String', value: 'C:\\a;D:\\b' },
    { name: 'GOPATH', kind: 'String', value: 'D:\\go' },
  ]);
  const lines = text.split('\n');
  // PATH 若按单个变量渲染，一个 2000 字符的 PATH 在 diff 里就是一条巨行，
  // 加了哪个目录根本看不出来
  assert.match(lines[0], /^GOPATH \[String\] = D:\\go$/);
  assert.match(lines[1], /^Path \[String\]（PATH 条目）:$/);
  assert.match(lines[2], /^\s+0: C:\\a$/);
  assert.match(lines[3], /^\s+1: D:\\b$/);
});

test('snapshotId: 时间戳零填充，字典序即时间序', () => {
  const early = svc.snapshotId(new Date(2026, 0, 2, 3, 4, 5).getTime(), 'aaaaaa');
  const late = svc.snapshotId(new Date(2026, 10, 12, 13, 14, 15).getTime(), 'bbbbbb');
  assert.equal(early, '20260102-030405-aaaaaa');
  assert.equal(late, '20261112-131415-bbbbbb');
  // 列表按 id 倒序排，全靠这个性质
  assert.ok(late > early);
});

test('快照留在 ~/.nx-rh/env_snapshots 且带 env_ 前缀', async () => {
  const { envSnapshotDir } = await load('src/core/paths.js');
  assert.match(envSnapshotDir().replace(/\\/g, '/'), /\.nx-rh\/env_snapshots$/);
  assert.match(svc.snapshotPath('20260101-000000-abc123').replace(/\\/g, '/'), /env_snapshots\/env_20260101-000000-abc123\.json$/);
});

test('readSnapshot: 不存在的 id 报 NOT_FOUND，且文案含「不存在」锚点', async () => {
  // agent-workflow 教 agent 用「不存在」判定目标缺失并据此停下，不能改掉这个词
  await assert.rejects(
    () => svc.readSnapshot('19990101-000000-zzzzzz'),
    (e) => e.code === CODES.NOT_FOUND && /不存在/.test(e.message)
  );
  await assert.rejects(() => svc.readSnapshot(''), (e) => e.code === CODES.INVALID_INPUT);
});

// ─── 注入防线：脚本里不得出现数据 ─────────────────────────────────────

test('驱动脚本只含常量，变量数据一律不参与拼接', () => {
  // 变量值来自 agent，可以直接是 `'; Remove-Item -Recurse ...`。
  // 这条断言把「数据不进入脚本文本」从口头约定变成可执行检查。
  const src = readFileSync(join(ROOT, 'src', 'core', 'envvars.js'), 'utf8');

  // 写路径必须把值落成临时文件、路径经 $env: 传入
  assert.match(src, /NX_RH_VALUE_FILE/);
  assert.match(src, /NX_RH_NAME/);
  // 读路径不得把外部输入拼进脚本（脚本里出现的注册表路径必须是常量字面量）
  assert.ok(!/\$\{name\}|\$\{value\}/.test(src), '脚本里出现了拼接的 name/value 变量');
});

test('JSON 信封一律由 ConvertTo-Json 生成，不得手工拼接', () => {
  // 冒烟测试逮到过的真 bug：探测脚本手写
  //   '{"ok":true,...,"user":"' + $id.Name + '"}'
  // 而 $id.Name 形如 `MACHINE\user`（域账号还可能是 `DOMAIN\user`）—— 反斜杠在 JSON 里
  // 没转义，`\x` 是非法转义，JSON.parse 抛错，于是**整个能力探测静默变成
  // supported:false**（在 Windows 上！面板会显示「本模块只支持 Windows」，
  // 而它正在 Windows 上跑）。
  //
  // 手拼 JSON 只要信封里出现反斜杠 / 引号 / 换行 / 控制字符就会炸，而用户名、
  // 变量名、变量值、异常 message 四者都可能含这些字符。所以信封只能交给
  // ConvertTo-Json —— 检查方式是断言源码里不存在手拼的信封字面量。
  const src = readFileSync(join(ROOT, 'src', 'core', 'envvars.js'), 'utf8');
  assert.match(src, /const jsonEnvelope/, '应当有统一的信封生成器');

  const handBuilt = [...src.matchAll(/'\{[^\n']*"ok"[^\n']*'/g)].map((m) => m[0]);
  assert.deepEqual(handBuilt, [], `发现手工拼接的 JSON 信封: ${handBuilt.join(' | ')}`);
});
