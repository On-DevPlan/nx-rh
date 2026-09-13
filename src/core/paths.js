// 路径与常量的唯一权威来源。
import { homedir } from 'node:os';
import { join } from 'node:path';

export const APP_NAME = 'nx-rh';
export const APP_DIR = join(homedir(), '.nx-rh');
export const STORE_PATH = join(APP_DIR, 'store.json');
export const DEFAULT_PORT = 7800;

// 允许测试与多实例覆盖存储位置：NX_RH_STORE 环境变量优先
export function storePathFromEnv() {
  return process.env.NX_RH_STORE || STORE_PATH;
}
