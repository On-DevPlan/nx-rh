// HTTP 服务：零依赖（std TcpListener + 手写 HTTP/1.1）。
// 职责只有两件事：发静态面板文件 + 把 /api/* 交给路由层。
// 与 runtime/server.js + api.js 合并成一层（Rust 侧不需要拆两个文件）。

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;

use serde_json::{json, Value};

use super::registry;
use super::spec::{apply_spec, compile_route, route_specificity, Action, RouteSeg};
use crate::core::errors::{http_status_of, to_error_payload, BLOCKED};
use crate::core::paths::{clear_scope, set_scope};

pub struct ServerOptions {
    pub port: u16,
    pub host: &'static str,
}

/// 写操作 Origin 校验：浏览器跨站写请求会被拒，本机程序（无 Origin）放行。
fn origin_allowed(method: &str, origin: Option<&str>) -> bool {
    if !matches!(method, "POST" | "PATCH" | "PUT" | "DELETE") {
        return true;
    }
    let Some(origin) = origin else {
        return true; // 非浏览器客户端
    };
    // 只收本机地址
    let stripped = origin
        .strip_prefix("http://")
        .or_else(|| origin.strip_prefix("https://"))
        .unwrap_or(origin);
    let host = stripped.split(['/', ':']).next().unwrap_or("");
    matches!(host, "127.0.0.1" | "localhost" | "::1" | "[::1]")
}

fn mime_of(ext: &str) -> &'static str {
    match ext {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

fn send_json(stream: &mut TcpStream, status: u16, obj: &Value) {
    let body = serde_json::to_string(obj).unwrap_or_default();
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        _ => "OK",
    };
    let resp = format!(
        "HTTP/1.1 {} {}\r\ncontent-type: application/json; charset=utf-8\r\ncache-control: no-store\r\ncontent-length: {}\r\n\r\n{}",
        status,
        reason,
        body.len(),
        body
    );
    let _ = stream.write_all(resp.as_bytes());
}

/// 静态资源直接从嵌入树里读——不落临时目录（单文件分发的前提）。
fn send_static(stream: &mut TcpStream, root: &include_dir::Dir, pathname: &str) {
    let rel = if pathname == "/" {
        "index.html".to_string()
    } else {
        let decoded = super::spec::percent_decode(pathname);
        decoded.trim_start_matches('/').to_string()
    };
    // 越界校验：路径里出现 `..` 段一律拒绝（嵌入树按字面量查，本来也逃不出去，
    // 但显式挡住——这是对外契约的一部分）。
    if rel.split(['/', '\\']).any(|seg| seg == "..") {
        let _ = stream.write_all(b"HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\ncontent-length: 9\r\n\r\nForbidden");
        return;
    }
    match root.get_file(&rel) {
        Some(file) => {
            let buf = file.contents();
            let ext = Path::new(&rel)
                .extension()
                .map(|e| e.to_string_lossy().to_string())
                .unwrap_or_default();
            let resp = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: {}\r\ncache-control: no-store\r\ncontent-length: {}\r\n\r\n",
                mime_of(&ext),
                buf.len()
            );
            let _ = stream.write_all(resp.as_bytes());
            let _ = stream.write_all(buf);
        }
        None => {
            let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\ncontent-type: text/plain\r\ncontent-length: 8\r\n\r\nNot Found");
        }
    }
}

fn read_request(stream: &mut TcpStream) -> Option<(String, String, Vec<(String, String)>, Vec<u8>)> {
    let mut reader = BufReader::new(stream.try_clone().ok()?);
    let mut request_line = String::new();
    reader.read_line(&mut request_line).ok()?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next()?.to_string();
    let path_full = parts.next()?.to_string();

    let mut headers = Vec::new();
    let mut content_length = 0usize;
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).ok()?;
        let t = line.trim_end();
        if t.is_empty() {
            break;
        }
        if let Some((k, v)) = t.split_once(':') {
            let key = k.trim().to_lowercase();
            let val = v.trim().to_string();
            if key == "content-length" {
                content_length = val.parse().unwrap_or(0);
            }
            headers.push((key, val));
        }
    }
    if content_length > 4 * 1024 * 1024 {
        return None; // 请求体过大
    }
    let mut body = vec![0u8; content_length];
    if content_length > 0 {
        reader.read_exact(&mut body).ok()?;
    }
    let path = path_full.split('?').next().unwrap_or("").to_string();
    Some((method, path, headers, body))
}

/// 编译好的路由表（按特异性排序）
struct CompiledAction {
    action: &'static Action,
    method: &'static str,
    segments: Vec<RouteSeg>,
}

