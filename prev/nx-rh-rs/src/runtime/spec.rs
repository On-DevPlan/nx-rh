// action 规格：一条声明同时给出 CLI 路径与 HTTP 路由 —— 与 runtime/spec.js 对齐。

use serde_json::Value;

use crate::core::errors::{bad_input, Res};

#[derive(Debug, Clone)]
pub struct FlagSpec {
    pub name: &'static str,
    pub kind: &'static str, // string | number | boolean | array
    pub required: bool,
    pub default: Option<Value>,
    pub enum_values: Option<Vec<&'static str>>,
    pub hint: &'static str,
}

#[derive(Debug, Clone)]
pub struct ArgSpec {
    pub name: &'static str,
    pub required: bool,
    pub rest: bool,
}

/// 每条 action 的静态声明。run 闭包接收 (ctx, transport) 返回 JSON 值。
pub struct Action {
    pub id: &'static str,
    /// 单路径 cli: vec![vec!["repo","list"]]；多路径（别名）: vec![vec!["skill","list"], vec!["bundled","list"]]
    pub cli: Vec<Vec<&'static str>>,
    pub http: Option<(&'static str, &'static str)>,
    pub summary: &'static str,
    pub args: Vec<ArgSpec>,
    pub flags: Vec<FlagSpec>,
    pub module: &'static str,
    pub run: fn(&Value, &str) -> Res<Value>,
    /// CLI 人读渲染（--json 时走序列化，不走这里）
    pub render: Option<fn(&Value, &Value) -> String>,
}

// CLI 路径列表（支持别名：数组的第一层是路径数组）
pub fn cli_paths_of(action: &Action) -> Vec<Vec<&'static str>> {
    action.cli.clone()
}

pub fn flag_specs_of(action: &Action) -> Vec<&FlagSpec> {
    action.flags.iter().collect()
}

pub fn arg_specs_of(action: &Action) -> Vec<&ArgSpec> {
    action.args.iter().collect()
}

pub fn boolean_flag_names(action: &Action) -> std::collections::HashSet<&'static str> {
    action
        .flags
        .iter()
        .filter(|f| f.kind == "boolean")
        .map(|f| f.name)
        .collect()
}

fn coerce_one(name: &str, spec: &FlagSpec, raw: &Value) -> Res<Option<Value>> {
    let kind = spec.kind;
    if raw.is_null() {
        return Ok(None);
    }

    // 需要值的 flag 写在末尾时解析器只能记成 true —— 宁报错也不把笔误变成别的语义
    if raw.as_bool() == Some(true) && kind != "boolean" {
        return Err(bad_input(format!("参数 --{} 需要提供值", name)));
    }

    let out = match kind {
        "boolean" => match raw {
            Value::Bool(b) => Value::Bool(*b),
            Value::String(s) => {
                let l = s.to_lowercase();
                Value::Bool(!(l == "false" || l == "0" || l == "no" || l.is_empty()))
            }
            _ => Value::Bool(true),
        },
        "number" => match raw {
            Value::Number(_n) => raw.clone(),
            Value::String(s) => match s.parse::<f64>() {
                Ok(n) if n.is_finite() => serde_json::json!(n),
                _ => return Err(bad_input(format!("参数 {} 必须是数字，收到: {}", name, s))),
            },
            Value::Bool(b) => return Err(bad_input(format!("参数 {} 必须是数字，收到: {}", name, b))),
            _ => return Err(bad_input(format!("参数 {} 必须是数字，收到: {}", name, raw))),
        },
        "array" => match raw {
            Value::Array(arr) => Value::Array(
                arr.iter()
                    .map(|x| Value::String(x.as_str().unwrap_or_default().trim().to_string()))
                    .filter(|x| x.as_str().map(|s| !s.is_empty()).unwrap_or(false))
                    .collect(),
            ),
            Value::String(s) => Value::Array(
                s.split(',')
                    .map(|x| Value::String(x.trim().to_string()))
                    .filter(|x| x.as_str().map(|s| !s.is_empty()).unwrap_or(false))
                    .collect(),
            ),
            other => Value::Array(vec![Value::String(other.to_string())]),
        },
        _ => match raw {
            Value::String(s) => Value::String(s.clone()),
            other => Value::String(other.to_string()),
        },
    };
    Ok(Some(out))
}

/// 「用法:」前缀是对外契约（agent 靠它判定参数错误并决定「停下来问人」）。
fn input_error(action: &Action, detail: &str) -> crate::core::errors::AppError {
    bad_input(format!("用法: {} —— {}", usage_of(action), detail))
}

