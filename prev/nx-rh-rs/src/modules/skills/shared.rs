// 模块内前后端共用的纯函数与常量 —— 与 skills/shared.js 对齐。

pub fn scope_mark(scope: &str) -> &'static str {
    match scope {
        "user" => "用户",
        "project" => "项目",
        other => Box::leak(other.to_string().into_boxed_str()),
    }
}

pub fn path_segs(p: &str) -> Vec<String> {
    p.replace('\\', "/")
        .split('/')
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect()
}

pub fn last_seg(p: &str) -> String {
    path_segs(p).last().cloned().unwrap_or_else(|| p.to_string())
}

/// 订阅源的展示名：多源时取「最短能唯一区分」的尾部段。
pub fn source_label(p: &str, all: &[String]) -> String {
    if p.is_empty() {
        return String::new();
    }
    let mut uniq: Vec<String> = all.to_vec();
    if !uniq.contains(&p.to_string()) {
        uniq.push(p.to_string());
    }
    uniq.retain(|s| !s.is_empty());
    if uniq.len() < 2 {
        return last_seg(p);
    }

    let all2: Vec<Vec<String>> = uniq.iter().map(|s| path_segs(s)).collect();
    let min_len = all2.iter().map(|s| s.len()).min().unwrap_or(0);
    let mut common = 0usize;
    while common + 1 < min_len {
        let i = common + 1;
        let tail = all2[0][all2[0].len() - i].to_lowercase();
        if all2.iter().all(|s| s[s.len() - i].to_lowercase() == tail) {
            common += 1;
        } else {
            break;
        }
    }
    let pools: Vec<Vec<String>> = all2
        .iter()
        .map(|s| {
            if s.len() > common {
                s[..s.len() - common].to_vec()
            } else {
                s.clone()
            }
        })
        .collect();

    let idx = uniq.iter().position(|x| x == p).unwrap_or(0);
    let own = &pools[idx];
    let mut n = 1usize;
    while n < own.len() {
        let tail: String = own[own.len() - n..].join("/").to_lowercase();
        let conflict = pools.iter().enumerate().any(|(j, o)| {
            j != idx && o[o.len() - n.min(o.len())..].join("/").to_lowercase() == tail
        });
        if !conflict {
            break;
        }
        n += 1;
    }
    let joined = own[own.len().saturating_sub(n)..].join("/");
    if joined.is_empty() {
        last_seg(p)
    } else {
        joined
    }
}

/// 把一组来源渲染成可区分的短名串。
pub fn source_labels(items: &serde_json::Value) -> String {
    let arr = items.as_array().cloned().unwrap_or_default();
    let all: Vec<String> = arr
        .iter()
        .map(|x| match x {
            serde_json::Value::String(s) => s.clone(),
            other => other["path"]
                .as_str()
                .or_else(|| other["source"].as_str())
                .unwrap_or("")
                .to_string(),
        })
        .collect();
    all.iter()
        .map(|p| source_label(p, &all))
        .collect::<Vec<_>>()
        .join(" / ")
}
