// 基础冲突算法：LCS 行级 diff + 统一格式输出 + diff3-lite 三方合并 —— 与 core/diff.js 对齐。

#[derive(Debug, Clone, serde::Serialize)]
pub struct DiffOp {
    pub t: String, // = | - | +
    #[serde(rename = "bi")]
    pub bi: usize,
    #[serde(rename = "oi")]
    pub oi: usize,
    pub text: String,
}

fn lcs_dp(a: &[&str], b: &[&str]) -> Vec<Vec<u32>> {
    let n = a.len();
    let m = b.len();
    let mut dp = vec![vec![0u32; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            dp[i][j] = if a[i] == b[j] {
                dp[i + 1][j + 1] + 1
            } else {
                dp[i + 1][j].max(dp[i][j + 1])
            };
        }
    }
    dp
}

pub fn diff_ops(a_text: &str, b_text: &str) -> Vec<DiffOp> {
    let a: Vec<&str> = a_text.split('\n').collect();
    let b: Vec<&str> = b_text.split('\n').collect();
    let dp = lcs_dp(&a, &b);
    let mut ops = Vec::new();
    let (mut i, mut j) = (0usize, 0usize);
    while i < a.len() && j < b.len() {
        if a[i] == b[j] {
            ops.push(DiffOp { t: "=".into(), bi: i, oi: j, text: a[i].to_string() });
            i += 1;
            j += 1;
        } else if dp[i + 1][j] >= dp[i][j + 1] {
            ops.push(DiffOp { t: "-".into(), bi: i, oi: j, text: a[i].to_string() });
            i += 1;
        } else {
            ops.push(DiffOp { t: "+".into(), bi: i, oi: j, text: b[j].to_string() });
            j += 1;
        }
    }
    while i < a.len() {
        ops.push(DiffOp { t: "-".into(), bi: i, oi: j, text: a[i].to_string() });
        i += 1;
    }
    while j < b.len() {
        ops.push(DiffOp { t: "+".into(), bi: i, oi: j, text: b[j].to_string() });
        j += 1;
    }
    ops
}

