// 版本检测：判断远程订阅里的 skill 上游有没有新版本。
//
// **只读不换盘**——这是它与 svc/remote-repo.js 的 updateRemote 的根本分工：
// update 边检查边替换实体，check 只回答「有没有更新」。
// plan/07 的 R2 评审判定「待更新徽标 / 检查更新按钮」建立在不存在的
// check-only 能力上，本文件补的就是这个缺口。
//
// 判定精度：**目录级**，不是仓库级、不是提交级。
// 移植自 vercel-labs/skills（https://github.com/vercel-labs/skills，MIT）：
//   - src/git.ts:getGitTreeHash  → git rev-parse HEAD:<目录>  取树对象 SHA
//   - src/blob.ts:getSkillFolderHashFromTree → 从 GitHub Trees API 的 tree 里
//     取同一个目录条目的 sha（两者是**同一个值**，所以两条路径可直接比较）
//   - src/update.ts 的分组检查（按 source + ref 分组，一源只拉一次）
//
// 相对上游的增量：**git ls-remote 快路径**。
// 上游每次 check 都 clone 整个仓库；这里先用 ls-remote 拿上游 HEAD 的 commit，
// 与台账里记的上次 commit 相同就直接判「最新」——不克隆、不下载，秒级出结果。
// commit 变了才拉一份算目录级 tree SHA（贵但精确）。
//
// 依赖序：version ← remote-repo（读台账）← remote（拉取原语）。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { relative, sep } from 'node:path';
import fsp from 'node:fs/promises';
import { loadStore, mutateStore } from '../../../core/store.js';
import { external } from '../../../core/errors.js';
import { parseSource } from './remote-parse.js';
import { materializeRemote } from './remote.js';
import { skillDirHash } from './scan.js';

const execFileAsync = promisify(execFile);

// 状态取值：
//   up-to-date —— 上游与本地一致
//   outdated   —— 上游有更新（目录级 tree SHA 不同）
//   removed    —— 上游已没有这个 skill
//   unknown    —— 上游可访问，但这个 skill 的指纹取不到（结构变了 / 路径挪了）
//   skipped    —— 没有上游可比（手写定义 / 遗留软链）
//   error      —— 上游不可访问（认证失败 / 网络不通 / 仓库不存在）
export const VERSION_STATUS = {
  UP_TO_DATE: 'up-to-date',
  OUTDATED: 'outdated',
  REMOVED: 'removed',
  UNKNOWN: 'unknown',
  SKIPPED: 'skipped',
  ERROR: 'error',
};

// ls-remote / clone 的超时：远程检查不该让面板转圈超过这个时长
const GIT_TIMEOUT_MS = 60_000;

// ─── git 原语 ────────────────────────────────────────────────────────

// ls-remote：拿上游某个 ref 指向的 commit。不克隆，只问远端。
// 返回 { commit, ref }；ref 不存在返回 { commit: '' }（由调用方判成 error）。
async function lsRemote(url, ref) {
  const args = ['ls-remote', '--', url];
  if (ref) args.push(ref);
  else args.push('HEAD');
  try {
    const { stdout } = await execFileAsync('git', args, {
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0', // 无凭据不挂起等终端输入
        GIT_ALLOW_PROTOCOL: 'https:http:ssh:git:file',
      },
    });
    for (const line of String(stdout || '').split(/\r?\n/)) {
      const m = line.match(/^([0-9a-f]{40})\s+(\S+)/i);
      if (m) return { commit: m[1].toLowerCase(), ref: m[2] };
    }
    return { commit: '', ref: '' };
  } catch (err) {
    const msg = String((err && err.stderr) || (err && err.message) || err);
    throw external('git ls-remote 失败: ' + msg.trim().slice(0, 240));
  }
}

