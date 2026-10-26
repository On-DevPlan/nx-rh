// 远程订阅源：把外部 skill 仓库（git）或归档/单文件 URL 拉到本机自有目录，
// 注册为**普通订阅源**——此后 list/show/migrate 走的全是既有本地流程。
//
// 移植自 vercel-labs/skills（https://github.com/vercel-labs/skills，MIT License）：
// 源解析（src/source-parser.ts → remote-parse.js）、zip 解包（src/archive.ts →
// core/archive.js）、clone 错误分类与 SHA 检出（src/git.ts，simple-git 换成本仓库
// 零依赖的 execFile 直调）、下载限额思路（README「Direct download URLs」节）。
//
// 落地契约：
// - 内容只进 ~/.nx-rh/remote-skills/<id>/（remoteSkillsDir()），绝不写平台目录
// - 重复订阅同一源 = 原地刷新（staging 目录成功后原子换入），幂等
// - 元数据记在 store.remoteSources（R2 的 sync 按它对比哈希）
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fsp from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { remoteSkillsDir, assertSafeName } from '../../../core/paths.js';
import { badInput, external, notFound } from '../../../core/errors.js';
import { loadStore, mutateStore } from '../../../core/store.js';
import { readArchive } from '../../../core/archive.js';
import { parseFrontmatter } from '../../../core/frontmatter.js';
import { parseSource, remoteSourceId } from './remote-parse.js';
import { snapshotSkills } from './scan.js';
import { addCandidate } from '../../settings/service.js';

const execFileAsync = promisify(execFile);

// 限额：与 skills CLI 同默认值（10 MiB 下载 / 25 MiB 解出 / 1000 文件），env 可覆写
const MiB = 1024 * 1024;
export function remoteLimits() {
  const int = (name, dflt) => {
    const v = Number.parseInt(process.env[name] || '', 10);
    return Number.isFinite(v) && v > 0 ? v : dflt;
  };
  return {
    maxDownloadBytes: int('NX_RH_REMOTE_MAX_BYTES', 10 * MiB),
    maxExtractedBytes: int('NX_RH_REMOTE_MAX_EXTRACTED', 25 * MiB),
    maxEntries: int('NX_RH_REMOTE_MAX_FILES', 1000),
    cloneTimeoutMs: int('NX_RH_CLONE_TIMEOUT_MS', 300_000),
  };
}

// ─── git clone（github / gitlab / 任意宿主 / ssh / file://） ──────────
// 判据字符串来自 git 客户端与 upload-pack（GitHub / GitLab / 自建 git 一致），
// 移植自 skills src/git.ts 的 isMissingRefError。
function isMissingRefError(message) {
  return (
    /Remote branch .* not found in upstream origin/i.test(message) ||
    /couldn't find remote ref/i.test(message) ||
    /upload-pack: not our ref/i.test(message)
  );
}

function isAuthError(message) {
  return /Authentication failed|Permission denied|could not read Username|Repository not found/i.test(message);
}

function isCommitSha(ref) {
  return /^[0-9a-f]{40}$/i.test(ref);
}

async function runGit(args, { cwd } = {}) {
  try {
    return await execFileAsync('git', args, {
      cwd,
      timeout: remoteLimits().cloneTimeoutMs,
      windowsHide: true,
    });
  } catch (err) {
    const message = String((err && err.stderr) || err.message || err);
    if (isAuthError(message)) {
      throw external('git 认证/权限失败（私有仓库请先配置凭据）: ' + message.trim().slice(0, 300));
    }
    if (isMissingRefError(message)) {
      throw badInput('远程分支/标签不存在: ' + message.trim().slice(0, 300));
    }
    throw external('git 失败（git ' + args.join(' ').slice(0, 80) + '…）: ' + message.trim().slice(0, 300));
  }
}

