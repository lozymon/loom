//! Shared unix-socket client for the Termhaus control bus (ADR-0007): connect to `$TERMHAUS_SOCK`,
//! write one JSON request line, read one JSON response line. Both front-ends to the bus — the `th`
//! CLI and the `th-mcp` MCP server — use it, so they're two faces of the same relay (IDEAS.md's
//! agent-integration arc). Std + serde_json only (no Tauri lib), keeping both bins lightweight.
//!
//! Loose module under `src/` (not declared in lib.rs), pulled into each bin with `#[path = …]`, so
//! Cargo doesn't try to compile it as its own binary the way it would for a file in `src/bin/`.

use std::env;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;

use serde_json::Value;

/// Send one control request over the socket and return the parsed JSON response (`{ok, …}`).
pub fn send(req: &Value) -> Result<Value, String> {
    let path = env::var("TERMHAUS_SOCK")
        .map_err(|_| "TERMHAUS_SOCK not set — run this inside a Termhaus pane".to_string())?;
    let stream =
        UnixStream::connect(&path).map_err(|e| format!("cannot reach Termhaus at {path}: {e}"))?;
    let mut w = &stream;
    let line = serde_json::to_string(req).map_err(|e| e.to_string())?;
    w.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
    w.write_all(b"\n").map_err(|e| e.to_string())?;
    w.flush().ok();

    let mut reader = BufReader::new(&stream);
    let mut resp = String::new();
    reader.read_line(&mut resp).map_err(|e| e.to_string())?;
    if resp.trim().is_empty() {
        return Err("no response from Termhaus".into());
    }
    serde_json::from_str(resp.trim()).map_err(|e| format!("bad response: {e}"))
}
