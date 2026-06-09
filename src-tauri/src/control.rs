//! Inter-pane control bus (ADR-0007). A unix-domain socket lets a process running *inside* a
//! pane (e.g. a `claude` CLI) address other panes — `list` / `send` / `spawn`. Rust is a PURE
//! RELAY here: it forwards the raw request *string* to the webview over a Tauri event and
//! writes back whatever the frontend replies. It never parses the protocol — that lives once
//! in `src/ipc/protocol.ts`, with all routing/naming/layout logic in TypeScript (CLAUDE.md's
//! "no product logic in Rust"). This is an inbound command channel and is deliberately
//! distinct from ADR-0001's opacity rule, which forbids parsing pane *output*.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{self, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

/// How long a parked socket connection waits for the webview's reply before giving up.
const REPLY_TIMEOUT: Duration = Duration::from_secs(10);
/// The Tauri event the relay emits to the webview for each inbound request.
const EVENT: &str = "termhaus://pane-cmd";

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

/// Payload carried by the `termhaus://pane-cmd` event: the raw request line plus the id the
/// frontend must echo back via `pane_cmd_reply`.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ControlEvent {
    req_id: u32,
    request: String,
}

/// Where the control socket lives. Prefer `$XDG_RUNTIME_DIR` (a per-user, 0700 dir on every
/// systemd Linux); fall back to a per-user name in `/tmp`. Same-user access is the whole
/// trust boundary (ADR-0007) — the set of principals who can connect is exactly those who
/// could already drive these terminals another way.
pub fn socket_path() -> PathBuf {
    if let Some(dir) = std::env::var_os("XDG_RUNTIME_DIR") {
        let p = PathBuf::from(dir);
        if p.is_dir() {
            return p.join("termhaus.sock");
        }
    }
    let who = std::env::var("USER")
        .or_else(|_| std::env::var("LOGNAME"))
        .unwrap_or_else(|_| "user".to_string());
    std::env::temp_dir().join(format!("termhaus-{who}.sock"))
}

/// Absolute path to the `th` CLI, which sits beside the running app binary in `target/…`
/// (dev) or the install bindir (packaged). `None` if it isn't built yet — the bus still
/// works, callers just have to invoke the socket directly.
pub fn cli_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let cand = exe.parent()?.join("th");
    cand.exists().then_some(cand)
}

/// Bind the socket and start accepting on a background thread.
///
/// The path is fixed and shared, so we must distinguish a *stale* socket (left by a crashed
/// instance — safe to remove) from a *live* one (another running instance — must not clobber).
/// Probing with `connect` answers this: a refused connection means the file is orphaned, so we
/// unlink and bind; a successful connection means another instance owns the bus, so we bow out
/// rather than steal its path and orphan its listener (the bug that left a dead socket behind).
pub fn start(app: AppHandle, pending: Arc<PendingReplies>) {
    let path = socket_path();
    if UnixStream::connect(&path).is_ok() {
        eprintln!(
            "termhaus: another instance already owns the control socket at {}; bus disabled here",
            path.display()
        );
        return;
    }
    // No live listener answered — any file here is stale; clear it before binding.
    let _ = std::fs::remove_file(&path);
    let listener = match UnixListener::bind(&path) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("termhaus: inter-pane control socket unavailable ({e}); bus disabled");
            return;
        }
    };
    // Owner-only: belt-and-suspenders on top of the 0700 runtime dir.
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
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
/// `th` never hangs a pane.
fn handle_conn(stream: UnixStream, app: AppHandle, pending: Arc<PendingReplies>) {
    let Ok(read_half) = stream.try_clone() else {
        return;
    };
    let mut reader = BufReader::new(read_half);
    let mut line = String::new();
    if reader.read_line(&mut line).is_err() {
        return;
    }
    let request = line.trim_end().to_string();
    if request.is_empty() {
        return;
    }

    let (req_id, rx) = pending.register();
    if app.emit(EVENT, ControlEvent { req_id, request }).is_err() {
        pending.take(req_id);
        write_line(&stream, r#"{"ok":false,"error":"app not ready"}"#);
        return;
    }
    let response = match rx.recv_timeout(REPLY_TIMEOUT) {
        Ok(r) => r,
        Err(_) => {
            pending.take(req_id);
            r#"{"ok":false,"error":"timed out waiting for app"}"#.to_string()
        }
    };
    write_line(&stream, &response);
}

fn write_line(stream: &UnixStream, payload: &str) {
    let mut w = stream;
    let _ = w.write_all(payload.as_bytes());
    let _ = w.write_all(b"\n");
    let _ = w.flush();
}

/// The frontend's answer to a relayed request. `response` is an opaque JSON string Rust does
/// not interpret; it is delivered verbatim to the parked socket connection for `req_id`.
#[tauri::command]
pub fn pane_cmd_reply(pending: State<Arc<PendingReplies>>, req_id: u32, response: String) {
    if let Some(tx) = pending.take(req_id) {
        let _ = tx.send(response);
    }
}