// --branch 只认分支/标签名；裸 40 位 SHA 走 init+fetch+checkout（需服务端开
// uploadpack.allowReachableSHA1InWant，GitHub 与 GitLab.com 都开）
async function cloneRepo(url, ref, targetDir) {
  if (!ref) {
    await runGit(['clone', '--depth', '1', '--', url, targetDir]);
    return;
  }
  if (!isCommitSha(ref)) {
    await runGit(['clone', '--depth', '1', '--branch', ref, '--', url, targetDir]);
    return;
  }
  await runGit(['init', '--quiet', targetDir]);
  await runGit(['remote', 'add', 'origin', url], { cwd: targetDir });
  try {
    await runGit(['fetch', '--depth', '1', 'origin', ref], { cwd: targetDir });
  } catch (err) {
    // 服务器拒绝按 SHA fetch：给用户能懂的原因，而不是一串 upload-pack 输出
    if (isMissingRefError(String(err.message))) {
      throw badInput('提交 SHA 拉取被服务端拒绝（未开 allowReachableSHA1InWant）: ' + ref);
    }
    throw err;
  }
  await runGit(['checkout', '--quiet', 'FETCH_HEAD'], { cwd: targetDir });
}

// ─── 直接下载（单 SKILL.md 或 zip/tar.gz 归档） ─────────────────────
async function downloadBytes(url) {
  const { maxDownloadBytes } = remoteLimits();
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(60_000), redirect: 'follow' });
  } catch (err) {
    throw external('下载失败: ' + url + '（' + String(err.message || err).slice(0, 200) + '）');
  }
  if (!res.ok) throw external('下载失败 HTTP ' + res.status + ': ' + url);
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > maxDownloadBytes) {
    throw badInput('下载体超过上限 ' + maxDownloadBytes + ' 字节（' + declared + '），如信任来源可设 NX_RH_REMOTE_MAX_BYTES 覆写');
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > maxDownloadBytes) {
    throw badInput('下载体超过上限 ' + maxDownloadBytes + ' 字节，如信任来源可设 NX_RH_REMOTE_MAX_BYTES 覆写');
  }
  return buf;
}

// 归档条目统一剥掉单一顶层目录（github archive 的 repo-<sha>/ 外壳）
function stripCommonRoot(files) {
  const names = [...files.keys()].filter((n) => !n.endsWith('/'));
  if (!names.length) return files;
  const first = names[0].split('/')[0];
  if (!first) return files;
  if (!names.every((n) => n === first || n.startsWith(first + '/'))) return files;
  const out = new Map();
  for (const [name, data] of files) {
    const stripped = name === first + '/' ? '' : name.slice(first.length + 1);
    if (stripped) out.set(stripped, data);
  }
  return out;
}

async function writeFiles(dir, files) {
  for (const [name, data] of files) {
    if (name.endsWith('/')) continue;
    const target = join(dir, name);
    await fsp.mkdir(dirname(target), { recursive: true });
    await fsp.writeFile(target, data);
  }
}

// 单文件下载必须长得像 SKILL.md（带 name/description frontmatter），
// 否则当归档解析失败时给的可执行建议就是错的
function skillNameFromMarkdown(raw, url) {
  const fm = parseFrontmatter(String(raw));
  if (fm && fm.name) {
    try {
      return assertSafeName(fm.name, 'SKILL.md 里的 name');
    } catch {
      // frontmatter 里的名字不安全时退回 URL 推导，不让整个订阅失败
    }
  }
  const file = (url.split('/').pop() || '').replace(/\.(md|markdown|txt)$/i, '');
  try {
    return assertSafeName(file);
  } catch {
    return 'downloaded-skill';
  }
}

async function downloadSource(url, targetDir) {
  const buf = await downloadBytes(url);
  const limits = remoteLimits();
  const isZip = buf.length >= 4 && buf.readUInt32BE(0) === 0x504b0304;
  const isGzip = buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
  if (isZip || isGzip) {
    let files;
    try {
      files = readArchive(buf, limits);
    } catch (err) {
      throw badInput('归档解析失败: ' + String(err.message || err).slice(0, 300));
    }
    await writeFiles(targetDir, stripCommonRoot(files));
    return targetDir;
  }
  // 非归档：按单个 SKILL.md 处理，包一层以 skill 名命名的目录。
  // 源始终是 targetDir（含 <name>/ 子目录的那层）——订阅源的 skills 根
  // 靠「一级子目录里有 SKILL.md」识别，skill 目录本身不能当源。
  const name = skillNameFromMarkdown(buf.toString('utf8'), url);
  await fsp.mkdir(join(targetDir, name), { recursive: true });
  await fsp.writeFile(join(targetDir, name, 'SKILL.md'), buf);
  return targetDir;
}

