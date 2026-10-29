#!/usr/bin/env python3
"""gitsync — 批量检查 git 仓库与远端的同步状态；只对「干净 + 单向差异」自动推拉。

nx-rh 本体不做任何 git 操作（见 nx-rh README「为什么不管 git」）。本脚本是配套 skill
rh-gitsync 的执行件：把「逐个仓库 fetch / status / 数提交」压成一次调用——
先看清每个仓库与上游的关系，再只对绝对安全的场景动手，其余全部留给 agent 到现场处理。

安全边界（写死在代码里，没有开关）：
  · 自动动作只有两个：ahead（干净，本地领先）→ git push
                      behind（干净，本地落后）→ git pull --ff-only
  · 脏工作区 / 双向分叉 / 无上游 / detached / fetch 失败 / 不是仓库 → needs-human，一字节不动
  · 永不 --force、永不 stash、永不丢弃任何改动

用法：
  python3 gitsync.py [路径...] [--mode check|sync] [--json]
    路径省略 = 当前目录；可传多个；传 '-' 从 stdin 逐行读路径（方便管道批量喂）。
    --mode check（默认）只检查报告，不改任何东西（fetch 只更新远端跟踪引用）。
    --mode sync  检查 + 自动推拉「干净且单向」的仓库，其余原样报告为 needs-human。

退出码：0 = 全部就绪或已自动同步；1 = 存在需要人工处理的仓库；2 = 环境/参数错误。
"""

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

FETCH_TIMEOUT = 120  # 网络操作单独放宽
CMD_TIMEOUT = 30
MAX_FILES = 20       # 报告里最多列多少条变更文件
MAX_COMMITS = 10     # 分叉时每侧最多列多少条提交

S_IN_SYNC = "in-sync"
S_AHEAD = "ahead"
S_BEHIND = "behind"
S_DIRTY = "dirty"
S_DIVERGED = "diverged"
S_NO_UPSTREAM = "no-upstream"
S_DETACHED = "detached"
S_FETCH_FAILED = "fetch-failed"
S_NOT_GIT = "not-git"
S_ERROR = "error"

# sync 模式里唯一允许自动动作的状态；其余全部 needs-human
AUTO_SYNCABLE = (S_AHEAD, S_BEHIND)

CHECK_RESULT = {
    S_IN_SYNC: "up-to-date",
    S_AHEAD: "would-push",
    S_BEHIND: "would-pull",
}
# CHECK_RESULT 之外的状态（含 not-git / error）一律 needs-human


def run_git(cwd, *args, timeout=CMD_TIMEOUT):
    """跑一条 git 命令，返回 (rc, stdout, stderr)。

    GIT_TERMINAL_PROMPT=0：需要交互输凭据时立刻失败，绝不挂起等输入（agent 场景没人接键盘）。
    """
    env = dict(os.environ)
    env["GIT_TERMINAL_PROMPT"] = "0"
    try:
        p = subprocess.run(
            ["git", "-C", str(cwd)] + list(args),
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=timeout, env=env,
        )
        return p.returncode, p.stdout, p.stderr
    except FileNotFoundError:
        return 127, "", "git 不可用"
    except subprocess.TimeoutExpired:
        return 124, "", "命令超时（{}s）: git {}".format(timeout, " ".join(args[:2]))


def first_line(text, cap=200):
    """取 stderr 里第一条非空行当错误消息，超长截断——报告里不需要整段堆栈。"""
    for line in (text or "").splitlines():
        line = line.strip()
        if line:
            return line[:cap]
    return ""


def norm_path(p):
    return Path(p).resolve().as_posix()


def fresh_result(path):
    return {
        "path": norm_path(path),
        "name": Path(path).name or norm_path(path),
        "status": None,
        "result": None,
        "error": None,
        "branch": None,
        "head": None,
        "upstream": None,
        "remote": None,
        "ahead": None,
        "behind": None,
        "dirty": None,
        "files": [],
        "filesTruncated": False,
        "localCommits": [],
        "remoteCommits": [],
    }


