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

const isWindows = process.platform === 'win32';
const EXE = isWindows ? '.exe' : '';

// 本平台的候选平台包名（按优先级）。
//
// **不能只拼一个名字**：Windows 上有 msvc 与 gnu 两个包，两者是不同 ABI
// （msvc 依赖 VCRUNTIME140.dll，gnu 静态链接 libgcc）。两个都试，
// 找到哪个用哪个 —— 装哪个都能跑。
//
// 与 npm/package.json 的 optionalDependencies 键一一对应。
function platformPackages() {
  if (isWindows && process.arch === 'x64') {
    return ['nx-rh-rs-win32-x64-msvc', 'nx-rh-rs-win32-x64-gnu'];
  }
  if (isWindows && process.arch === 'arm64') return ['nx-rh-rs-win32-arm64-msvc'];
  if (process.platform === 'darwin') {
    return process.arch === 'arm64'
      ? ['nx-rh-rs-darwin-arm64']
      : ['nx-rh-rs-darwin-x64'];
  }
  if (process.platform === 'linux' && process.arch === 'x64') {
    return ['nx-rh-rs-linux-x64-gnu', 'nx-rh-rs-linux-x64-musl'];
  }
  return [];
}

function candidates() {
  const out = [];
  // 1) 环境变量直指（排障用）
  if (process.env.NX_RH_RS_BIN) out.push(process.env.NX_RH_RS_BIN);
  // 2) 平台包（npm 按 os/cpu 自动装的那个）
  for (const pkg of platformPackages()) {
    try {
      const p = require.resolve(`${pkg}/package.json`);
      out.push(join(dirname(p), 'bin', 'nx-rh-rs' + EXE));
    } catch {
      /* 该平台包装不上：试下一个 */
    }
  }
  // 3) 主包内置的 binaries/（单包内嵌形态的兜底）
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgRoot = join(here, '..');
  for (const key of binaryKeys()) {
    out.push(join(pkgRoot, 'binaries', key, 'nx-rh-rs' + EXE));
  }
  // 4) 同目录（本地开发：cargo build 后把产物放这）
  out.push(join(here, 'nx-rh-rs' + EXE));
  return out;
}

/** 内置 binaries/ 目录里的平台键（与工作流打包时的键一一对应）。 */
function binaryKeys() {
  if (isWindows && process.arch === 'x64') return ['win32-x64-msvc', 'win32-x64-gnu'];
  if (isWindows && process.arch === 'arm64') return ['win32-arm64-msvc'];
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? ['darwin-arm64'] : ['darwin-x64'];
  }
  if (process.platform === 'linux' && process.arch === 'x64') {
    return ['linux-x64-gnu', 'linux-x64-musl'];
  }
  return [];
}

const bin = candidates().find((p) => existsSync(p));
if (!bin) {
  const pkgs = platformPackages();
  console.error(
    `nx-rh-rs: 找不到本平台的二进制（${process.platform}-${process.arch}）。\n` +
      (pkgs.length
        ? `期望的平台包：${pkgs.join(' 或 ')}\n` +
          `它们是主包的 optionalDependencies，正常安装时会自动装上。\n` +
          `若这里报错，多半是平台包没发布成功，或 npm 装主包时跳过了 optionalDependencies。\n` +
          `  可试：npm i ${pkgs[0]}@latest\n`
        : `当前平台暂无可用预编译二进制。\n`) +
      `排障：设置 NX_RH_RS_BIN 指向本地 cargo build 的产物。`
  );
  process.exit(1);
}

const r = spawnSync(bin, process.argv.slice(2), { stdio: 'inherit' });
if (r.error) {
  console.error('nx-rh-rs: 启动失败 — ' + r.error.message);
  process.exit(1);
}
process.exit(r.status ?? 0);