// ─── 订阅主流程 ────────────────────────────────────────────────────

// 解析但不落地：subscribe action 用它分流本地/远程（null = 本地路径）
export function peekRemote(spec) {
  const parsed = parseSource(spec);
  return parsed.type === 'local' ? null : parsed;
}

// 远程源元数据（store.remoteSources）：sourceDir → { spec, url, type, ref, subpath, skills, fetchedAt }
export async function remoteMetaMap() {
  const s = await loadStore();
  return s.remoteSources || {};
}

// 拉取到 staging：不动最终目录、不注册——sync 的 --dry-run 靠它对比后弃置。
export async function materializeRemote(parsed) {
  const id = remoteSourceId(parsed);
  const baseDir = remoteSkillsDir();
  const staging = join(baseDir, '.' + id + '.staging');
  await fsp.rm(staging, { recursive: true, force: true });
  await fsp.mkdir(baseDir, { recursive: true });

  let sourceDir;
  if (parsed.type === 'git') {
    await cloneRepo(parsed.url, parsed.ref, staging);
    if (parsed.subpath) {
      const sub = join(staging, parsed.subpath);
      if (!(await fsp.stat(sub).catch(() => null))) {
        await fsp.rm(staging, { recursive: true, force: true });
        throw notFound('仓库里没有这个子路径: ' + parsed.subpath + '（' + parsed.url + '）');
      }
      sourceDir = sub;
    } else {
      sourceDir = staging;
    }
  } else {
    sourceDir = await downloadSource(parsed.url, staging);
  }
  return { id, staging, sourceDir };
}

// staging → 最终目录的原子换入 + 注册 + 元数据落盘。
// skills 快照（{ [skill名]: 目录指纹 }）此刻记下——它是下次 sync 的对比基准。
export async function commitRemote(parsed, staging, sourceDir, skillsSnapshot) {
  const id = remoteSourceId(parsed);
  const finalDir = join(remoteSkillsDir(), id);
  await fsp.rm(finalDir, { recursive: true, force: true });
  // sourceDir 可能是 staging 里的子路径：换入的是**整份 staging**，
  // 注册路径按同一段相对位移映射到 finalDir
  const rel = sourceDir.slice(staging.length).replace(/^[\\/]/, '');
  await fsp.rename(staging, finalDir);
  const registered = rel ? join(finalDir, rel) : finalDir;

  await addCandidate('hub', registered);
  const fetchedAt = new Date().toISOString();
  const meta = {
    spec: parsed.spec || parsed.url,
    type: parsed.type,
    url: parsed.url,
    ...(parsed.ref ? { ref: parsed.ref } : {}),
    ...(parsed.subpath ? { subpath: parsed.subpath } : {}),
    id,
    fetchedAt,
    ...(skillsSnapshot ? { skills: skillsSnapshot } : {}),
  };
  await mutateStore((s) => {
    s.remoteSources = s.remoteSources || {};
    // 旧落位（如 id 推导调整后变了）清掉登记，避免累积孤儿元数据
    for (const [k, v] of Object.entries(s.remoteSources)) {
      if (v && v.id === id && k !== registered) delete s.remoteSources[k];
    }
    s.remoteSources[registered] = meta;
    return meta;
  });
  return { registered, meta };
}

export async function subscribeRemote(spec) {
  const parsed = parseSource(spec);
  if (parsed.type === 'local') {
    throw badInput('本地路径请直接 skill hub subscribe <path>（远程订阅收 owner/repo、git URL、归档 URL）');
  }
  parsed.spec = spec;
  const { id, staging, sourceDir } = await materializeRemote(parsed);
  const snapshot = await snapshotSkills(sourceDir);
  const { registered } = await commitRemote(parsed, staging, sourceDir, snapshot);
  return {
    spec,
    remote: true,
    id,
    dir: registered,
    url: parsed.url,
    ref: parsed.ref || '',
    count: Object.keys(snapshot).length,
    fetchedAt: new Date().toISOString(),
  };
}