// 仓库里某目录的**树对象 SHA**（40 位十六进制）。
//
// 这是「目录级版本」的核心：目录里任何一个文件变了，这个 SHA 就变；
// 目录没动，SHA 就不变。与 vercel-labs 的 getGitTreeHash 逐字同义。
//
// 目录在仓库根时用 HEAD^{tree}（整仓即该目录）；否则 HEAD:<相对路径>。
// --end-of-options 防止路径以 - 开头时被当成选项。
async function treeShaOf(repoDir, relDir) {
  const rev = relDir ? `HEAD:${relDir}` : 'HEAD^{tree}';
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repoDir, 'rev-parse', '--verify', '--end-of-options', rev],
      {
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
      }
    );
    const sha = String(stdout || '').trim().toLowerCase();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : '';
  } catch {
    return ''; // 目录不存在（上游挪了 / 删了）
  }
}

// 仓库 HEAD 的 commit SHA
async function headCommit(repoDir) {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repoDir, 'rev-parse', '--verify', '--end-of-options', 'HEAD'],
      { timeout: GIT_TIMEOUT_MS, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }
    );
    const sha = String(stdout || '').trim().toLowerCase();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : '';
  } catch {
    return '';
  }
}

// ─── GitHub Trees API（快路径，与 clone 路径产出的 SHA 完全相同） ──────

// GitHub token：显式环境变量优先。没有就匿名（配额更低，但够用）。
function githubToken() {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
}

// 从 GitHub 仓库 URL 里认出 owner/repo（认不出返回空 → 走 clone 路径）
function githubOwnerRepo(url) {
  const m = String(url || '').match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/|$)/i);
  return m ? { owner: m[1], repo: m[2] } : null;
}

// ─── 上游指纹计算 ────────────────────────────────────────────────────

// 目录相对仓库根的路径（正斜杠）。relDir 空串 = 仓库根。
export function relDirFor(absDir, repoRoot) {
  return toRelDir(absDir, repoRoot);
}

// 目录相对仓库根的路径（正斜杠）。relDir 空串 = 仓库根。
function toRelDir(absDir, repoRoot) {
  const rel = relative(repoRoot, absDir);
  if (!rel || rel === '') return '';
  if (rel.startsWith('..')) return ''; // 不在仓库内（不该发生）
  return rel.split(sep).join('/');
}

