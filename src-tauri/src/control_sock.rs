//! Shared client for the Loom control bus (ADR-0007): connect to `$LOOM_SOCK`, write one
//! JSON request line, read one JSON response line. The actual transport (unix-domain socket today;
//! a Windows named pipe at M7.5) lives behind `control_transport`, so this stays platform-neutral.
//! Both faces of the bus — the `loom` CLI (`cli.rs`) and the `loom mcp` MCP server (`mcp.rs`) — use
//! it, so they're two faces of the same relay (IDEAS.md's agent-integration arc). Std + serde_json
//! only (no Tauri lib), so the CLI/MCP dispatch in `main.rs` stays cheap to reach.

use std::env;

use serde_json::Value;

use crate::control_transport;

/// Send one control request over the bus and return the parsed JSON response (`{ok, …}`).
pub fn send(req: &Value) -> Result<Value, String> {
    let addr = env::var("LOOM_SOCK")
        .map_err(|_| "LOOM_SOCK not set — run this inside a Loom pane".to_string())?;
    let stream = control_transport::connect(&addr)
        .map_err(|e| format!("cannot reach Loom at {addr}: {e}"))?;
    let line = serde_json::to_string(req).map_err(|e| e.to_string())?;
    control_transport::write_line(&stream, &line).map_err(|e| e.to_string())?;
    match control_transport::read_line(&stream).map_err(|e| e.to_string())? {
        Some(resp) => serde_json::from_str(&resp).map_err(|e| format!("bad response: {e}")),
        None => Err("no response from Loom".into()),
    }
}
