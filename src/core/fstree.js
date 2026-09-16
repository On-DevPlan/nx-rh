// 文件系统原语：存在性判定、内容摘要、目录树遍历与逐文件差异。
// 零业务语义——skill 同步（两侧目录比较）与内置包安装（包内目录比较）共用同一套。
//
// 从 services/skills.js 下沉而来：这些函数被 bundled.js 跨模块使用，
// 原本造成 service 之间的横向依赖，属于通用能力。
import { join } from 'node:path';
import fsp from 'node:fs/promises';
import { createHash } from 'node:crypto';

// access 判存在。**是否穿透链接由操作系统决定**，不是一个可靠的判据：
// POSIX 上悬空 symlink 返回 false，而 Windows 上悬空 junction 返回 true。
// 因此凡是「必须认出悬空链接」的场合一律用 pathExists，不要用这个。
export async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

// lstat 判存在：不跟随链接，看的是链接本身。
// 悬空链接（目标已被删）也算「存在」——这正是它被需要的原因：
// 中心侧删掉 skill 后，项目侧的链接要能被列出来并删除，否则就成了删不掉的幽灵。
export async function pathExists(p) {
  try {
    await fsp.lstat(p);
    return true;
  } catch {
    return false;
  }
}

export function md5Of(buf) {
  return createHash('md5').update(buf).digest('hex');
}

// 递归收集目录下所有文件：rel 路径 -> { abs, md5, size }
export async function walkFiles(root) {
  const files = new Map();
  async function walk(dir, rel) {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const abs = join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(abs, r);
      else if (e.isFile()) {
        const buf = await fsp.readFile(abs).catch(() => null);
        if (buf === null) continue;
        files.set(r, { abs, md5: md5Of(buf), size: buf.length });
      }
    }
  }
  await walk(root, '');
  return files;
}

// 两棵目录树的差异：逐文件 md5 比较。
// side 语义固定为 a 侧视角：only-central=仅 a 有 / only-project=仅 b 有 / both-differ=两侧都有但不同。
// 命名沿用「中心 vs 项目」场景，调用方按 a=基准侧 理解即可。
// 注意：bRoot 不存在时视为空树（bundled.js 用不存在的路径当哨兵来列出全部文件）。
export async function diffTrees(aRoot, bRoot) {
  const [a, b] = await Promise.all([walkFiles(aRoot), walkFiles(bRoot)]);
  const out = [];
  for (const [rel, fa] of a) {
    const fb = b.get(rel);
    if (!fb) out.push({ file: rel, side: 'only-central' });
    else if (fa.md5 !== fb.md5) out.push({ file: rel, side: 'both-differ' });
  }
  for (const [rel] of b) {
    if (!a.has(rel)) out.push({ file: rel, side: 'only-project' });
  }
  return out;
}
