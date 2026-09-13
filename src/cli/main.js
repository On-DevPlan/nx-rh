// CLI 入口与命令分发。
// 同构原则：这里的每条命令 = Web 面板上的一个按钮 = service 层的一个函数。
// 全局支持 --json（机器可读输出，供 agent 直接消费）。
import { DEFAULT_PORT, storePathFromEnv } from '../core/paths.js';
import { loadStore } from '../core/store.js';
import * as repos from '../services/repos.js';
import * as skills from '../services/skills.js';
import * as ecosystem from '../services/ecosystem.js';
import { merge3 } from '../core/diff.js';

const VERSION = '0.1.0';
const BOOL_FLAGS = new Set(['json', 'force', 'open', 'no-open', 'help', 'yes', 'include-env']);

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (BOOL_FLAGS.has(key)) {
        flags[key] = true;
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function out(data, textFn, json) {
  if (json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  const text = textFn(data);
  if (text !== undefined && text !== null && text !== '') console.log(text);
}

function fail(err, json) {
  if (json) {
    console.log(JSON.stringify({ ok: false, error: String(err && err.message || err) }));
  } else {
    console.error('错误: ' + String(err && err.message || err));
  }
  process.exitCode = 1;
}

function helpText(storePath) {
  return `nx-rh · npx-repo-hub v${VERSION}
本机仓库与 Agent Skill 管理中枢。Web 面板与 CLI 共享同一 service 层。
存储: ${storePath}    （环境变量 NX_RH_STORE 可覆盖）

用法:
  nx-rh serve [--port ${DEFAULT_PORT}] [--no-open]        启动 Web 面板
  nx-rh help | version

仓库管理（= Web「仓库」页）:
  nx-rh repo list [--json]                                仓库清单
  nx-rh repo add <path> [--name N] [--tags a,b] [--notes T]
  nx-rh repo update <id> [--name N] [--tags a,b] [--notes T]
  nx-rh repo remove <id>
  nx-rh repo scan <root> [--depth 3]                      扫描发现 git 仓库并登记
  nx-rh repo status [id] [--json]                         git 状态（分支/领先落后/变更/冲突）
  nx-rh repo diff <id> [--file F]                         未暂存差异文本
  nx-rh repo pull <id>                                    fetch + pull（冲突时列出文件）
  nx-rh repo push <id>
  nx-rh repo resolve <id> --file F --side ours|theirs     落地单个冲突文件
  nx-rh repo open <id>                                    在文件管理器中打开

Skill 管理（= Web「Skill」页）:
  nx-rh skill central [path]                              查看/设置中心仓库
  nx-rh skill adapters [--json]                           适配器清单
  nx-rh skill list --side central|project [--path P] [--json]   两侧识别
  nx-rh skill sync <name> --project P [--mode symlink|copy] [--adapter A] [--force]
  nx-rh skill push <name> --project P [--force]           项目 -> 中心
  nx-rh skill conflict <name> --project P [--json]        逐文件差异（含 diff 文本）
  nx-rh skill apply <name> --project P --file F --side central|project
  nx-rh skill materialize <name> --project P              链接 -> 实体目录
  nx-rh skill merge --base FILE --a FILE --b FILE         diff3-lite 三方合并原语

设置:
  nx-rh setting get [key]
  nx-rh setting set <key> <value>                         skillCentralPath / skillSyncMode

生态（= Web「生态」页，从 bro_chat_native_host 导入）:
  nx-rh eco scan [--json]                                 读取插件 native host 状态目录
  nx-rh eco import [--repos] [--skills] [--central P] [--mode symlink|copy] [--force]
                                                        导入 git 仓库与 skills（默认两者）

通用:
  --json   机器可读输出（agent 模式）
  --store  本次运行覆盖存储路径`;
}

// ---- 文本渲染器（人读模式） ----

function renderRepoList(list) {
  if (!list.length) return '（暂无仓库，用 repo add <path> 登记）';
  const lines = [`共 ${list.length} 个仓库`];
  for (const r of list) {
    lines.push(`${r.name.padEnd(18)} ${r.path}  ${r.tags.length ? '[' + r.tags.join(',') + ']' : ''}`);
  }
  return lines.join('\n');
}

function renderStatus(list) {
  return list
    .map((r) => {
      const g = r.git;
      if (g.error) return `[${r.name}] 非 git 仓库`;
      const parts = [
        `[${r.name}] 分支 ${g.branch}`,
        `领先 ${g.ahead} 落后 ${g.behind}`,
        `暂存 ${g.staged.length} 修改 ${g.modified.length} 未跟踪 ${g.untracked.length}`,
      ];
      let line = parts.join(' · ');
      if (g.conflicted.length) line += ` · 冲突 ${g.conflicted.length} 个文件: ${g.conflicted.join(', ')}`;
      else if (g.clean) line += ' · 干净';
      return line;
    })
    .join('\n');
}

function renderSkillList(side, list) {
  if (!list.length) return `（${side} 侧暂无 skill）`;
  const lines = [`${side} 侧 ${list.length} 个 skill`];
  for (const s of list) {
    const link = s.linkType ? `链接=${s.linkType}` : '实体';
    const adapter = s.adapter ? `adapter=${s.adapter}` : '';
    lines.push(`${s.name.padEnd(20)} ${s.description.slice(0, 40)}  ${link}  ${adapter}`.trimEnd());
  }
  return lines.join('\n');
}

function renderSyncResult(r) {
  if (r.status === 'ok') {
    if (r.skipped) return `已是链接，跳过: ${r.path}`;
    let msg = `已同步 -> ${r.path}（${r.mode === 'symlink' ? '软链接 ' + (r.linkType || '') : '复制'}）`;
    if (r.degraded) msg += `\n注意: 链接创建失败已降级复制（${r.degradedReason || '权限'}）`;
    return msg;
  }
  const files = (r.files || []).map((f) => `  ${f.file}  ${f.side}`).join('\n');
  return `冲突: ${r.files.length} 个文件不一致\n${files}\n用 --force 覆盖，或 skill apply 按文件选侧`;
}

// ---- 主分发 ----

export async function runCli(argv) {
  const { positional, flags } = parseArgs(argv);

  // --store 覆盖存储位置（早于任何 service 调用生效）
  if (flags.store) process.env.NX_RH_STORE = flags.store;

  const json = !!flags.json;
  const cmd = positional[0] || 'help';
  const sub = positional[1];
  const rest = positional.slice(2);

  try {
    switch (`${cmd} ${sub || ''}`.trim()) {
      case 'help':
      case '': {
        if (cmd === 'help' || (cmd === 'help' && !sub)) {
          console.log(helpText(storePathFromEnv()));
          return;
        }
        break;
      }
      case 'version':
        out(VERSION, (v) => v, json);
        return;

      case 'serve':
        return cmdServe(flags);

      // ---- repo ----
      case 'repo list': {
        const data = await repos.listRepos();
        out(data, renderRepoList, json);
        return;
      }
      case 'repo add': {
        if (!rest[0]) throw new Error('用法: repo add <path> [--name N] [--tags a,b] [--notes T]');
        const data = await repos.addRepo({ path: rest[0], name: flags.name, tags: flags.tags, notes: flags.notes });
        out(data, (r) => `已登记: ${r.name} -> ${r.path}`, json);
        return;
      }
      case 'repo update': {
        if (!rest[0]) throw new Error('用法: repo update <id> [--name] [--tags] [--notes]');
        const data = await repos.updateRepo(rest[0], { name: flags.name, tags: flags.tags, notes: flags.notes });
        out(data, (r) => `已更新: ${r.name}`, json);
        return;
      }
      case 'repo remove': {
        if (!rest[0]) throw new Error('用法: repo remove <id>');
        const data = await repos.removeRepo(rest[0]);
        out(data, (r) => `已移除登记: ${r.name}（磁盘文件未动）`, json);
        return;
      }
      case 'repo scan': {
        if (!rest[0]) throw new Error('用法: repo scan <root> [--depth 3]');
        const data = await repos.scanRepos(rest[0], parseInt(flags.depth, 10) || 3);
        out(
          data,
          (d) => `扫描 ${d.root}: 发现 ${d.scanned} 个 git 仓库，新登记 ${d.added.length} 个`,
          json
        );
        return;
      }
      case 'repo status': {
        const data = await repos.repoStatus(rest[0] || undefined);
        out(data, renderStatus, json);
        return;
      }
      case 'repo diff': {
        if (!rest[0]) throw new Error('用法: repo diff <id> [--file F]');
        const data = await repos.repoDiff(rest[0], flags.file || undefined);
        out(data, (d) => d, json);
        return;
      }
      case 'repo pull': {
        if (!rest[0]) throw new Error('用法: repo pull <id>');
        const data = await repos.repoPull(rest[0]);
        out(data, (d) => d.output + (d.conflicted.length ? `\n冲突文件: ${d.conflicted.join(', ')}` : ''), json);
        return;
      }
      case 'repo push': {
        if (!rest[0]) throw new Error('用法: repo push <id>');
        const data = await repos.repoPush(rest[0]);
        out(data, (d) => (d.ok ? d.output || '推送完成' : '推送失败: ' + d.output), json);
        return;
      }
      case 'repo resolve': {
        if (!rest[0] || !flags.file || !flags.side) {
          throw new Error('用法: repo resolve <id> --file F --side ours|theirs');
        }
        const data = await repos.repoResolve(rest[0], flags.file, flags.side);
        out(data, (d) => (d.ok ? `已按 ${flags.side} 落地并暂存: ${flags.file}` : '失败: ' + d.output), json);
        return;
      }
      case 'repo open': {
        if (!rest[0]) throw new Error('用法: repo open <id>');
        const data = await repos.repoOpen(rest[0]);
        out(data, (d) => `已打开: ${d.opened}`, json);
        return;
      }

      // ---- skill ----
      case 'skill central': {
        if (rest[0]) {
          const data = await skills.setCentralPath(rest[0]);
          out(data, (d) => `中心仓库已设置: ${d.skillCentralPath}`, json);
        } else {
          const s = await loadStore();
          out(s.settings.skillCentralPath || '（未设置）', (v) => v, json);
        }
        return;
      }
      case 'skill adapters': {
        const data = skills.listAdapters();
        out(data, (list) => list.map((a) => `${a.id.padEnd(12)} ${a.dir}  ${a.universal ? '(universal)' : ''}`).join('\n'), json);
        return;
      }
      case 'skill list':
      case 'skill scan': {
        if (!flags.side) throw new Error('用法: skill list --side central|project [--path P]');
        const data = await skills.listSkills(flags.side, flags.path || undefined);
        out(data, () => renderSkillList(flags.side, data), json);
        return;
      }
      case 'skill sync': {
        if (!rest[0] || !flags.project) throw new Error('用法: skill sync <name> --project P [--mode symlink|copy] [--force]');
        const data = await skills.syncSkill({
          name: rest[0],
          project: flags.project,
          mode: flags.mode,
          adapter: flags.adapter,
          force: !!flags.force,
        });
        out(data, renderSyncResult, json);
        return;
      }
      case 'skill push': {
        if (!rest[0] || !flags.project) throw new Error('用法: skill push <name> --project P [--force]');
        const data = await skills.pushSkill({ name: rest[0], project: flags.project, force: !!flags.force });
        out(
          data,
          (d) => {
            if (d.status === 'ok') return d.skipped ? d.reason : `已推送到中心: ${d.path}`;
            return `冲突: ${d.files.length} 个文件\n用 --force 覆盖，或 skill apply 选侧`;
          },
          json
        );
        return;
      }
      case 'skill conflict': {
        if (!rest[0] || !flags.project) throw new Error('用法: skill conflict <name> --project P');
        const data = await skills.skillConflict({ name: rest[0], project: flags.project });
        out(
          data,
          (d) => {
            if (!d.files.length) return '两侧一致，无差异';
            const lines = [`${d.name}: ${d.files.length} 个文件差异`];
            for (const f of d.files) {
              lines.push(`\n== ${f.file} (${f.side}) ==`);
              if (f.diff) lines.push(f.diff);
            }
            return lines.join('\n');
          },
          json
        );
        return;
      }
      case 'skill apply': {
        if (!rest[0] || !flags.project || !flags.file || !flags.side) {
          throw new Error('用法: skill apply <name> --project P --file F --side central|project');
        }
        const data = await skills.applySkillSide({
          name: rest[0],
          project: flags.project,
          file: flags.file,
          side: flags.side,
        });
        out(data, (d) => `已按 ${d.side} 侧落地: ${d.file}`, json);
        return;
      }
      case 'skill materialize': {
        if (!rest[0] || !flags.project) throw new Error('用法: skill materialize <name> --project P');
        const data = await skills.materializeSkill({ name: rest[0], project: flags.project });
        out(data, (d) => (d.converted ? `已转换为实体文件（源: ${d.source}）` : d.message), json);
        return;
      }
      case 'skill merge': {
        if (!flags.base || !flags.a || !flags.b) throw new Error('用法: skill merge --base FILE --a FILE --b FILE');
        const fsp = await import('node:fs/promises');
        const [base, a, b] = await Promise.all([
          fsp.readFile(flags.base, 'utf8'),
          fsp.readFile(flags.a, 'utf8'),
          fsp.readFile(flags.b, 'utf8'),
        ]);
        const data = merge3(base, a, b);
        out(data, (d) => d.merged, json);
        return;
      }

      // ---- 生态（bro_chat_native_host 导入） ----
      case 'eco scan': {
        const data = await ecosystem.ecoScan();
        out(
          data,
          (d) => {
            if (!d.exists) return `native host 状态目录不存在: ${d.dir}`;
            const lines = [`native host: ${d.dir}`, `状态文件 ${d.files.length} 个，日志 ${d.logCount} 个`];
            if (d.envSnapshots.length) lines.push(`env 快照: ${d.envSnapshots.map((s) => s.timestamp).join(', ')}`);
            lines.push(`进程 workDir ${d.workDirs.length} 个:`);
            for (const w of d.workDirs) {
              const gitMark = w.isGit ? `git:${w.gitRoot}` : '-';
              const skillMark = w.skillDirs.length ? `skills@${w.skillRoots.join(',')} [${w.skillDirs.join(',')}]` : '-';
              lines.push(`  ${w.path}`);
              lines.push(`      ${gitMark} | ${skillMark}`);
            }
            return lines.join('\n');
          },
          json
        );
        return;
      }
      case 'eco import': {
        const both = !flags.repos && !flags.skills;
        const result = {};
        if (flags.central) await skills.setCentralPath(flags.central);
        if (both || flags.repos) {
          result.repos = await ecosystem.ecoImportRepos({ includeEnv: !!flags['include-env'] });
        }
        if (both || flags.skills) {
          result.skills = await ecosystem.ecoImportSkills({
            mode: flags.mode,
            force: !!flags.force,
          });
        }
        out(
          result,
          (r) => {
            const lines = [];
            if (r.repos) {
              lines.push(
                `仓库: 扫描 ${r.repos.scanned} 个路径，新登记 ${r.repos.added.length} 个，已存在 ${r.repos.existing.length} 个，非 git ${r.repos.nonGit.length} 个`
              );
              for (const a of r.repos.added) lines.push(`  + ${a.name}  ${a.path}`);
            }
            if (r.skills) {
              if (r.skills.empty) {
                lines.push(`skills: 未发现可导入的 skill 源（已检查 ${r.skills.projects.length} 个目录）`);
              } else {
                lines.push(
                  `skills -> ${r.skills.central}: 链接 ${r.skills.linked.length}，复制 ${r.skills.copied.length}，推送 ${r.skills.pushed.length}，跳过 ${r.skills.skipped.length}，冲突 ${r.skills.conflicts.length}，错误 ${r.skills.errors.length}`
                );
                for (const c of r.skills.conflicts) lines.push(`  冲突: ${c.name} (${c.project})`);
                for (const e of r.skills.errors) lines.push(`  错误: ${e.name} (${e.project}): ${e.error}`);
              }
            }
            return lines.join('\n');
          },
          json
        );
        return;
      }

      // ---- setting ----
      case 'setting get': {
        const s = await loadStore();
        if (rest[0]) {
          out(s.settings[rest[0]], (v) => String(v), json);
        } else {
          out(s.settings, (d) => Object.entries(d).map(([k, v]) => `${k} = ${v}`).join('\n'), json);
        }
        return;
      }
      case 'setting set': {
        if (!rest[0] || rest[1] === undefined) throw new Error('用法: setting set <key> <value>');
        const data = await skills.updateSettings({ [rest[0]]: rest.slice(1).join(' ') });
        out(data, (d) => Object.entries(d).map(([k, v]) => `${k} = ${v}`).join('\n'), json);
        return;
      }

      default:
        console.error(`未知命令: ${cmd}${sub ? ' ' + sub : ''}`);
        console.error('运行 nx-rh help 查看用法');
        process.exitCode = 1;
    }
  } catch (err) {
    fail(err, json);
  }
}

// ---- serve ----

async function cmdServe(flags) {
  const { startServer } = await import('../web/server.js');
  const { openBrowser } = await import('../web/open.js');
  const port = parseInt(flags.port, 10) || DEFAULT_PORT;
  const open = !flags['no-open'];

  const server = await startServer({ port, host: '127.0.0.1' });
  const addr = `http://127.0.0.1:${server.address().port}`;

  console.log('nx-rh · npx-repo-hub v' + VERSION);
  console.log(`面板:   ${addr}`);
  console.log(`存储:   ${storePathFromEnv()}`);
  console.log('CLI:    nx-rh help（每个按钮都有对应命令，agent 可加 --json）');
  console.log('按 Ctrl+C 停止');

  if (open) openBrowser(addr);

  const shutdown = () => {
    console.log('\n正在停止...');
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