/// 统一 diff 文本（带近似行号定位）。
pub fn unified_diff(a_text: &str, b_text: &str, a_name: &str, b_name: &str) -> String {
    let ops = diff_ops(a_text, b_text);
    let mut lines = vec![format!("--- {}", a_name), format!("+++ {}", b_name)];
    let (mut ai, mut bi) = (0usize, 0usize);
    let mut idx = 0usize;
    while idx < ops.len() {
        if ops[idx].t == "=" {
            ai += 1;
            bi += 1;
            idx += 1;
            continue;
        }
        let start_ai = ai + 1;
        let start_bi = bi + 1;
        let mut end = idx;
        let (mut del, mut add) = (0usize, 0usize);
        while end < ops.len() && ops[end].t != "=" {
            if ops[end].t == "-" {
                del += 1;
                ai += 1;
            } else {
                add += 1;
                bi += 1;
            }
            end += 1;
        }
        lines.push(format!("@@ -{},{} +{},{} @@", start_ai, del, start_bi, add));
        let ctx_start = idx.saturating_sub(2);
        for k in ctx_start..idx {
            if ops[k].t == "=" {
                lines.push(format!("  {}", ops[k].text));
            }
        }
        for k in idx..end {
            let sign = if ops[k].t == "-" { "-" } else { "+" };
            lines.push(format!("{} {}", sign, ops[k].text));
        }
        for k in end..ops.len().min(end + 2) {
            if ops[k].t != "=" {
                break;
            }
            lines.push(format!("  {}", ops[k].text));
        }
        idx = end;
    }
    lines.join("\n")
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct MergeResult {
    pub merged: String,
    pub conflicts: serde_json::Value,
}

#[derive(Debug, Clone)]
struct Hunk {
    start: usize,
    end: usize,
    replacement: Vec<String>,
}

/// 把 diff ops 折叠为 base 坐标上的替换块。
fn hunks_against(ops: &[DiffOp]) -> Vec<Hunk> {
    let mut hunks: Vec<Hunk> = Vec::new();
    for op in ops {
        if op.t == "=" {
            continue;
        }
        match hunks.last_mut() {
            Some(_cur) if ops.get(op.bi.wrapping_sub(1)).map(|_| false).unwrap_or(false) => {}
            _ => {}
        }
        let extend = hunks
            .last()
            .map(|c: &Hunk| c.end == op.bi)
            .unwrap_or(false);
        if extend {
            let cur = hunks.last_mut().unwrap();
            if op.t == "-" {
                cur.end = op.bi + 1;
            } else {
                cur.replacement.push(op.text.clone());
            }
        } else {
            let mut h = Hunk { start: op.bi, end: op.bi, replacement: vec![] };
            if op.t == "-" {
                h.end = op.bi + 1;
            } else {
                h.replacement.push(op.text.clone());
            }
            hunks.push(h);
        }
    }
    hunks
}

fn apply_side(base: &[&str], start: usize, end: usize, items: &[&Hunk]) -> Vec<String> {
    if items.is_empty() {
        return base[start..end].iter().map(|s| s.to_string()).collect();
    }
    let mut out = Vec::new();
    let mut i = start;
    let mut sorted: Vec<&Hunk> = items.to_vec();
    sorted.sort_by_key(|h| h.start);
    for h in sorted {
        out.extend(base[i..h.start.min(base.len())].iter().map(|s| s.to_string()));
        out.extend(h.replacement.iter().cloned());
        i = i.max(h.end);
    }
    if i < end {
        out.extend(base[i..end].iter().map(|s| s.to_string()));
    }
    out
}

/// diff3-lite 三方合并。两侧同时变更且不同 → 输出冲突块。
pub fn merge3(base_text: &str, a_text: &str, b_text: &str, label_a: &str, label_b: &str) -> MergeResult {
    let base: Vec<&str> = base_text.split('\n').collect();
    let mut all: Vec<(char, Hunk)> = Vec::new();
    for h in hunks_against(&diff_ops(base_text, a_text)) {
        all.push(('a', h));
    }
    for h in hunks_against(&diff_ops(base_text, b_text)) {
        all.push(('b', h));
    }
    all.sort_by_key(|(_, h)| h.start);

    // 聚类：重叠的变更合并为一个决策单元
    let mut clusters: Vec<(usize, usize, Vec<(char, Hunk)>)> = Vec::new();
    for (side, h) in all {
        let need_new = match clusters.last() {
            Some((_, last_end, _)) => h.start >= *last_end,
            None => true,
        };
        if need_new {
            clusters.push((h.start, h.end, vec![(side, h)]));
        } else {
            let c = clusters.last_mut().unwrap();
            c.1 = c.1.max(h.end);
            c.2.push((side, h));
        }
    }

    let mut out: Vec<String> = Vec::new();
    let mut conflicts: Vec<serde_json::Value> = Vec::new();
    let mut pos = 0usize;
    for (start, end, items) in clusters {
        out.extend(base[pos..start.min(base.len())].iter().map(|s| s.to_string()));
        let rep_a = apply_side(&base, start, end, &items.iter().filter(|(s, _)| *s == 'a').map(|(_, h)| h).collect::<Vec<_>>());
        let rep_b = apply_side(&base, start, end, &items.iter().filter(|(s, _)| *s == 'b').map(|(_, h)| h).collect::<Vec<_>>());
        let has_a = items.iter().any(|(s, _)| *s == 'a');
        let has_b = items.iter().any(|(s, _)| *s == 'b');
        if !has_b {
            out.extend(rep_a);
        } else if !has_a {
            out.extend(rep_b);
        } else if rep_a == rep_b {
            out.extend(rep_a);
        } else {
            conflicts.push(serde_json::json!({ "start": start, "end": end }));
            out.push(format!("<<<<<<< {}", label_a));
            out.extend(rep_a);
            out.push("=======".to_string());
            out.extend(rep_b);
            out.push(format!(">>>>>>> {}", label_b));
        }
        pos = end;
    }
    if pos < base.len() {
        out.extend(base[pos..].iter().map(|s| s.to_string()));
    }
    MergeResult { merged: out.join("\n"), conflicts: serde_json::Value::Array(conflicts) }
}
