// git 操作：统一 shell 出 git CLI（与 br_controller/native_host 的 gitmon.go 同思路）。
// 所有函数返回可序列化对象，供 CLI --json 与 Web API 共用。
import { execFile } from 'node:child_process';
import { external, badInput } from './errors.js';
import { assertSafeRelPath } from './paths.js';

function git(dir, args) {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd: dir, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          out: (stdout || '').trim(),
          err: ((err && err.message) || (stderr || '')).trim(),
        });
      }
    );
  });
}

// porcelain 双字符状态里的冲突码
const CONFLICT_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

export async function isGitRepo(dir) {
  const r = await git(dir, ['rev-parse', '--is-inside-work-tree']);
  return r.ok;
}

export async function gitStatus(dir) {
  const info = {
    dir,
    branch: '',
    ahead: 0,
    behind: 0,
    staged: [],
    modified: [],
    untracked: [],
    conflicted: [],
    clean: false,
    error: '',
  };
  const br = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!br.ok) {
    info.error = br.err || '不是 git 仓库';
    return info;
  }
  info.branch = br.out.split('\n')[0];

  const ab = await git(dir, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']);
  if (ab.ok) {
    const parts = ab.out.split('\t');
    if (parts.length === 2) {
      info.behind = parseInt(parts[0], 10) || 0;
      info.ahead = parseInt(parts[1], 10) || 0;
    }
  }

  const st = await git(dir, ['status', '--porcelain', '-uall']);
  if (st.ok) {
    for (const line of st.out.split('\n')) {
      if (line.length < 4) continue;
      const x = line[0];
      const y = line[1];
      const file = line.slice(3).trim();
      if (CONFLICT_CODES.has(x + y)) {
        info.conflicted.push(file);
        continue;
      }
      if (x === '?' && y === '?') {
        info.untracked.push(file);
        continue;
      }
      if (x !== ' ' && x !== '?') info.staged.push(file);
      if (y !== ' ' && y !== '?') info.modified.push(file);
    }
  }

  info.clean =
    !info.staged.length &&
    !info.modified.length &&
    !info.untracked.length &&
    !info.conflicted.length &&
    !info.ahead &&
    !info.behind;
  return info;
}

export async function gitDiff(dir, file) {
  const safe = file ? assertSafeRelPath(file) : '';
  const args = safe ? ['diff', '--', safe] : ['diff'];
  const r = await git(dir, args);
  return r.out || '(无未暂存差异)';
}

// pull：fetch 失败是硬失败（网络或远端问题，用户无事可做）→ 抛 EXTERNAL。
// 但「拉下来产生冲突」是**业务结果**而非错误——用户需要看到是哪些文件才能决策，
// 所以照常返回，用 status 标出，让 UI / CLI 走各自的冲突处理流程。
export async function gitPull(dir) {
  const fetch = await git(dir, ['fetch']);
  if (!fetch.ok) throw external('git fetch 失败: ' + fetch.err);

  const pull = await git(dir, ['pull', '--no-edit']);
  const status = await gitStatus(dir);

  if (status.conflicted.length) {
    return {
      status: 'conflict',
      ok: false,
      output: pull.out || pull.err || '',
      conflicted: status.conflicted,
    };
  }
  // 其余失败一律硬失败，与 push 对称——旧版这里返回 ok:false 而退出码仍是 0，
  // 于是 agent 会把「pull 失败」当成成功。README 承诺的是「写操作显式报错」。
  if (!pull.ok) throw external('git pull 失败: ' + (pull.err || pull.out || ''));

  return { status: 'ok', ok: true, output: pull.out || '', conflicted: [] };
}

// push 失败没有可供用户决策的中间态，一律视为失败
export async function gitPush(dir) {
  const push = await git(dir, ['push']);
  if (!push.ok) throw external('git push 失败: ' + push.err);
  return { status: 'ok', ok: true, output: push.out || '' };
}

// 冲突解决：git checkout --ours/--theirs 后 git add，完成单个文件的冲突落地
export async function gitResolve(dir, file, side) {
  if (side !== 'ours' && side !== 'theirs') throw badInput('side 必须是 ours 或 theirs');
  file = assertSafeRelPath(file);
  const which = side === 'theirs' ? '--theirs' : '--ours';
  const co = await git(dir, ['checkout', which, '--', file]);
  if (!co.ok) throw external('git checkout 失败: ' + co.err);
  const add = await git(dir, ['add', '--', file]);
  if (!add.ok) throw external('git add 失败: ' + add.err);
  return { status: 'ok', ok: true, output: (co.out || '') + (add.out || '') };
}
