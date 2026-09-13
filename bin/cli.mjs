#!/usr/bin/env node
// nx-rh（npx-repo-hub）唯一入口。
// 设计约定：Web 面板上每个按钮，都对应这里的一条 CLI 命令，二者共享同一 service 层。
import { runCli } from '../src/cli/main.js';

runCli(process.argv.slice(2)).catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exitCode = 1;
});
