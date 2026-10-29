// 批量选择（--all / --include / --exclude / --match）—— 与 skills/svc/select.js 对齐。

use serde_json::{json, Value};

use crate::core::errors::{bad_input, not_found, Res};
use super::sources::{list_all_source_skills, list_hub_skills};
use super::queries::list_all_skills;

/// 名称模式：含 * 走通配，否则按子串；不区分大小写。
pub fn match_name(name: &str, pattern: &str) -> bool {
    let n = name.to_lowercase();
    let p = pattern.trim().to_lowercase();
    if p.is_empty() {
        return false;
    }
    if p.contains('*') {
        let re = format!(
            "^{}$",
            p.split('*')
                .map(|s| regex_lite_escape(s))
                .collect::<Vec<_>>()
                .join(".*")
        );
        return regex_lite_match(&re, &n);
    }
    n.contains(&p)
}

fn regex_lite_escape(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        if "\\.+?^${}()|[]".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

fn regex_lite_match(pattern: &str, text: &str) -> bool {
    // 仅支持 ^...$ 与 . 通配 —— 覆盖 match_name 生成的形状
    let body = pattern.trim_start_matches('^').trim_end_matches('$');
    regex_here(body, text)
}

fn regex_here(pat: &str, text: &str) -> bool {
    fn inner(p: &[char], t: &[char]) -> bool {
        if p.is_empty() {
            return t.is_empty();
        }
        match p[0] {
            '\\' if p.len() >= 2 => {
                t.len() >= 1 && t[0] == p[1] && inner(&p[2..], &t[1..])
            }
            '.' => t.len() >= 1 && inner(&p[1..], &t[1..]),
            '*' => {
                // 前一个字符的 Kleene star：把 p 重排为 (seg*.*) 形式不存在——我们的生成器只产生 `.*`
                false
            }
            _ => t.len() >= 1 && t[0] == p[0] && inner(&p[1..], &t[1..]),
        }
    }
    // 处理 `.*`（字面 dot 后跟 star）
    let pi = 0usize;
    let chars_p: Vec<char> = pat.chars().collect();
    let chars_t: Vec<char> = text.chars().collect();
    fn go(p: &[char], pi: usize, t: &[char], ti: usize) -> bool {
        if pi >= p.len() {
            return ti >= t.len();
        }
        if pi + 1 < p.len() && p[pi + 1] == '*' {
            // star over p[pi]
            let mut k = ti;
            loop {
                if go(p, pi + 2, t, k) {
                    return true;
                }
                if k >= t.len() {
                    return false;
                }
                if p[pi] != '.' && p[pi] != t[k] {
                    return false;
                }
                k += 1;
            }
        }
        if ti < t.len() && (p[pi] == '.' || p[pi] == t[ti]) {
            return go(p, pi + 1, t, ti + 1);
        }
        false
    }
    go(&chars_p, pi, &chars_t, 0)
}

/// 名称入参归一：CLI 的 rest 位置参数是数组，HTTP body 是单个字符串。
pub fn name_list(v: &Value) -> Vec<String> {
    match v {
        Value::Null => vec![],
        Value::Array(arr) => arr
            .iter()
            .filter_map(|x| x.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect(),
        Value::String(s) => {
            let t = s.trim().to_string();
            if t.is_empty() {
                vec![]
            } else {
                vec![t]
            }
        }
        _ => vec![],
    }
}

pub struct Filters {
    pub include: Vec<String>,
    pub exclude: Vec<String>,
    pub match_desc: String,
}

pub fn apply_filters(list: Vec<Value>, f: &Filters) -> Vec<Value> {
    let mut out = list;
    if !f.include.is_empty() {
        out.retain(|s| f.include.iter().any(|p| match_name(s["name"].as_str().unwrap_or(""), p)));
    }
    if !f.exclude.is_empty() {
        out.retain(|s| !f.exclude.iter().any(|p| match_name(s["name"].as_str().unwrap_or(""), p)));
    }
    if !f.match_desc.is_empty() {
        let q = f.match_desc.to_lowercase();
        out.retain(|s| s["description"].as_str().unwrap_or("").to_lowercase().contains(&q));
    }
    out
}

/// 从订阅源里筛出要操作的 skill。
pub fn select_source_skills(
    names: &[String],
    all: bool,
    all_sources: bool,
    include: &[String],
    exclude: &[String],
    match_desc: &str,
) -> Res<Vec<Value>> {
    let pool: Vec<Value> = if !names.is_empty() || all_sources {
        list_all_source_skills()?
    } else {
        list_hub_skills()
    };
    let by_name: std::collections::BTreeMap<String, Value> = pool
        .iter()
        .map(|s| (s["name"].as_str().unwrap_or_default().to_string(), s.clone()))
        .collect();

    let chosen: Vec<Value> = if !names.is_empty() {
        let missing: Vec<&String> = names.iter().filter(|n| !by_name.contains_key(*n)).collect();
        if !missing.is_empty() {
            return Err(not_found(format!(
                "订阅源里没有这些 skill: {}",
                missing.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ")
            )));
        }
        names.iter().filter_map(|n| by_name.get(n).cloned()).collect()
    } else if all || !include.is_empty() {
        pool
    } else {
        return Err(bad_input("需要 <name...>、--all 或 --include <模式> 之一"));
    };

    let out = apply_filters(
        chosen,
        &Filters {
            include: include.to_vec(),
            exclude: exclude.to_vec(),
            match_desc: match_desc.to_string(),
        },
    );
    if out.is_empty() {
        return Err(not_found(
            "按当前筛选条件没有匹配的 skill（--exclude / --match 把候选排空了吗？）",
        ));
    }
    let mut sorted = out;
    sorted.sort_by(|a, b| a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or("")));
    Ok(sorted)
}

/// 撤销/提交的候选池来自**目标目录的扫描**。
pub fn collect_target_skills(project: &str) -> Res<Vec<Value>> {
    let scan = list_all_skills(project, "", "")?;
    let mut map: std::collections::BTreeMap<String, String> = std::collections::BTreeMap::new();
    for x in scan["skills"].as_array().cloned().unwrap_or_default() {
        map.insert(
            x["name"].as_str().unwrap_or("").to_string(),
            x["description"].as_str().unwrap_or("").to_string(),
        );
    }
    for x in scan["orphans"].as_array().cloned().unwrap_or_default() {
        map.entry(x["name"].as_str().unwrap_or("").to_string())
            .or_insert_with(|| x["description"].as_str().unwrap_or("").to_string());
    }
    Ok(map
        .into_iter()
        .map(|(name, description)| json!({ "name": name, "description": description }))
        .collect())
}
