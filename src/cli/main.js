// CLI 入口与命令分发。
// 同构原则：这里的每条命令 = Web 面板上的一个按钮 = service 层的一个函数。
// 全局支持 --json（机器可读输出，供 agent 直接消费）。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_PORT, storePathFromEnv } from '../core/paths.js';
import { loadStore } from '../core/store.js';
import * as repos from '../services/repos.js';
import * as skills from '../services/skills.js';
import * as bundled from '../services/bundled.js';
import { merge3 } from '../core/diff.js';

const VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
const BOOL_FLAGS = new Set(['json', 'force', 'open', 'no-open', 'help', 'yes', 'list', 'off']);

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
  nx-rh skill central list|add|remove|<path>              中心仓库候选（多选）与当前项
  nx-rh skill project list|add|remove <path>              项目目录候选（多选）
  nx-rh skill platform [ids...]                           默认平台范围 / 默认平台
  nx-rh skill platform-set <name> --project P --adapter A [--off]  单个平台开关
  nx-rh skill compare [--central C] --project P [--names a,b]      多选比较
  nx-rh skill adapters [--json]                           适配器清单
  nx-rh skill list --side central|project [--path P] [--json]   两侧识别
  nx-rh skill sync <name> --project P [--mode symlink|copy] [--adapter A] [--force]
  nx-rh skill push <name> --project P [--force]           项目 -> 中心
  nx-rh skill conflict <name> --project P [--json]        逐文件差异（含 diff 文本）
  nx-rh skill apply <name> --project P --file F --side central|project
  nx-rh skill materialize <name> --project P              链接 -> 实体目录
  nx-rh skill merge --base FILE --a FILE --b FILE         diff3-lite 三方合并原语
  nx-rh skill install [name] [--to DIR] [--force] [--list]  安装内置 skill（默认 repo-hub）
                                                        默认装到 ~/.claude/skills，--to 可改

