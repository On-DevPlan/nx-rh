// 远程源规格解析：把用户给的一个字符串认成 { type, url, ref?, subpath? }。
//
// 移植自 vercel-labs/skills（https://github.com/vercel-labs/skills，MIT License，
// src/source-parser.ts），按本仓库需要裁剪：去掉 source 别名、GH_HOST 企业宿主、
// well-known provider 与 @skill 过滤——那些服务于它的注册表生态，这里只需要
// 「git 仓库」与「直接下载」两类。file:// 是本仓库自加（本地夹具与测试用）。
//
// 返回形状：
//   { type: 'local',  localPath }            —— 调用方走原有本地订阅流程
//   { type: 'git',    url, ref?, subpath? }  —— git clone（github/gitlab/ssh/file）
//   { type: 'download', url }                —— 单个 SKILL.md 或 zip/tar.gz 归档
import { isAbsolute, resolve } from 'node:path';
import { badInput } from '../../../core/errors.js';

// 与 skills CLI 同思路（sanitizeSubpath）：子路径拒绝 .. 段，防仓库外穿越
export function sanitizeSubpath(subpath) {
  const normalized = subpath.replace(/\\/g, '/');
  for (const segment of normalized.split('/')) {
    if (segment === '..') {
      throw badInput('不安全的子路径: ' + subpath + '（不得包含 ..）');
    }
  }
  return subpath;
}

function isLocalPath(input) {
  return (
    isAbsolute(input) ||
    input.startsWith('./') ||
    input.startsWith('../') ||
    input === '.' ||
    input === '..' ||
    /^[a-zA-Z]:[/\\]/.test(input)
  );
}