// 一个 git 源下，所有已登记 skill 的上游目录指纹。
//
// 产出 { [name]: { sha, relDir } }。sha 为 '' 表示上游没有这个目录。
//
// **两条路径，产出同一个值**：
//   · GitHub Trees API —— 一次调用拿到整棵树，从 tree 里取目录条目的 sha
//   · clone 兜底 —— `git rev-parse HEAD:<目录>` 取同一个树对象
// 所以两者的结论完全可比，API 不可用时退回 clone 不影响判定。
//
// **定位策略**（对齐 vercel-labs/skills src/skill-relocation.ts）：
//   1. 台账有 repoPath → 直接用它（导入时记下的，稳定）
//   2. 没有 → 按**上游原目录名**（skillPath）在上游重新定位——
//      上游改了 frontmatter name 但目录没变时，照样定位得到。
//      老数据（导入时还没记 repoPath）走这条路，不会永远 unknown。
//
// 返回的 scanned 标志：**是否完整扫描过上游仓库**。
//   scanned=true  → 上游没有就是真没有（removed）
//   scanned=false → 没扫全，不能说 removed
//
// 路径基准：树 SHA 相对**仓库根**算，所以 subpath 规格也不受影响。
async function upstreamFingerprints(parsed, entries, { useGithub }) {
  const out = new Map();

  // GitHub 快路径：一次 Trees API 调用给出整棵树
  const ownerRepo = githubOwnerRepo(parsed.url);
  if (useGithub && ownerRepo) {
    const tree = await fetchGithubTree(ownerRepo, parsed.ref);
    if (tree) {
      let allFound = true;
      for (const [, meta] of entries) {
        const relDir = locateInTree(tree, meta);
        if (relDir === null) { allFound = false; break; }
      }
      // 全部定位到了 → API 路径够用（一次请求，不克隆）
      if (allFound) {
        for (const [name, meta] of entries) {
          const relDir = locateInTree(tree, meta);
          out.set(name, {
            sha: treeShaFromEntries(tree, relDir),
            relDir: relDir === null ? '' : relDir,
          });
        }
        // Trees API 的 tree 是完整递归树：路径不在里面 = 上游真没有
        return { fingerprints: out, scanned: true, tree };
      }
      // 有定位不到的（老数据没有 repoPath，且上游目录名与原目录名不同）→
      // 退回 clone 路径：它读 frontmatter，能按 skill 名精确找到。
      // （tree 里只有文件路径，读不到 frontmatter，所以定位不了就克隆一份。）
    }
  }

  // clone 路径：拉一份，先定位再算树对象 SHA
  const { staging, sourceDir } = await materializeRemote(parsed);
  try {
    // 定位：上游仓库里这个 skill 实际在哪个目录（扫全量，读 frontmatter）
    const located = await locateUpstream(sourceDir, entries);

    for (const [name] of entries) {
      const loc = located.get(name);
      const relDir = loc !== undefined && loc !== null ? relDirFor(loc, staging) : '';
      out.set(name, {
        sha: relDir === '' ? '' : await treeShaOf(staging, relDir),
        // 内容指纹：给「老数据没有 folderHash」时做首次判定
        content: loc ? await skillDirHash(loc) : '',
        relDir,
      });
    }
    return { fingerprints: out, scanned: true, commit: await headCommit(staging) };
  } finally {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

// 在 Trees API 的树里定位某个 skill 的目录。
//
// 优先用台账的 repoPath（导入时记下的，稳定）；
// 没有就按**上游原目录名**（skillPath）找——tree 里 `SKILL.md` 的父目录名
// 与之相同即命中（对齐 clone 路径的 skill-relocation 思路）。
//
// 定位不到返回 null（= 上游真没有这个目录）。
function locateInTree(tree, meta) {
  if (meta.repoPath) {
    const p = String(meta.repoPath).replace(/\\/g, '/');
    const i = p.lastIndexOf('/');
    return i < 0 ? '' : p.slice(0, i);
  }
  const want = meta.skillPath ? String(meta.skillPath).replace(/\\/g, '/') : '';
  if (!want) return null;
  // tree 里的 SKILL.md 条目：取父目录名比对
  for (const e of tree.entries) {
    if (!e || e.type !== 'blob') continue;
    const p = String(e.path || '');
    if (!/(^|\/)SKILL\.md$/i.test(p)) continue;
    const i = p.lastIndexOf('/');
    const dir = i < 0 ? '' : p.slice(0, i);
    const base = dir ? dir.split('/').pop() : '';
    if (base === want) return dir;
  }
  return null;
}

// 在上游仓库里定位每个 skill 的实际目录。
//
// 返回 Map<name, 绝对路径>；定位不到的名字不在表里（= 上游真没有了）。
// 匹配顺序：frontmatter name → 原目录名（skillPath）——后者兜住「上游改了 name
// 但目录没动」的情形，那正是 vercel-labs 的 skill-relocation 解决的问题。
async function locateUpstream(sourceDir, entries) {
  const { resolveSkillsRoot, scanSkillsRoot } = await import('./scan.js');
  const root = await resolveSkillsRoot(sourceDir);
  const found = await scanSkillsRoot(root, { realOnly: true });
  const byName = new Map(found.map((s) => [s.name, s.dir]));
  const byDirName = new Map(found.map((s) => [basenameOf(s.dir), s.dir]));

  const out = new Map();
  for (const [name, meta] of entries) {
    const hit = byName.get(name) || byDirName.get(meta.skillPath || '');
    if (hit) out.set(name, hit);
  }
  return out;
}


// GitHub Trees API 的整棵树（一次调用），失败返回 null。
// 返回 { entries, rootSha }：rootSha 是仓库根树的 sha（skill 在仓库根时用它）。
async function fetchGithubTree(ownerRepo, ref) {
  const base = process.env.NX_RH_GITHUB_API || 'https://api.github.com';
  const refQ = encodeURIComponent(ref || 'HEAD');
  const url = `${base}/repos/${ownerRepo.owner}/${ownerRepo.repo}/git/trees/${refQ}?recursive=1`;
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'nx-rh' };
  const token = githubToken();
  if (token) headers.authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(15_000), headers });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let data;
  try {
    data = await res.json();
  } catch {
    return null;
  }
  if (!Array.isArray(data?.tree)) return null;
  const rootSha = typeof data?.sha === 'string' && /^[0-9a-f]{40}$/i.test(data.sha)
    ? data.sha.toLowerCase()
    : '';
  return { entries: data.tree, rootSha };
}