设置:
  nx-rh setting get [key]
  nx-rh setting set <key> <value>                         skillCentralPath / skillSyncMode

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
        const action = rest[0];
        if (action === 'list') {
          const s = await loadStore();
          out(
            s.settings.skillCentralCandidates,
            (l) =>
              l.length
                ? l.map((p) => `${p === s.settings.skillCentralPath ? '*' : ' '} ${p}`).join('\n')
                : '（暂无中心仓库候选，用 skill central add <path> 添加）',
            json
          );
          return;
        }
        if (action === 'add') {
          if (!rest[1]) throw new Error('用法: skill central add <path>');
          const list = await skills.addCentralCandidate(rest[1]);
          await skills.setCentralPath(rest[1]);
          out({ path: list[list.length - 1], candidates: list }, (d) => `已添加中心仓库: ${d.path}`, json);
          return;
        }
        if (action === 'remove') {
          if (!rest[1]) throw new Error('用法: skill central remove <path>');
          const list = await skills.removeCentralCandidate(rest[1]);
          out(list, (l) => `已移除，剩余 ${l.length} 个候选`, json);
          return;
        }
        if (action) {
          const data = await skills.setCentralPath(action);
          out(data, (d) => `中心仓库已设置: ${d.skillCentralPath}`, json);
          return;
        }
        const s = await loadStore();
        out(s.settings.skillCentralPath || '（未设置）', (v) => v, json);
        return;
      }
      case 'skill project': {
        const action = rest[0];
        if (action === 'list' || !action) {
          const s = await loadStore();
          out(
            s.settings.skillProjectCandidates,
            (l) => (l.length ? l.join('\n') : '（暂无项目目录候选，用 skill project add <path> 添加）'),
            json
          );
          return;
        }
        if (action === 'add') {
          if (!rest[1]) throw new Error('用法: skill project add <path>');
          const list = await skills.addProjectCandidate(rest[1]);
          out(list, (l) => `已添加项目目录（共 ${l.length} 个）: ${resolve(rest[1])}`, json);
          return;
        }
        if (action === 'remove') {
          if (!rest[1]) throw new Error('用法: skill project remove <path>');
          const list = await skills.removeProjectCandidate(rest[1]);
          out(list, (l) => `已移除，剩余 ${l.length} 个`, json);
          return;
        }
        throw new Error('用法: skill project list|add|remove <path>');
      }
      case 'skill platform': {
        if (rest.length) {
          const data = await skills.updateSettings({ platforms: rest, defaultPlatform: rest[0] });
          out(data, (d) => `平台已设置: ${d.platforms.join(', ')}（默认 ${d.defaultPlatform}）`, json);
          return;
        }
        const s = await loadStore();
        out(
          { platforms: s.settings.platforms, defaultPlatform: s.settings.defaultPlatform },
          (d) => `平台: ${d.platforms.join(', ')}\n默认: ${d.defaultPlatform}`,
          json
        );
        return;
      }
      case 'skill platform-set': {
        if (!rest[0] || !flags.project || !flags.adapter) {
          throw new Error('用法: skill platform-set <name> --project P --adapter A [--off] [--force]');
        }
        const data = await skills.setPlatform({
          name: rest[0],
          project: flags.project,
          adapter: flags.adapter,
          enabled: !flags.off,
          mode: flags.mode,
          force: !!flags.force,
        });
        out(
          data,
          (d) => {
            if (d.skipped && d.removed === undefined) return `已是该平台的最新链接，跳过（${d.platform}）`;
            if (d.removed) return `已关闭平台 ${d.platform}: ${d.path}`;
            if (d.status === 'conflict') return `冲突（${d.platform}）: ${d.files.length} 个文件不同，加 --force 覆盖`;
            return `已开启平台 ${d.platform}（${d.mode === 'symlink' ? '软链接 ' + (d.linkType || '') : '复制'}）`;
          },
          json
        );
        return;
      }
      case 'skill compare': {
        if (!flags.project) throw new Error('用法: skill compare [--central C] --project P [--names a,b]');
        const data = await skills.compareSkills({
          central: flags.central,
          project: flags.project,
          names: flags.names ? String(flags.names).split(',').map((x) => x.trim()).filter(Boolean) : undefined,
        });
        out(
          data,
          (d) => {
            const s = d.summary;
            const lines = [
              `比较: ${d.central}  <->  ${d.project}`,
              `共 ${s.total} 项 · 一致 ${s.same} · 链接 ${s.linked} · 冲突 ${s.differ} · 仅中心 ${s.onlyCentral} · 仅项目 ${s.onlyProject}`,
            ];
            const mark = { same: '一致', linked: '链接', differ: '冲突', 'only-central': '仅中心', 'only-project': '仅项目' };
            for (const r of d.rows) {
              const plat = r.platforms.length ? `  [${r.platforms.map((p) => p.id).join(',')}]` : '';
              lines.push(`  ${r.name.padEnd(28)} ${mark[r.state]}${plat}`);
            }
            return lines.join('\n');
          },
          json
        );
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
      case 'skill install': {
        if (flags.list) {
          const list = await bundled.listBundledSkills();
          out(
            list,
            (l) =>
              l.length
                ? l.map((s) => `${s.name.padEnd(14)} ${s.files} 个文件  ${s.description.slice(0, 50)}`).join('\n')
                : '（包内无内置 skill）',
            json
          );
          return;
        }
        const name = rest[0] || 'repo-hub';
        const data = await bundled.installBundledSkill({ name, to: flags.to, force: !!flags.force });
        out(
          data,
          (d) => {
            if (d.status === 'conflict') {
              const files = d.files.map((f) => `  ${f.file}  ${f.side}`).join('\n');
              return `目标已存在且内容不同（${d.count} 个文件）: ${d.path}\n${files}\n用 --force 覆盖，或先删除目标目录`;
            }
            if (d.skipped) return `已是最新，无需安装: ${d.path}`;
            return `${d.replaced ? '已更新' : '已安装'} ${d.name}（${d.files} 个文件）-> ${d.path}`;
          },
          json
        );
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
