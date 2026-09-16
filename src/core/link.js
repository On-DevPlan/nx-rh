// 目录链接的创建与识别（移植 vercel-labs/skills installer.ts 的关键防护）。
// 零业务语义——「把目录 A 链接成 B」这件事与 skill 无关，任何同步场景都适用。
import { basename, dirname, join, relative, resolve } from 'node:path';
import fsp from 'node:fs/promises';

// 路径等价判定：Windows 大小写不敏感。纯字面量比较，不做 realpath。
export function samePath(a, b) {
  if (!a || !b) return false;
  const na = resolve(a);
  const nb = resolve(b);
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

// 比较两个路径是否指向同一实体：先各自 realpath 再比。
//
// 为什么需要它：链接目标是用 realpath 形式写入的（见 createSkillLink 的 resolveParentSymlinks），
// 而调用方手里往往还是原始字面量。在 Windows 上 os.tmpdir() 返回 8.3 短名
// （C:\Users\ADMINI~1\...），realpath 却给长名（C:\Users\Administrator\...），
// 直接字符串比较会把同一个目录判成不同 —— 后果是幂等跳过失效，每次同步都白删白建一遍。
//
// 路径不存在时（如链接悬空）realpath 失败，退回字面量比较，此时判为不同是正确的。
export async function sameRealPath(a, b) {
  if (!a || !b) return false;
  const ra = await fsp.realpath(a).catch(() => a);
  const rb = await fsp.realpath(b).catch(() => b);
  return samePath(ra, rb);
}

// 父目录本身是软链时，解析出「真实父目录 + 原文件名」，防止相对链接算错
async function resolveParentSymlinks(p) {
  const abs = resolve(p);
  try {
    return join(await fsp.realpath(dirname(abs)), basename(abs));
  } catch {
    return abs;
  }
}

// 链接类型检测：symlink / junction（启发式与 fileops.go 一致）。
// 用 lstat 判别——readdir 的 dirent 在 Windows 上对 junction 的 isDirectory 可能为 false。
export async function detectLinkType(p) {
  const lst = await fsp.lstat(p).catch(() => null);
  if (!lst) return '';
  if (lst.isSymbolicLink()) return 'symlink';
  if (process.platform === 'win32' && lst.isDirectory()) {
    const st = await fsp.stat(p).catch(() => null);
    if (st && (lst.dev !== st.dev || lst.ino !== st.ino)) return 'junction';
  }
  return '';
}

// 建立链接。返回 { ok, linkType } 或 { ok:false, error }——失败不抛，
// 由调用方决定是降级复制还是上报（skill 同步会降级到 copy，安装不因权限中断）。
export async function createSkillLink(target, linkPath) {
  try {
    const absT = resolve(target);
    const absL = resolve(linkPath);

    // 防自指：双方 realpath 相同视为已就绪（避免 rm -rf 删掉源）
    const realT = await fsp.realpath(absT).catch(() => absT);
    const realL = await fsp.realpath(absL).catch(() => absL);
    if (samePath(realT, realL)) return { ok: true, linkType: '', already: true };

    const realT2 = await resolveParentSymlinks(absT);
    const realL2 = await resolveParentSymlinks(absL);
    if (samePath(realT2, realL2)) return { ok: true, linkType: '', already: true };

    // 清理旧目标：链接只删本体，实体目录递归删除
    try {
      const st = await fsp.lstat(absL);
      if (st.isSymbolicLink()) await fsp.rm(absL, { force: true });
      else await fsp.rm(absL, { recursive: true, force: true });
    } catch {
      // ENOENT：目标不存在，直接创建
    }

    await fsp.mkdir(dirname(absL), { recursive: true });

    if (process.platform === 'win32') {
      // junction 不需要开发者模式/管理员；要求绝对目标
      await fsp.symlink(realT2, absL, 'junction');
      return { ok: true, linkType: 'junction' };
    }
    // POSIX：相对目标，整目录搬迁后链接仍有效
    const rel = relative(await resolveParentSymlinks(dirname(absL)), realT2);
    await fsp.symlink(rel, absL);
    return { ok: true, linkType: 'symlink' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