def parse_porcelain(out):
    """解析 `git status --porcelain=v1`：staged / unstaged / untracked 计数 + 原始行。"""
    staged = unstaged = untracked = 0
    files = []
    for line in out.splitlines():
        if len(line) < 2:
            continue
        if line.startswith("??"):
            untracked += 1
        else:
            if line[0] not in (" ", "?"):
                staged += 1
            if line[1] != " ":
                unstaged += 1
        files.append(line)
    return staged, unstaged, untracked, files


def fill_local(res, top):
    """工作区状态（dirty / files）：纯本地信息，随时可查，失败不阻断后续分类。"""
    rc, out, err = run_git(top, "status", "--porcelain=v1")
    if rc != 0:
        res["error"] = res["error"] or first_line(err)
        return
    staged, unstaged, untracked, files = parse_porcelain(out)
    res["dirty"] = {
        "staged": staged,
        "unstaged": unstaged,
        "untracked": untracked,
        "total": staged + unstaged + untracked,
    }
    res["files"] = files[:MAX_FILES]
    res["filesTruncated"] = len(files) > MAX_FILES


def count_ab(top, upstream):
    """ahead / behind。左列 = 上游独有（behind），右列 = HEAD 独有（ahead）。"""
    rc, out, err = run_git(top, "rev-list", "--left-right", "--count",
                           "{}...HEAD".format(upstream))
    if rc != 0:
        return None, None
    parts = out.split()
    if len(parts) < 2:
        return None, None
    try:
        return int(parts[1]), int(parts[0])
    except ValueError:
        return None, None


def commit_list(top, rng):
    rc, out, err = run_git(top, "log", "--oneline", "--no-decorate",
                           "-n", str(MAX_COMMITS), rng)
    if rc != 0:
        return []
    return [l for l in out.splitlines() if l.strip()]


def remote_url(top, upstream):
    if "/" not in upstream:
        return None
    rc, out, err = run_git(top, "remote", "get-url", upstream.rsplit("/", 1)[0])
    return out.strip() if rc == 0 else None