/// 按声明校验并强转输入。未声明的键原样透传（HTTP body 可能带界面用的额外字段）。
pub fn apply_spec(action: &Action, raw: &Value) -> Res<Value> {
    let mut out = raw.clone();
    let obj = out.as_object_mut().ok_or_else(|| bad_input("ctx 必须是对象"))?;

    for spec in flag_specs_of(action) {
        let raw_v = obj.get(spec.name).cloned();
        let v = match raw_v {
            None | Some(Value::Null) => None,
            Some(x) => coerce_one(spec.name, spec, &x)?,
        };
        match v {
            None => {
                if let Some(d) = &spec.default {
                    obj.insert(spec.name.to_string(), d.clone());
                } else if spec.required {
                    return Err(input_error(action, &format!("缺少参数 --{}", spec.name)));
                }
            }
            Some(v) => {
                if let Some(allowed) = &spec.enum_values {
                    let s = v.as_str().unwrap_or_default();
                    if !allowed.iter().any(|a| *a == s) {
                        return Err(input_error(
                            action,
                            &format!(
                                "参数 --{} 只能是 {}，收到: {}",
                                spec.name,
                                allowed.join(" | "),
                                s
                            ),
                        ));
                    }
                }
                obj.insert(spec.name.to_string(), v);
            }
        }
    }

    for spec in arg_specs_of(action) {
        let v = obj.get(spec.name).cloned().unwrap_or(Value::Null);
        let empty = match &v {
            Value::Null => true,
            Value::String(s) => s.is_empty(),
            Value::Array(a) => a.is_empty(),
            _ => false,
        };
        if empty && spec.required {
            return Err(input_error(action, &format!("缺少参数 <{}>", spec.name)));
        }
    }
    Ok(out)
}

/// 用法串生成：从声明反推，help 因此不可能与实际命令脱节。
pub fn usage_of(action: &Action) -> String {
    let path = action.cli.first().cloned().unwrap_or_default();
    let mut parts: Vec<String> = vec!["nx-rh-rs".into()];
    parts.extend(path.iter().map(|s| s.to_string()));

    for a in arg_specs_of(action) {
        let label = if a.rest { format!("{}...", a.name) } else { a.name.to_string() };
        parts.push(if a.required { format!("<{}>", label) } else { format!("[{}]", label) });
    }
    for f in flag_specs_of(action) {
        // 布尔 flag 不带值占位符（`--force`），其余带 `<hint>`：
        // hint 优先用 enum 展开（--side <ours|theirs>），其次显式 hint，最后退回 flag 名。
        let token = if f.kind == "boolean" {
            format!("--{}", f.name)
        } else {
            let hint = match &f.enum_values {
                Some(e) => e.join("|"),
                None if !f.hint.is_empty() => f.hint.to_string(),
                None => f.name.to_string(),
            };
            format!("--{} <{}>", f.name, hint)
        };
        // 可选性对两种 flag 一视同仁：非必填一律加方括号。
        // （早期只在带值的 flag 上加括号，结果 `[--force]` 被渲染成 `--force`，
        //   看上去像必填，和 JS 版逐字比对不上。）
        parts.push(if f.required { token } else { format!("[{}]", token) });
    }
    parts.join(" ")
}

// ─── HTTP 路由模式编译：'/api/repos/:id' → 段匹配器 ──────────────────

pub struct CompiledRoute {
    pub segments: Vec<RouteSeg>,
}

pub enum RouteSeg {
    Literal(String),
    Param(String),
}

pub fn compile_route(pattern: &str) -> CompiledRoute {
    let segments = pattern
        .split('/')
        .filter(|s| !s.is_empty())
        .map(|seg| {
            if let Some(name) = seg.strip_prefix(':') {
                RouteSeg::Param(name.to_string())
            } else {
                RouteSeg::Literal(seg.to_string())
            }
        })
        .collect();
    CompiledRoute { segments }
}

/// 匹配路径并抽出参数（路由分发的唯一实现 —— http.rs 与单测都用这一份）。
/// path_segs 已按 `/` 拆好，参数值做 percent 解码。
pub fn match_segments(segments: &[RouteSeg], path_segs: &[&str]) -> Option<Vec<(String, String)>> {
    if segments.len() != path_segs.len() {
        return None;
    }
    let mut params = Vec::new();
    for (seg, p) in segments.iter().zip(path_segs) {
        match seg {
            RouteSeg::Literal(l) => {
                if l != p {
                    return None;
                }
            }
            RouteSeg::Param(name) => {
                params.push((name.clone(), percent_decode(p)));
            }
        }
    }
    Some(params)
}

pub fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        if bytes[i] == b'+' {
            out.push(b' ');
            i += 1;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

/// 路由排序：字面量段优先于参数段，段数多的优先（对齐 api.js 的 compareRoutes）。
pub fn route_specificity(pattern: &str) -> (usize, usize, Vec<bool>) {
    let segs: Vec<bool> = pattern
        .split('/')
        .filter(|s| !s.is_empty())
        .map(|s| !s.starts_with(':'))
        .collect();
    (segs.iter().filter(|l| **l).count(), segs.len(), segs)
}
