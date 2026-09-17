// 路径与常量的唯一权威来源。
import { homedir } from 'node:os';
import { join } from 'node:path';
import { badInput } from './errors.js';

export const APP_NAME = 'nx-rh';
export const APP_DIR = join(homedir(), '.nx-rh');
export const STORE_PATH = join(APP_DIR, 'store.json');
// 环境变量快照：每次写注册表之前自动落一份，可回滚。
// 与 store.json 同处 ~/.nx-rh/，但单独一个目录——快照会累积（保留最近若干份），
// 混在配置目录里会让「这是配置还是备份」变得分不清。
export const ENV_SNAPSHOT_DIR = join(APP_DIR, 'env_snapshots');
export const DEFAULT_PORT = 7800;

export function envSnapshotDir() {
  return ENV_SNAPSHOT_DIR;
}

// 允许测试与多实例覆盖存储位置：NX_RH_STORE 环境变量优先
export function storePathFromEnv() {
  return process.env.NX_RH_STORE || STORE_PATH;
}

// 名称安全校验：拒绝路径穿越（保留中文等合法命名，与 fileops.go 语义一致）。
//
// 用于「这个字符串会被用作**目录名**」的场景：skill 名、内置包名、适配器 id。
// 因此拒绝前导点——避免意外生成隐藏目录。
// 注意：文件路径不要用这个，用下面的 assertSafeRelPath——像 .gitignore 这样的
// 文件名是合法且常见的，用名称规则去卡它会把正常文件挡在门外。
export function assertSafeName(name, label = 'skill 名称') {
  if (!name || typeof name !== 'string' || /[\\/]/.test(name) || name.includes('..') || name.startsWith('.')) {
    throw badInput('非法 ' + label + ': ' + name);
  }
  return name;
}

// 相对路径校验：一切来自外部的「某个目录内的文件路径」都要过这里。
// 允许子目录（git 的 --file 常带路径）与前导点（.gitignore / .github/workflows/x.yml）。
// 拒绝绝对路径与 .. 段——历史上 applySkillSide 做了这类校验而 gitResolve/gitDiff 没做，
// 同一类输入校验强度不一致，本身就是可乘之口。
//
// 返回**归一化后**的路径（折叠重复分隔符、去掉 './' 段），调用方应使用返回值。
export function assertSafeRelPath(input, { label = '文件路径', allowSubdir = true } = {}) {
  if (!input || typeof input !== 'string') throw badInput(label + '不能为空');
  if (/^([a-zA-Z]:|[\\/])/.test(input)) throw badInput(label + '必须是相对路径: ' + input);

  const segments = input.split(/[\\/]+/).filter((x) => x !== '' && x !== '.');
  if (!segments.length) throw badInput('非法 ' + label + ': ' + input);
  if (segments.includes('..')) throw badInput(label + '不得包含 ..: ' + input);
  if (!allowSubdir && segments.length > 1) {
    throw badInput(label + '不能包含路径分隔符: ' + input);
  }
  return segments.join('/');
}