// git 形态的源才把 #片段 当 ref（owner/repo#v1）。普通下载 URL 的 # 是服务端语义，不动它。
function looksLikeGitSource(input) {
  if (input.startsWith('git@') || input.startsWith('ssh://') || input.startsWith('file://')) return true;
  if (/^https?:\/\/.+\.git(?:$|[/?#])/i.test(input)) return true;
  if (/^github\.com\//.test(input) || /^gitlab\.com\//.test(input)) return true;
  // owner/repo 简写（可带 /子路径），不含 : 、不以 . 或 / 开头
  return (
    !input.includes(':') &&
    !input.startsWith('.') &&
    !input.startsWith('/') &&
    /^([^/]+)\/([^/]+)(\/.*)?$/.test(input)
  );
}

function parseFragmentRef(input) {
  const hashIndex = input.indexOf('#');
  if (hashIndex < 0) return { inputWithoutFragment: input };
  const inputWithoutFragment = input.slice(0, hashIndex);
  const fragment = input.slice(hashIndex + 1);
  if (!fragment || !looksLikeGitSource(inputWithoutFragment)) {
    return { inputWithoutFragment: input };
  }
  return { inputWithoutFragment, ref: fragment };
}

// 托管的归档 / 原始文件 URL（github archive、raw、release 资产等）必须直接下载，
// 不能归一化回父仓库去 clone
function isHostedArtifactUrl(input) {
  try {
    const parsed = new URL(input);
    const host = parsed.hostname.toLowerCase();

    if (
      host === 'raw.githubusercontent.com' ||
      host === 'codeload.github.com' ||
      host === 'objects.githubusercontent.com'
    ) {
      return true;
    }
    if (host === 'github.com') {
      return /^\/[^/]+\/[^/]+\/(?:archive\/|raw\/|releases\/(?:download\/|latest\/download\/))/.test(
        parsed.pathname
      );
    }
    if (host === 'gitlab.com') {
      return /\/-\/(?:archive|raw)\//.test(parsed.pathname);
    }
    return false;
  } catch {
    return false;
  }
}

export function parseSource(input) {
  if (!input || typeof input !== 'string') throw badInput('源规格不能为空');
  input = input.trim();
  if (!input) throw badInput('源规格不能为空');

  // 本地路径：绝对 / 相对（Windows 盘符含在其中）
  if (isLocalPath(input)) {
    const resolvedPath = resolve(input);
    return { type: 'local', url: resolvedPath, localPath: resolvedPath };
  }

  // file:// 本地 git 仓库（测试夹具 / 内网裸仓库）。支持 #ref：file URL 的
  // fragment 不会传给 git，先剥出来当 ref（file:///repo#branch 这种写法要能用）。
  if (input.startsWith('file://')) {
    const hash = input.indexOf('#');
    if (hash < 0) return { type: 'git', url: input };
    return { type: 'git', url: input.slice(0, hash), ref: input.slice(hash + 1) };
  }

  const { inputWithoutFragment, ref: fragmentRef } = parseFragmentRef(input);
  input = inputWithoutFragment;

  // github:owner/repo 与 gitlab:owner/repo 前缀简写
  const githubPrefix = input.match(/^github:(.+)$/);
  if (githubPrefix) return parseSource(githubPrefix[1] + (fragmentRef ? '#' + fragmentRef : ''));
  const gitlabPrefix = input.match(/^gitlab:(.+)$/);
  if (gitlabPrefix) {
    return parseSource('https://gitlab.com/' + gitlabPrefix[1] + (fragmentRef ? '#' + fragmentRef : ''));
  }

  if (isHostedArtifactUrl(input)) {
    return { type: 'download', url: input };
  }

  // GitHub URL 带子路径：.../owner/repo/tree/branch/path/to/skills
  const githubTreeWithPath = input.match(/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+)/);
  if (githubTreeWithPath) {
    const [, owner, repo, ref, subpath] = githubTreeWithPath;
    return {
      type: 'git',
      url: 'https://github.com/' + owner + '/' + repo + '.git',
      ref: ref || fragmentRef,
      subpath: subpath ? sanitizeSubpath(subpath.replace(/\/+$/, '')) : subpath,
    };
  }

  // GitHub URL 只带分支：.../owner/repo/tree/branch
  const githubTree = input.match(/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)$/);
  if (githubTree) {
    const [, owner, repo, ref] = githubTree;
    return {
      type: 'git',
      url: 'https://github.com/' + owner + '/' + repo + '.git',
      ref: ref || fragmentRef,
    };
  }

  // GitHub 仓库 URL：.../owner/repo（可带 .git）
  const githubRepo = input.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)/);
  if (githubRepo) {
    const [, owner, repo] = githubRepo;
    return {
      type: 'git',
      url: 'https://github.com/' + owner + '/' + repo.replace(/\.git$/, '') + '.git',
      ...(fragmentRef ? { ref: fragmentRef } : {}),
    };
  }

  // GitLab URL 带子路径（/-/tree/branch/path，任意 GitLab 实例，支持子组）
  const gitlabTreeWithPath = input.match(/^(https?):\/\/([^/]+)\/(.+?)\/-\/tree\/([^/]+)\/(.+)/);
  if (gitlabTreeWithPath) {
    const [, protocol, hostname, repoPath, ref, subpath] = gitlabTreeWithPath;
    if (hostname !== 'github.com' && repoPath) {
      return {
        type: 'git',
        url: protocol + '://' + hostname + '/' + repoPath.replace(/\.git$/, '') + '.git',
        ref: ref || fragmentRef,
        subpath: subpath ? sanitizeSubpath(subpath.replace(/\/+$/, '')) : subpath,
      };
    }
  }

  // GitLab URL 只带分支
  const gitlabTree = input.match(/^(https?):\/\/([^/]+)\/(.+?)\/-\/tree\/([^/]+)$/);
  if (gitlabTree) {
    const [, protocol, hostname, repoPath, ref] = gitlabTree;
    if (hostname !== 'github.com' && repoPath) {
      return {
        type: 'git',
        url: protocol + '://' + hostname + '/' + repoPath.replace(/\.git$/, '') + '.git',
        ref: ref || fragmentRef,
      };
    }
  }

  // gitlab.com 仓库（支持嵌套子组）
  const gitlabRepo = input.match(/^https?:\/\/gitlab\.com\/(.+?)(?:\.git)?\/?$/);
  if (gitlabRepo && gitlabRepo[1].includes('/')) {
    return {
      type: 'git',
      url: 'https://gitlab.com/' + gitlabRepo[1] + '.git',
      ...(fragmentRef ? { ref: fragmentRef } : {}),
    };
  }

  // owner/repo 简写（可带 /子路径），默认 GitHub
  const shorthand = input.match(/^([^/]+)\/([^/]+)(?:\/(.+?))?\/?$/);
  if (shorthand && !input.includes(':') && !input.startsWith('.') && !input.startsWith('/')) {
    const [, owner, repo, subpath] = shorthand;
    return {
      type: 'git',
      url: 'https://github.com/' + owner + '/' + repo.replace(/\.git$/, '') + '.git',
      ...(fragmentRef ? { ref: fragmentRef } : {}),
      subpath: subpath ? sanitizeSubpath(subpath) : subpath,
    };
  }

  // git@ SSH（git@host:owner/repo.git）与 ssh://
  if (input.startsWith('git@') || input.startsWith('ssh://')) {
    return { type: 'git', url: input, ...(fragmentRef ? { ref: fragmentRef } : {}) };
  }

  // 其它 .git 结尾的 http(s) URL：任意 git 宿主
  if (/^https?:\/\/.+\.git(?:$|[/?#])/i.test(input)) {
    return { type: 'git', url: input, ...(fragmentRef ? { ref: fragmentRef } : {}) };
  }

  // 剩下的 http(s) 一律按直接下载处理（单个 SKILL.md 或归档）
  if (/^https?:\/\//i.test(input)) {
    return { type: 'download', url: input };
  }

  throw badInput('无法识别的源规格: ' + input + '（支持本地路径、owner/repo、git URL、归档 URL）');
}

// 源标识 → 落地目录名：host--owner--repo[--子路径]，Windows 安全字符，长度截断。
// 同一仓库的不同子路径是**不同的源**（内容集不同），目录名必须可区分。
export function remoteSourceId(parsed) {
  let base;
  if (parsed.type === 'download') {
    try {
      const u = new URL(parsed.url);
      base = u.hostname + '/' + u.pathname.replace(/\/+$/, '');
    } catch {
      base = parsed.url;
    }
  } else {
    const ssh = parsed.url.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
    if (ssh) {
      base = ssh[1] + '/' + ssh[2];
    } else {
      try {
        const u = new URL(parsed.url);
        base = u.hostname + '/' + u.pathname.replace(/^\/+/, '').replace(/\.git$/, '').replace(/\/+$/, '');
      } catch {
        base = parsed.url;
      }
    }
  }
  let id = base
    .replace(/[\\/:*?"<>|]/g, '/') // Windows 目录名禁用字符归一成分隔符
    .split('/')
    .filter(Boolean)
    .join('--');
  if (parsed.subpath) id += '--' + parsed.subpath.replace(/[\\/:*?"<>|]/g, '--');
  // NTFS 完整路径 260 限制很近，目录名本身留 80 字符
  if (id.length > 80) id = id.slice(0, 80);
  if (!id) throw badInput('无法从源推导目录名: ' + parsed.url);
  return id;
}
