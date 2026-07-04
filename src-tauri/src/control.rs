//! Inter-pane control bus (ADR-0007). A unix-domain socket lets a process running *inside* a
//! pane (e.g. a `claude` CLI) address other panes — `list` / `send` / `spawn`. Rust is a PURE
//! RELAY here: it forwards the raw request *string* to the webview over a Tauri event and
//! writes back whatever the frontend replies. It never parses the protocol — that lives once
//! in `src/ipc/protocol.ts`, with all routing/naming/layout logic in TypeScript (CLAUDE.md's
//! "no product logic in Rust"). This is an inbound command channel and is deliberately
//! distinct from ADR-0001's opacity rule, which forbids parsing pane *output*.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{self, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::control_transport::{self, Stream};

/// The control-bus address, also injected to pane children as `$LOOM_SOCK`. Re-exported from
/// the transport seam so `pty.rs` keeps a single call site (`control::endpoint()`).
pub use crate::control_transport::endpoint;

/// How long a parked socket connection waits for the webview's reply before giving up.
const REPLY_TIMEOUT: Duration = Duration::from_secs(10);
/// The Tauri event the relay emits to the webview for each inbound request.
const EVENT: &str = "loom://pane-cmd";

/// Socket connections parked while the frontend handles their request, keyed by request id.
/// The accept thread inserts a sender and blocks on the matching receiver; `pane_cmd_reply`
/// looks the sender up by id and hands the response across.
#[derive(Default)]
pub struct PendingReplies {
    map: Mutex<HashMap<u32, SyncSender<String>>>,
    next_id: AtomicU32,
}

impl PendingReplies {
    pub fn new() -> Self {
        Self::default()
    }

    fn register(&self) -> (u32, mpsc::Receiver<String>) {
        // Previous value + 1, so ids start at 1 and never reuse 0 (a falsy id in JS).
        let id = self.next_id.fetch_add(1, Ordering::Relaxed).wrapping_add(1);
        let (tx, rx) = mpsc::sync_channel(1);
        self.map.lock().unwrap().insert(id, tx);
        (id, rx)
    }

    fn take(&self, id: u32) -> Option<SyncSender<String>> {
        self.map.lock().unwrap().remove(&id)
    }
}

/// Payload carried by the `loom://pane-cmd` event: the raw request line plus the id the
/// frontend must echo back via `pane_cmd_reply`.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ControlEvent {
    req_id: u32,
    request: String,
}

/// Absolute path to the running `loom` binary. The control CLI and the MCP server are subcommands
/// of it now (`loom <cmd>`, `loom mcp`), so this is the single thing panes need on PATH and in
/// `$LOOM_BIN` (e.g. for an agent's `.mcp.json` to launch `loom mcp`). `None` only if the OS can't
/// resolve our own executable path, in which case the bus still works via the raw socket.
pub fn loom_bin() -> Option<PathBuf> {
    std::env::current_exe().ok()
}

/// Bind the socket and start accepting on a background thread.
///
/// The path is fixed and shared, so we must distinguish a *stale* socket (left by a crashed
/// instance — safe to remove) from a *live* one (another running instance — must not clobber).
/// Probing with `connect` answers this: a refused connection means the file is orphaned, so we
/// unlink and bind; a successful connection means another instance owns the bus, so we bow out
/// rather than steal its path and orphan its listener (the bug that left a dead socket behind).
pub fn start(app: AppHandle, pending: Arc<PendingReplies>) {
    let addr = control_transport::endpoint();
    if control_transport::probe_alive(&addr) {
        eprintln!(
            "loom: another instance already owns the control socket at {addr}; bus disabled here"
        );
        return;
    }
    // No live listener answered — any endpoint left here is stale; `bind` clears it (and sets
    // owner-only perms) before binding.
    let listener = match control_transport::bind(&addr) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("loom: inter-pane control socket unavailable ({e}); bus disabled");
            return;
        }
    };
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let app = app.clone();
            let pending = pending.clone();
            // One thread per connection so a slow frontend reply can't block other callers.
            std::thread::spawn(move || handle_conn(stream, app, pending));
        }
    });
}

/// Read one newline-delimited request line, relay it to the webview, and write back the one
/// response line the frontend produces. Errors and timeouts become an `ok:false` response so
/// `loom` never hangs a pane.
fn handle_conn(stream: Stream, app: AppHandle, pending: Arc<PendingReplies>) {
    // `&Stream` reads and writes (UnixStream impls Read/Write for shared refs), so one handle
    // serves the whole request/response exchange without cloning.
    let request = match control_transport::read_line(&stream) {
        Ok(Some(r)) => r,
        _ => return, // EOF, blank line, or read error — nothing to relay
    };

    let (req_id, rx) = pending.register();
    if app.emit(EVENT, ControlEvent { req_id, request }).is_err() {
        pending.take(req_id);
        let _ = control_transport::write_line(&stream, r#"{"ok":false,"error":"app not ready"}"#);
        return;
    }
    let response = match rx.recv_timeout(REPLY_TIMEOUT) {
        Ok(r) => r,
        Err(_) => {
            pending.take(req_id);
            r#"{"ok":false,"error":"timed out waiting for app"}"#.to_string()
        }
    };
    let _ = control_transport::write_line(&stream, &response);
}

/// The frontend's answer to a relayed request. `response` is an opaque JSON string Rust does
/// not interpret; it is delivered verbatim to the parked socket connection for `req_id`.
#[tauri::command]
pub fn pane_cmd_reply(pending: State<Arc<PendingReplies>>, req_id: u32, response: String) {
    if let Some(tx) = pending.take(req_id) {
        let _ = tx.send(response);
    }
}

#[cfg(test)]
mod tests {
    use super::PendingReplies;

    #[test]
    fn register_ids_start_at_one_and_increment() {
        // ids are echoed back through JS, where 0 is falsy — so the first id must be 1, not 0.
        let pending = PendingReplies::new();
        let (id1, _rx1) = pending.register();
        let (id2, _rx2) = pending.register();
        assert_eq!(id1, 1, "first request id must be 1 (0 is falsy in JS)");
        assert_eq!(id2, 2, "ids increment per request");
    }

    #[test]
    fn take_hands_the_reply_across_then_clears_the_slot() {
        let pending = PendingReplies::new();
        let (id, rx) = pending.register();
        // `pane_cmd_reply` looks the parked sender up by id and hands the frontend's answer across.
        let tx = pending
            .take(id)
            .expect("a registered id is takeable exactly once");
        tx.send("response".to_string()).unwrap();
        assert_eq!(rx.recv().unwrap(), "response");
        // A second take (e.g. a duplicate/late reply, or reply-after-timeout) finds nothing — no panic.
        assert!(
            pending.take(id).is_none(),
            "the slot is gone after the first take"
        );
    }

    #[test]
    fn take_of_unknown_id_is_none() {
        let pending = PendingReplies::new();
        assert!(pending.take(999).is_none());
    }
}
