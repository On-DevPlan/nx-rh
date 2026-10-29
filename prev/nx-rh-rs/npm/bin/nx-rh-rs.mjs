#!/usr/bin/env node
// nx-rh-rs 的 npm 壳：定位平台包里的原生二进制并转发 argv。
//
// 形态与 esbuild / biome / turbo 一致：主包只有这几十行，
// 各平台的二进制住在独立的 optionalDependencies 包里（npm 按 os/cpu 自动装）。
// 二进制不随主包分发——所以主包永远只有几十 KB。
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

// 平台 → 平台包名（与 Cargo.toml 的 target 一一对应）
const PLATFORM = `${process.platform}-${process.arch}`;

function candidates() {
  // 1) 环境变量直指（排障用）
  if (process.env.NX_RH_RS_BIN) return [process.env.NX_RH_RS_BIN];
  // 2) 平台包
  const pkg = `nx-rh-rs-${PLATFORM}`;
  try {
    const p = require.resolve(`${pkg}/package.json`);
    return [join(dirname(p), 'bin', 'nx-rh-rs' + (process.platform === 'win32' ? '.exe' : ''))];
  } catch {
    /* 平台包装不上：落到下面的兜底 */
  }
  // 3) 同目录（本地开发：cargo build 后直接把 exe 放这）
  const here = dirname(fileURLToPath(import.meta.url));
  return [join(here, 'nx-rh-rs' + (process.platform === 'win32' ? '.exe' : ''))];
}

const bin = candidates().find((p) => existsSync(p));
if (!bin) {
  console.error(
    `nx-rh-rs: 找不到本平台的二进制（${PLATFORM}）。\n` +
      `请检查 npm 是否装上了平台包 nx-rh-rs-${PLATFORM}。`
  );
  process.exit(1);
}

const r = spawnSync(bin, process.argv.slice(2), { stdio: 'inherit' });
if (r.error) {
  console.error('nx-rh-rs: 启动失败 — ' + r.error.message);
  process.exit(1);
}
process.exit(r.status ?? 0);