def inspect(path):
    """检查一个路径，返回该仓库的完整状态（只读，除 fetch 更新远端跟踪引用外零改动）。"""
    res = fresh_result(path)
    p = Path(path)
    if not p.exists():
        res["status"] = S_ERROR
        res["error"] = "路径不存在"
        return res

    rc, out, err = run_git(p, "rev-parse", "--show-toplevel")
    if rc != 0:
        res["status"] = S_NOT_GIT
        res["error"] = first_line(err) or "不是 git 仓库"
        return res
    top = out.strip().replace("\\", "/")
    res["path"] = top
    res["name"] = top.rstrip("/").rsplit("/", 1)[-1]

    rc, out, err = run_git(top, "rev-parse", "--short", "HEAD")
    res["head"] = out.strip() if rc == 0 else None

    rc, out, err = run_git(top, "rev-parse", "--abbrev-ref", "HEAD")
    branch = out.strip() if rc == 0 else None
    if not branch or branch == "HEAD":
        res["status"] = S_DETACHED
        res["error"] = "HEAD 游离（不在任何分支上）"
        fill_local(res, top)
        return res
    res["branch"] = branch
    fill_local(res, top)

    rc, out, err = run_git(top, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")
    if rc != 0:
        res["status"] = S_NO_UPSTREAM
        res["error"] = "分支 {} 没有设置上游".format(branch)
        return res
    upstream = out.strip()
    res["upstream"] = upstream
    res["remote"] = remote_url(top, upstream)

    rc, out, err = run_git(top, "fetch", "--quiet", timeout=FETCH_TIMEOUT)
    fetch_failed = rc != 0

    ahead, behind = count_ab(top, upstream)
    res["ahead"], res["behind"] = ahead, behind
    if ahead:
        res["localCommits"] = commit_list(top, "{}..HEAD".format(upstream))
    if behind:
        res["remoteCommits"] = commit_list(top, "HEAD..{}".format(upstream))

    # 分类顺序 = 处理优先级：先排除「根本没法安全判断」的，再看双向，最后才是可自动的
    if fetch_failed:
        res["status"] = S_FETCH_FAILED
        res["error"] = "fetch 失败（{}）——ahead/behind 可能过期".format(first_line(err))
    elif ahead and behind:
        res["status"] = S_DIVERGED
        res["error"] = "本地与上游双向分叉（ahead {} / behind {}）".format(ahead, behind)
    elif (res["dirty"] or {}).get("total"):
        res["status"] = S_DIRTY
        res["error"] = "工作区有未提交内容"
    elif ahead:
        res["status"] = S_AHEAD
    elif behind:
        res["status"] = S_BEHIND
    else:
        res["status"] = S_IN_SYNC
    return res


def sync_one(res):
    """sync 模式的落地动作：只对 AUTO_SYNCABLE 动手，动手前再复查一次工作区。"""
    st = res["status"]
    if st == S_IN_SYNC:
        res["result"] = "up-to-date"
        return
    if st not in AUTO_SYNCABLE:
        res["result"] = "needs-human"
        return

    top = res["path"]
    # 检查与执行之间工作区可能被别的进程改脏——推拉前最后一道复查，宁可放弃也不赌
    rc, out, err = run_git(top, "status", "--porcelain=v1")
    if rc != 0 or out.strip():
        res["status"] = S_DIRTY
        res["result"] = "needs-human"
        res["error"] = "推拉前复查发现工作区已不干净，放弃自动操作"
        return

    if st == S_AHEAD:
        rc, out, err = run_git(top, "push", timeout=FETCH_TIMEOUT)
        if rc != 0:
            res["result"] = "failed"
            res["error"] = first_line(err or out) or "push 失败"
            return
        ahead, behind = count_ab(top, res["upstream"])
        if ahead:
            res["result"] = "failed"
            res["error"] = "push 退出码为 0 但仍领先 {} 个提交，请人工确认".format(ahead)
            return
        res["ahead"] = 0
    else:
        rc, out, err = run_git(top, "pull", "--ff-only", timeout=FETCH_TIMEOUT)
        if rc != 0:
            res["result"] = "failed"
            res["error"] = first_line(err or out) or "pull --ff-only 失败"
            return
        ahead, behind = count_ab(top, res["upstream"])
        if behind:
            res["result"] = "failed"
            res["error"] = "pull --ff-only 退出码为 0 但仍落后 {} 个提交，请人工确认".format(behind)
            return
        res["behind"] = 0
    res["status"] = S_IN_SYNC
    res["result"] = "pushed" if st == S_AHEAD else "pulled"
    res["localCommits"], res["remoteCommits"] = [], []


RESULT_NOTE = {
    "check": {
        "up-to-date": "",
        "would-push": "[sync 模式将 push]",
        "would-pull": "[sync 模式将 pull --ff-only]",
        "needs-human": "[需人工]",
    },
    "sync": {
        "up-to-date": "",
        "pushed": "[已 push]",
        "pulled": "[已 pull --ff-only]",
        "needs-human": "[未动：需人工]",
        "failed": "[自动操作失败]",
    },
}


def summarize(repos):
    by = {}
    for r in repos:
        by[r["status"]] = by.get(r["status"], 0) + 1
    return {
        "total": len(repos),
        "byStatus": by,
        "upToDate": sum(1 for r in repos if r["result"] == "up-to-date"),
        "autoSynced": sum(1 for r in repos if r["result"] in ("pushed", "pulled")),
        "needsHuman": [r["path"] for r in repos if r["result"] == "needs-human"],
        "failed": [r["path"] for r in repos if r["result"] == "failed"],
    }


def render_human(data):
    s = data["summary"]
    notes = RESULT_NOTE[data["mode"]]
    lines = ["gitsync · mode={} · {} 个仓库".format(data["mode"], s["total"]), ""]
    for r in data["repos"]:
        det = r.get("branch") or "-"
        if r.get("upstream"):
            det += " -> " + r["upstream"]
        if r.get("ahead"):
            det += " ↑{}".format(r["ahead"])
        if r.get("behind"):
            det += " ↓{}".format(r["behind"])
        d = r.get("dirty") or {}
        marks = []
        if d.get("staged"):
            marks.append("+{}".format(d["staged"]))
        if d.get("unstaged"):
            marks.append("~{}".format(d["unstaged"]))
        if d.get("untracked"):
            marks.append("?{}".format(d["untracked"]))
        if marks:
            det += " · " + " ".join(marks)
        err = " — " + r["error"] if r.get("error") else ""
        lines.append("  {:<12} {}  ({}){}{}".format(
            r["status"], r["path"], det, notes.get(r["result"], ""), err))
    lines.append("")
    if s["failed"]:
        lines.append("自动操作失败 {} 个: {}".format(len(s["failed"]), " · ".join(s["failed"])))
    if s["needsHuman"]:
        lines.append("需人工 {} 个: {}".format(len(s["needsHuman"]), " · ".join(s["needsHuman"])))
        lines.append("规则：脚本只自动处理「工作区干净 + 单向差异」（ahead→push、behind→pull --ff-only）。")
        lines.append("      脏工作区 / 分叉 / 无上游一律不动手——agent 到目录检查、问过用户再操作；永不 force。")
    return "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser(
        prog="gitsync",
        description="批量检查 git 仓库与远端同步状态；只对「干净 + 单向差异」自动推拉。",
        epilog="退出码: 0=全部就绪或已同步  1=有仓库需要人工处理  2=环境/参数错误",
    )
    ap.add_argument("paths", nargs="*",
                    help="仓库路径（省略 = 当前目录；'-' = 从 stdin 逐行读）")
    ap.add_argument("--mode", choices=("check", "sync"), default="check",
                    help="check = 只检查报告（默认，零改动）；sync = 附加自动推拉安全仓")
    ap.add_argument("--json", dest="as_json", action="store_true",
                    help="输出纯 JSON（agent 契约）")
    args = ap.parse_args(argv)

    paths = []
    for x in args.paths:
        if x == "-":
            paths.extend(l.strip() for l in sys.stdin.read().splitlines() if l.strip())
        elif x.strip():
            paths.append(x.strip())
    if not paths:
        paths = [os.getcwd()]

    try:
        subprocess.run(["git", "--version"], capture_output=True)
    except FileNotFoundError:
        sys.stderr.write("gitsync: PATH 里找不到 git，无法工作\n")
        return 2

    # 同一仓库以不同子路径传入时，按 toplevel 去重（Windows 下比较不分大小写）
    repos, seen = [], set()
    for p in paths:
        r = inspect(p)
        key = r["path"].lower() if os.name == "nt" else r["path"]
        if key in seen:
            continue
        seen.add(key)
        repos.append(r)

    if args.mode == "sync":
        for r in repos:
            sync_one(r)
    else:
        for r in repos:
            r["result"] = CHECK_RESULT.get(r["status"], "needs-human")

    data = {"mode": args.mode, "repos": repos, "summary": summarize(repos)}
    if args.as_json:
        print(json.dumps(data, ensure_ascii=False, indent=2))
    else:
        print(render_human(data))
    return 1 if (data["summary"]["needsHuman"] or data["summary"]["failed"]) else 0


if __name__ == "__main__":
    # Windows 管道默认可能落到 GBK：统一按 UTF-8 输出，agent 与终端都不用猜编码
    for _stream in (sys.stdout, sys.stderr):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")
        except AttributeError:
            pass
    sys.exit(main())