fn routes() -> &'static Vec<CompiledAction> {
    use once_cell::sync::Lazy;
    static ROUTES: Lazy<Vec<CompiledAction>> = Lazy::new(|| {
        let mut out: Vec<CompiledAction> = Vec::new();
        for a in registry::actions() {
            if let Some((method, pattern)) = a.http {
                let compiled = compile_route(pattern);
                out.push(CompiledAction { action: a, method, segments: compiled.segments });
            }
        }
        // 字面量段越多越具体；同数按第一处分歧段字面量胜出
        out.sort_by(|x, y| {
            let px = x
                .segments
                .iter()
                .map(|s| matches!(s, RouteSeg::Literal(_)))
                .collect::<Vec<_>>();
            let py = y
                .segments
                .iter()
                .map(|s| matches!(s, RouteSeg::Literal(_)))
                .collect::<Vec<_>>();
            let lx = px.iter().filter(|l| **l).count();
            let ly = py.iter().filter(|l| **l).count();
            ly.cmp(&lx)
                .then_with(|| y.segments.len().cmp(&x.segments.len()))
                .then_with(|| {
                    for (a, b) in px.iter().zip(py.iter()) {
                        if a != b {
                            return b.cmp(a); // 字面量（true）优先
                        }
                    }
                    std::cmp::Ordering::Equal
                })
        });
        out
    });
    &ROUTES
}

fn dispatch(action: &'static Action, raw: Value, transport: &str) -> (u16, Value) {
    match apply_spec(action, &raw).and_then(|ctx| (action.run)(&ctx, transport)) {
        Ok(data) => (200, json!({ "ok": true, "data": data })),
        Err(e) => {
            let p = to_error_payload(&crate::core::errors::AppError {
                code: e.code,
                message: e.message,
                details: e.details,
            });
            let mut payload = json!({ "ok": false, "error": p.message, "code": p.code });
            if let Some(d) = &p.details {
                payload["details"] = d.clone();
            }
            (http_status_of(&p.code), payload)
        }
    }
}

fn handle_api(stream: &mut TcpStream, method: &str, path: &str, headers: &[(String, String)], body: &[u8]) {
    if !origin_allowed(method, headers.iter().find(|(k, _)| k == "origin").map(|(_, v)| v.as_str())) {
        send_json(
            stream,
            http_status_of(BLOCKED),
            &json!({ "ok": false, "error": "拒绝跨源写请求（Origin 不是本机地址）", "code": BLOCKED }),
        );
        return;
    }

    // 作用域头激活：面板切项目只带头，业务 action 不改
    let scope = headers
        .iter()
        .find(|(k, _)| k == "x-nx-rh-scope")
        .map(|(_, v)| v.trim().to_string())
        .filter(|s| !s.is_empty());
    if let Some(dir) = scope {
        set_scope(Path::new(&dir));
    }

    let path_segs: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    let mut query: Vec<(String, String)> = Vec::new();
    if let Some(q) = path.split_once('?').map(|(_, q)| q) {
        for pair in q.split('&') {
            if let Some((k, v)) = pair.split_once('=') {
                query.push((super::spec::percent_decode(k), super::spec::percent_decode(v)));
            }
        }
    }

    let upper_method = method.to_uppercase();
    let mut matched: Option<(u16, Value)> = None;
    for r in routes() {
        if !r.method.eq_ignore_ascii_case(&upper_method) {
            continue;
        }
        let Some(params) = match_segments(&r.segments, &path_segs) else {
            continue;
        };
        let mut raw = serde_json::Map::new();
        for (k, v) in params {
            raw.insert(k, Value::String(v));
        }
        if upper_method == "GET" || upper_method == "HEAD" {
            for (k, v) in query {
                raw.insert(k, Value::String(v));
            }
        } else if !body.is_empty() {
            match serde_json::from_slice::<Value>(body) {
                Ok(Value::Object(obj)) => {
                    for (k, v) in obj {
                        raw.insert(k, v);
                    }
                }
                _ => {} // 解析失败按空 body（对齐 readBody catch 空）
            }
        }
        matched = Some(dispatch(r.action, Value::Object(raw), "http"));
        break;
    }

    if let Some((status, payload)) = matched {
        send_json(stream, status, &payload);
    } else {
        send_json(
            stream,
            404,
            &json!({ "ok": false, "error": format!("接口不存在: {} {}", upper_method, path) }),
        );
    }
    clear_scope();
}

fn match_segments(segments: &[RouteSeg], path_segs: &[&str]) -> Option<Vec<(String, String)>> {
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
                params.push((name.clone(), super::spec::percent_decode(p)));
            }
        }
    }
    Some(params)
}

/// 起服务（阻塞）。返回实际监听的地址错误给调用方（EADDRINUSE 判定用）。
pub fn start_server(opts: ServerOptions) -> std::io::Result<TcpListener> {
    TcpListener::bind((opts.host, opts.port))
}

/// 接受循环（serve 主线程调用）。
pub fn serve_loop(listener: TcpListener, static_dir: &'static include_dir::Dir) {
    for conn in listener.incoming() {
        let Ok(mut stream) = conn else { continue };
        std::thread::spawn(move || {
            let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(120)));
            let Some((method, path, headers, body)) = read_request(&mut stream) else {
                return;
            };
            if path.starts_with("/api/") || path == "/api" {
                handle_api(&mut stream, &method, &path, &headers, &body);
            } else {
                send_static(&mut stream, &static_dir, &path);
            }
            let _ = stream.flush();
        });
    }
}

// route_specificity 目前由上面的排序内联实现；保留导出供测试
#[allow(dead_code)]
fn _touch_spec() {
    let _ = route_specificity("/api/x/:id");
}
