// serve 的端口协商 + 浏览器打开策略 —— 与 core/serve-port.js 对齐。
// 所有 nx-xx 面板共用一份口径：靠 /api/bootstrap 的 app.name 认领彼此。

use std::net::{TcpListener, TcpStream};
use std::time::Duration;

pub const NO_OPEN_ENV: &str = "NX_SERVE_NO_OPEN";
pub const PROBE_TIMEOUT_MS: u64 = 1500;

/// 真值判定：1 / true / yes / on（大小写不敏感）算开。
pub fn is_env_truthy(value: Option<&str>) -> bool {
    matches!(
        value.map(|s| s.trim().to_lowercase()).as_deref(),
        Some("1") | Some("true") | Some("yes") | Some("on")
    )
}

/// 是否允许自动打开浏览器：--no-open > NX_SERVE_NO_OPEN > 默认允许。
pub fn auto_open_enabled(flag_no_open: bool) -> bool {
    if flag_no_open {
        return false;
    }
    !is_env_truthy(std::env::var(NO_OPEN_ENV).ok().as_deref())
}

#[derive(Debug, Clone, serde::Deserialize)]
struct BootstrapEnvelope {
    #[serde(default)]
    data: Option<serde_json::Value>,
}

struct ProbeResult {
    data: Option<serde_json::Value>,
    timed_out: bool,
}

fn probe_panel_once(port: u16, timeout_ms: u64) -> ProbeResult {
    let addr = format!("127.0.0.1:{}", port);
    let stream = connect_with_timeout(&addr, Duration::from_millis(timeout_ms));
    let Ok(mut stream) = stream else {
        // 连不上：不是「超时」而是「没在跑」。但 connect 拒绝与超时对决策等价——都不是面板
        return ProbeResult { data: None, timed_out: false };
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(timeout_ms)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(timeout_ms)));
    use std::io::{Read, Write};
    let req = format!(
        "GET /api/bootstrap HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
        port
    );
    if stream.write_all(req.as_bytes()).is_err() {
        return ProbeResult { data: None, timed_out: false };
    }
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.len() > 1024 * 1024 {
                    break;
                }
            }
            Err(_) => return ProbeResult { data: None, timed_out: true },
        }
    }
    let text = String::from_utf8_lossy(&buf);
    // 按 HTTP 响应切出 body
    let body = text
        .split_once("\r\n\r\n")
        .map(|(_, b)| b)
        .unwrap_or("");
    // chunked / 普通 body 都可能；找 JSON 信封
    let json_start = body.find("{\"ok\"").or_else(|| body.find("{\n  \"ok\""));
    let Some(js) = json_start else {
        return ProbeResult { data: None, timed_out: false };
    };
    let envelope: BootstrapEnvelope = match serde_json::from_str(&body[js..]) {
        Ok(e) => e,
        Err(_) => {
            // chunked 编码时 body 里可能夹长度行，尝试逐行找完整 JSON
            return ProbeResult { data: None, timed_out: false };
        }
    };
    ProbeResult { data: envelope.data, timed_out: false }
}

fn connect_with_timeout(addr: &str, timeout: Duration) -> std::io::Result<TcpStream> {
    let domain = std::net::ToSocketAddrs::to_socket_addrs(addr)?
        .next()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "no address"))?;
    TcpStream::connect_timeout(&domain, timeout)
}

#[allow(dead_code)]
pub fn probe_panel(port: u16) -> Option<serde_json::Value> {
    probe_panel_once(port, PROBE_TIMEOUT_MS).data
}

/// 从 start 起逐个试，返回第一个能监听的端口（最多试 50 个）。
pub fn find_free_port(start: u16) -> std::io::Result<u16> {
    for p in start..start + 50 {
        if let Ok(l) = TcpListener::bind(("127.0.0.1", p)) {
            drop(l);
            return Ok(p);
        }
    }
    Err(std::io::Error::new(std::io::ErrorKind::AddrInUse, "找不到空闲端口"))
}

pub struct PortDecision {
    pub action: &'static str, // reuse | shift
    pub port: u16,
    pub occupant: Option<String>,
    pub existing: Option<serde_json::Value>,
}

/// 端口冲突的统一决策：是自己的面板 → reuse；别的服务 → shift。
pub fn resolve_port_conflict(port: u16, app_name: &str) -> std::io::Result<PortDecision> {
    let mut probe = probe_panel_once(port, PROBE_TIMEOUT_MS);
    if probe.timed_out {
        probe = probe_panel_once(port, PROBE_TIMEOUT_MS);
    }
    let existing = probe.data.clone();
    let occupant = existing
        .as_ref()
        .and_then(|d| d.pointer("/app/name").and_then(|v| v.as_str()).map(|s| s.to_string()));
    if let (Some(name), Some(ex)) = (occupant.clone(), existing.clone()) {
        if name == app_name {
            return Ok(PortDecision { action: "reuse", port, occupant, existing: Some(ex) });
        }
    }
    let next = find_free_port(port + 1)?;
    Ok(PortDecision { action: "shift", port: next, occupant, existing })
}

pub fn describe_occupant(occupant: &Option<String>) -> String {
    occupant.clone().unwrap_or_else(|| "未知服务".into())
}
