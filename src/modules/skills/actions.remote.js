// 远程订阅的 action 声明：与 index.js 同款形态（cli + http + run + render），
// 由 index.js 收集拼接——这里只放远程订阅这一组，避免 index.js 膨胀。
import * as service from './service.js';
import { projectRoot } from '../../core/paths.js';
import { renderRemoteHub, renderRemoteUpdate } from './renders.js';

const projectOf = (ctx) => ctx.project || projectRoot();


// ---- 远程订阅（唯一装着外部 skill 的容器） ----
export const actions = [
    {
      id: 'skill.hub.remote.list',
      cli: [['skill', 'hub', 'remote', 'list'], ['skill', 'remote', 'list']],
      http: ['GET', '/api/skills/remote'],
      summary: '远程订阅内容：skill 及其来源 / 版本指纹 / 安装状态 / 导入与更新时间',
      flags: { project: { type: 'string' } },
      run: (ctx) => service.remoteContentsWithCells({ project: projectOf(ctx) }),
      render: renderRemoteHub,
    },
    {
      id: 'skill.hub.remote.import',
      cli: [['skill', 'hub', 'remote', 'import'], ['skill', 'remote', 'import']],
      http: ['POST', '/api/skills/remote/import'],
      summary: '从远程规格导入到远程订阅（owner/repo、git URL、归档 URL；--name 只导一个；--dry-run 只列清单）',
      args: ['spec'],
      flags: {
        name: { type: 'string', hint: '只导入这一个 skill' },
        'dry-run': { type: 'boolean', hint: '先看清上游有什么（列名称/描述/版本），不拷贝' },
      },
      run: (ctx) => service.importToRemote(ctx.spec, { name: ctx.name, dryRun: ctx['dry-run'] === true }),
      render: (d) => {
        if (d.dryRun) {
          const lines = [`预演（--dry-run，未拷贝）: ${d.spec}${d.ref ? '@' + d.ref : ''} 共 ${d.count} 个 skill:`];
          for (const s of d.skills) lines.push(`  ${s.name.padEnd(32)} ${String(s.hash).slice(0, 8)}  ${(s.description || '').slice(0, 56)}`);
          lines.push('', '确认导入: nx-rh skill hub remote import ' + d.spec + ' [--name <skill>]');
          return lines.join('\n');
        }
        return `已导入 ${d.count} 个到远程订阅: ${d.imported.join(', ')}\n  落位: ${d.dir}`;
      },
    },
    {
      id: 'skill.hub.remote.add',
      cli: [['skill', 'hub', 'remote', 'add'], ['skill', 'remote', 'add']],
      http: ['POST', '/api/skills/remote'],
      summary: '在远程订阅里添加一个手写定义（--description / --content）',
      args: ['name'],
      flags: { description: { type: 'string' }, content: { type: 'string' } },
      run: (ctx) => service.addRemoteDefinition(ctx.name, { description: ctx.description, content: ctx.content }),
      render: (d) => `已在远程订阅里添加定义: ${d.name}\n  落位: ${d.dir}`,
    },
    {
      id: 'skill.hub.remote.link',
      cli: [['skill', 'hub', 'remote', 'link'], ['skill', 'remote', 'link']],
      http: ['POST', '/api/skills/remote/link'],
      summary: '在远程订阅里放一个软链（<name> <目标目录>：链到别处已有的 skill，同一份源码多处可用）',
      args: ['name', 'target'],
      run: (ctx) => service.linkIntoRemote(ctx.name, ctx.target),
      render: (d) => `已加软链: ${d.name} → ${d.target}  (${d.linkType})`,
    },
    {
      id: 'skill.hub.remote.link-out',
      cli: [['skill', 'hub', 'remote', 'link-out']],
      http: ['POST', '/api/skills/remote/link-out'],
      summary: '把远程订阅里的某份 skill 链到别处（<name> <目标目录>：仓库里这份不动）',
      args: ['name', 'target'],
      run: (ctx) => service.linkFromRemote(ctx.name, ctx.target),
      render: (d) => `已加软链: ${d.from} → ${d.to}  (${d.linkType})`,
    },
    {
      id: 'skill.hub.remote.update',
      cli: [['skill', 'hub', 'remote', 'update'], ['skill', 'remote', 'update']],
      http: ['POST', '/api/skills/remote/update'],
      summary: '按来源重拉更新远程订阅（指纹变了才换；<name...> 只更新指定；--prune 连上游已删的一起清）',
      args: [{ name: 'name', rest: true, required: false }],
      flags: { prune: { type: 'boolean', hint: '上游已删的 skill 同时清掉实体与台账（消僵尸）' } },
      run: (ctx) => {
        const names = Array.isArray(ctx.name) ? ctx.name : ctx.name ? [ctx.name] : [];
        return service.updateRemote(names, { prune: ctx.prune === true });
      },
      render: renderRemoteUpdate,
    },
    {
      id: 'skill.hub.remote.remove',
      cli: [['skill', 'hub', 'remote', 'remove'], ['skill', 'remote', 'remove']],
      http: ['POST', '/api/skills/remote/remove'],
      summary: '从远程订阅里移除 skill（<name...> 批量；平台侧副本另行 purge）',
      args: [{ name: 'name', rest: true }],
      run: (ctx) => {
        const names = Array.isArray(ctx.name) ? ctx.name : ctx.name ? [ctx.name] : [];
        return service.removeFromRemote(names);
      },
      render: (d) => `已从远程订阅里移除: ${d.removed.join(', ') || '（无）'}`,
    },
];