// 从 Trees API 的 tree 里取某目录的 tree SHA
function treeShaFromEntries(tree, relDir) {
  if (!relDir) return tree.rootSha || '';
  const hit = tree.entries.find((e) => e && e.type === 'tree' && e.path === relDir);
  return hit && typeof hit.sha === 'string' && /^[0-9a-f]{40}$/i.test(hit.sha)
    ? hit.sha.toLowerCase()
    : '';
}

// download 类源（归档 / 单文件）：没有 git 树，用内容指纹比对。
// 这与 updateRemote 的换盘判定同一个函数（skillDirHash），所以两边可比。
async function downloadFingerprints(parsed, entries) {
  const out = new Map();
  const { staging, sourceDir } = await materializeRemote(parsed);
  try {
    const { resolveSkillsRoot, scanSkillsRoot } = await import('./scan.js');
    const root = await resolveSkillsRoot(sourceDir);
    const found = await scanSkillsRoot(root, { realOnly: true });
    const byName = new Map(found.map((s) => [s.name, s]));
    const byDir = new Map(found.map((s) => [basenameOf(s.dir), s]));
    for (const [name, meta] of entries) {
      const sk = byName.get(name) || byDir.get(meta.skillPath || '');
      out.set(name, { sha: sk ? await skillDirHash(sk.dir) : '', relDir: '' });
    }
    return { fingerprints: out };
  } finally {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

function basenameOf(p) {
  const parts = String(p || '').split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || '';
}

// ─── 主入口：检查更新 ────────────────────────────────────────────────

// 检查远程订阅里的 skill 有没有新版本。
//
// names 为空 = 全部。返回 { results[], checked, outdated, skipped, errored }。
// **不改磁盘**：只读上游 + 比对台账指纹。
export async function checkRemoteUpdates({ names } = {}) {
  const st = await loadStore();
  const skills = st.remoteRepo?.skills || {};
  const wanted = Array.isArray(names) && names.length ? new Set(names) : null;

  // 按 spec 分组：同一来源只查一次（对齐 vercel-labs 的 source+ref 分组）
  const groups = new Map();
  for (const [name, meta] of Object.entries(skills)) {
    if (wanted && !wanted.has(name)) continue;
    if (!meta.spec) continue; // 没有上游 → skipped，下面单独记
    const key = meta.spec;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push([name, meta]);
  }

  const results = [];
  const commitCache = {};

  for (const [spec, items] of groups) {
    let parsed;
    try {
      parsed = parseSource(spec);
      parsed.spec = spec;
    } catch (err) {
      for (const [name] of items) {
        results.push({
          name, spec, status: VERSION_STATUS.ERROR,
          detail: '无法解析来源规格: ' + String((err && err.message) || err),
        });
      }
      continue;
    }

    try {
      if (parsed.type === 'git') {
        await checkGitSource(spec, parsed, items, st, results, commitCache);
      } else if (parsed.type === 'download') {
        await checkDownloadSource(spec, parsed, items, results);
      } else {
        for (const [name] of items) {
          results.push({ name, spec, status: VERSION_STATUS.SKIPPED, detail: '本地路径不是远程源' });
        }
      }
    } catch (err) {
      const detail = String((err && err.message) || err);
      for (const [name] of items) {
        results.push({ name, spec, status: VERSION_STATUS.ERROR, detail });
      }
    }
  }

  // 没有上游的条目（手写定义 / 遗留软链）
  for (const [name, meta] of Object.entries(skills)) {
    if (wanted && !wanted.has(name)) continue;
    if (meta.spec) continue;
    results.push({
      name, spec: '', status: VERSION_STATUS.SKIPPED,
      detail: meta.link ? '软链，没有自己的上游' : '手写定义，没有上游',
    });
  }

  results.sort((a, b) => a.name.localeCompare(b.name));

  const summary = {
    checked: results.filter((r) => r.status !== VERSION_STATUS.SKIPPED).length,
    outdated: results.filter((r) => r.status === VERSION_STATUS.OUTDATED).length,
    upToDate: results.filter((r) => r.status === VERSION_STATUS.UP_TO_DATE).length,
    removed: results.filter((r) => r.status === VERSION_STATUS.REMOVED).length,
    skipped: results.filter((r) => r.status === VERSION_STATUS.SKIPPED).length,
    errored: results.filter((r) => r.status === VERSION_STATUS.ERROR).length,
  };

  // 缓存结果：面板的「待更新」徽标读它，不必每次点开都联网
  const outdated = results.filter((r) => r.status === VERSION_STATUS.OUTDATED).map((r) => r.name);
  const removed = results.filter((r) => r.status === VERSION_STATUS.REMOVED).map((r) => r.name);
  await mutateStore((s) => {
    s.remoteRepo.lastCheck = {
      at: new Date().toISOString(),
      outdated,
      removed,
      checked: summary.checked,
      summary,
    };
    // commit 缓存：下次同源检查可用 ls-remote 快路径
    for (const [spec, info] of Object.entries(commitCache)) {
      if (!info || !info.commit) continue;
      s.remoteRepo.commits[spec] = { commit: info.commit, checkedAt: new Date().toISOString() };
    }
  });

  return { status: 'ok', results, ...summary };
}

// git 类源的检查：ls-remote 快路径 → commit 变了才拉一份算目录级 tree SHA
async function checkGitSource(spec, parsed, items, st, results, commitCache) {
  const known = st.remoteRepo?.commits?.[spec]?.commit || '';
  const ownerRepo = githubOwnerRepo(parsed.url);

  // 上游 commit：ls-remote 拿（问远端，不克隆）。
  // 拿不到不算失败——GitHub 源还能走 Trees API（同一棵树，结论照样可比）。
  let upstreamCommit = '';
  let lsError = '';
  try {
    upstreamCommit = (await lsRemote(parsed.url, parsed.ref)).commit;
  } catch (err) {
    lsError = String((err && err.message) || err);
  }
  if (upstreamCommit) commitCache[spec] = { commit: upstreamCommit };

  // 快路径：commit 已知且没变 → 这一源下所有 skill 都是最新的，不克隆
  if (upstreamCommit && known && known === upstreamCommit) {
    for (const [name, meta] of items) {
      results.push({
        name, spec, status: VERSION_STATUS.UP_TO_DATE,
        currentHash: meta.folderHash || '',
        latestHash: meta.folderHash || '',
        commit: upstreamCommit,
        detail: '上游提交未变',
      });
    }
    return;
  }

  // commit 变了（或拿不到）：算目录级指纹——精确到「哪个 skill 变了」。
  // upstreamFingerprints 内部先试 GitHub Trees API，不可用则 clone 兜底。
  let fingerprints;
  let scanned = false;
  try {
    const r = await upstreamFingerprints(parsed, items, { useGithub: !!ownerRepo });
    fingerprints = r.fingerprints;
    scanned = !!r.scanned;
    if (r.commit) commitCache[spec] = { commit: r.commit };
  } catch (err) {
    const detail = lsError || String((err && err.message) || err);
    for (const [name] of items) {
      results.push({ name, spec, status: VERSION_STATUS.ERROR, detail });
    }
    return;
  }

  // 把这次定位到的**路径**写回台账。
  //
  // 老数据（导入时还没记 repoPath）靠这一步补齐——补齐后 update 知道该去
  // 上游哪个目录重定位。注意这里**不写指纹**：指纹是判定基准，
  // 提前写就等于拿自己跟自己比，判定会永远「最新」。
  const learned = [];
  for (const [name, meta] of items) {
    const fp = fingerprints.get(name);
    if (!fp) continue;
    const repoPath = fp.relDir ? fp.relDir + '/SKILL.md' : 'SKILL.md';
    if ((meta.repoPath || '') !== repoPath) learned.push({ name, repoPath });
  }
  if (learned.length) {
    await mutateStore((s) => {
      for (const it of learned) {
        const cur = s.remoteRepo.skills?.[it.name];
        if (cur) cur.repoPath = it.repoPath;
      }
    });
    for (const it of learned) {
      for (const [name, meta] of items) {
        if (name === it.name) meta.repoPath = it.repoPath;
      }
    }
  }

  for (const [name, meta] of items) {
    const fp = fingerprints.get(name);
    const latest = fp?.sha || '';
    let current = meta.folderHash || '';
    // 没有上游指纹（老数据）：用上游内容指纹兜底判定一次（与本地副本 hash
    // 同一算法，可比），并如实标出这次是按内容比的。
    let viaContent = false;
    if (!current && fp?.content && meta.hash) {
      current = fp.content;
      viaContent = true;
    }
    if (!latest) {
      // 上游完整扫过 → 查不到就是真没有（removed）
      // 没扫全（只按台账路径查的）→ 路径变了，说 unknown 更诚实
      results.push({
        name, spec,
        status: scanned ? VERSION_STATUS.REMOVED : VERSION_STATUS.UNKNOWN,
        currentHash: current, latestHash: '',
        commit: upstreamCommit,
        detail: scanned
          ? '上游已没有这个 skill（目录不在了）'
          : '按台账路径在上游找不到——可能挪了位置，请重新导入以建立基准',
      });
      continue;
    }
    // 既没有上游指纹、也没有内容可比：如实说「首次比对」，不谎报最新
    if (!current) {
      results.push({
        name, spec, status: VERSION_STATUS.UNKNOWN,
        currentHash: '', latestHash: latest, commit: upstreamCommit,
        detail: '本地没有记录上游指纹，首次比对需重新导入',
      });
      continue;
    }
    const same = latest === current;
    results.push({
      name, spec,
      status: same ? VERSION_STATUS.UP_TO_DATE : VERSION_STATUS.OUTDATED,
      currentHash: current, latestHash: latest, commit: upstreamCommit,
      detail: same ? '已是最新' : '上游有更新',
      ...(viaContent ? { viaContent: true } : {}),
    });
    // 首次判定（老数据）之后，把上游指纹记成基准——下次就有 tree SHA 可比了
    if (viaContent && latest) {
      await mutateStore((s) => {
        const cur = s.remoteRepo.skills?.[name];
        if (cur) cur.folderHash = latest;
      });
    }
  }
}


// download 类源（归档 / 单文件）：重新下载算内容指纹
async function checkDownloadSource(spec, parsed, items, results) {
  let fingerprints;
  try {
    const r = await downloadFingerprints(parsed, items);
    fingerprints = r.fingerprints;
  } catch (err) {
    const detail = String((err && err.message) || err);
    for (const [name] of items) {
      results.push({ name, spec, status: VERSION_STATUS.ERROR, detail });
    }
    return;
  }
  for (const [name, meta] of items) {
    const latest = fingerprints.get(name)?.sha || '';
    const current = meta.folderHash || meta.hash || '';
    if (!latest) {
      results.push({
        name, spec, status: VERSION_STATUS.REMOVED,
        currentHash: current, latestHash: '',
        detail: '上游已没有这个 skill',
      });
      continue;
    }
    if (!current) {
      results.push({
        name, spec, status: VERSION_STATUS.UNKNOWN,
        currentHash: '', latestHash: latest,
        detail: '本地没有记录上游指纹，首次比对需重新导入',
      });
      continue;
    }
    results.push({
      name, spec,
      status: latest === current ? VERSION_STATUS.UP_TO_DATE : VERSION_STATUS.OUTDATED,
      currentHash: current, latestHash: latest,
      detail: latest === current ? '已是最新' : '上游有更新',
    });
  }
}

// ─── 给「导入 / 更新」用的指纹采集（写台账时用） ──────────────────────

// 算一个**已拉好的**上游目录的指纹（导入 / 更新时用——仓库已克隆，不该再克隆一次）。
//
// staging = 仓库根；absDir = 该 skill 在仓库里的实际目录。
// 返回 { sha, relDir }：sha 是目录树对象 SHA（git 源）或内容指纹（download 源）；
// relDir 是它相对仓库根的路径（'' = 在仓库根）。
export async function upstreamFingerprintOf(staging, absDir, parsed) {
  const relDir = relDirFor(absDir, staging);
  if (parsed && parsed.type === 'git') {
    return { sha: await treeShaOf(staging, relDir), relDir };
  }
  return { sha: await skillDirHash(absDir), relDir };
}

// 从**已经拉好的** staging 目录里取上游指纹——导入 / 更新时仓库已经克隆过了，
// 不该为了拿指纹再克隆一次。
//
// staging 是仓库根；skill 目录相对仓库根的路径就是它的 relDir。
// 每个 skill 产出 { sha, relDir, commit }：sha 是目录树对象 SHA（git 源）
// 或内容指纹（download 源）。
export async function fingerprintsFromStaging(staging, sourceDir, items, parsed) {
  const out = new Map();
  const commit = parsed && parsed.type === 'git' ? await headCommit(staging) : '';

  if (parsed && parsed.type === 'git') {
    for (const [name, meta] of items) {
      const relDir = relDirFor(meta.absDir, staging);
      out.set(name, {
        sha: await treeShaOf(staging, relDir),
        relDir,
        commit,
      });
    }
    return { fingerprints: out, commit };
  }

  // download 源：没有 git 树，用内容指纹（与 updateRemote 的换盘判定同源，可比）
  const { resolveSkillsRoot, scanSkillsRoot } = await import('./scan.js');
  const root = await resolveSkillsRoot(sourceDir);
  const found = await scanSkillsRoot(root, { realOnly: true });
  const byName = new Map(found.map((s) => [s.name, s]));
  const byDir = new Map(found.map((s) => [basenameOf(s.dir), s]));
  for (const [name, meta] of items) {
    const sk = byName.get(name) || byDir.get(meta.skillPath || '');
    out.set(name, { sha: sk ? await skillDirHash(sk.dir) : '', relDir: '', commit: '' });
  }
  return { fingerprints: out, commit: '' };
}

// git 仓库 HEAD 的 commit SHA（导入时记进台账，供下次 ls-remote 快路径比对）
export { headCommit };

// 一个 spec 下的上游 commit（ls-remote，失败返回空串）
export async function upstreamCommitOf(spec) {
  try {
    const parsed = parseSource(spec);
    parsed.spec = spec;
    if (parsed.type !== 'git') return '';
    const r = await lsRemote(parsed.url, parsed.ref);
    return r.commit;
  } catch {
    return '';
  }
}
