//! Inter-pane control bus (ADR-0007). A unix-domain socket lets a process running *inside* a
//! pane (e.g. a `claude` CLI) address other panes — `list` / `send` / `spawn`. Rust is a PURE
//! RELAY here: it forwards the raw request *string* to the webview over a Tauri event and
//! writes back whatever the frontend replies. It never parses the protocol — that lives once
//! in `src/ipc/protocol.ts`, with all routing/naming/layout logic in TypeScript (CLAUDE.md's
//! "no product logic in Rust"). This is an inbound command channel and is deliberately
//! distinct from ADR-0001's opacity rule, which forbids parsing pane *output*.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::control_transport::{self, Stream};

/// The control-bus address, also injected to pane children as `$LOOM_SOCK`. Re-exported from
/// the transport seam so `pty.rs` keeps a single call site (`control::endpoint()`).
pub use crate::control_transport::endpoint;

/// How long a parked socket connection waits for the webview's reply before giving up — the
/// backstop for a genuinely *wedged* frontend. A request that is deliberately waiting on a human
/// (a Clearance, ADR-0012 rule 3.4) calls `pane_cmd_parked` to lift this deadline; see `wait_reply`.
const REPLY_TIMEOUT: Duration = Duration::from_secs(10);
/// While parked on a human decision (no reply deadline), how often to poll the caller's socket for
/// EOF so a Clearance can be withdrawn the instant its caller stops waiting.
const LIVENESS_POLL: Duration = Duration::from_millis(200);
/// The Tauri event the relay emits to the webview for each inbound request.
const EVENT: &str = "loom://pane-cmd";
/// Emitted when a parked caller's socket closes before the frontend replied: the frontend must
/// withdraw any Clearance for this `req_id` (ADR-0012 rule 3.4 — a Clearance must never outlive its
/// caller, or an Approve would run a command nobody awaits).
const ABORT_EVENT: &str = "loom://pane-cmd-abort";

/// One parked socket connection: the channel to hand its reply back, plus whether the frontend has
/// declared it "waiting on a human" (a Clearance). A parked-on-human request drops the reply
/// deadline; see `wait_reply`.
struct Parked {
    tx: SyncSender<String>,
    /// Set by `pane_cmd_parked`. Shared with the accept thread, which reads it each poll tick.
    on_human: Arc<AtomicBool>,
}

/// Socket connections parked while the frontend handles their request, keyed by request id.
/// The accept thread inserts an entry and blocks on the matching receiver; `pane_cmd_reply`
/// looks the sender up by id and hands the response across.
#[derive(Default)]
pub struct PendingReplies {
    map: Mutex<HashMap<u32, Parked>>,
    next_id: AtomicU32,
}

impl PendingReplies {
    pub fn new() -> Self {
        Self::default()
    }

    fn register(&self) -> (u32, mpsc::Receiver<String>, Arc<AtomicBool>) {
        // Previous value + 1, so ids start at 1 and never reuse 0 (a falsy id in JS).
        let id = self.next_id.fetch_add(1, Ordering::Relaxed).wrapping_add(1);
        let (tx, rx) = mpsc::sync_channel(1);
        let on_human = Arc::new(AtomicBool::new(false));
        self.map.lock().unwrap().insert(
            id,
            Parked {
                tx,
                on_human: on_human.clone(),
            },
        );
        (id, rx, on_human)
    }

    fn take(&self, id: u32) -> Option<SyncSender<String>> {
        self.map.lock().unwrap().remove(&id).map(|p| p.tx)
    }

    /// Mark `id` as waiting on a human decision (a Clearance). Returns false if already gone (a
    /// reply or timeout raced in). Idempotent.
    fn mark_on_human(&self, id: u32) -> bool {
        match self.map.lock().unwrap().get(&id) {
            Some(p) => {
                p.on_human.store(true, Ordering::Relaxed);
                true
            }
            None => false,
        }
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

/// Payload for `loom://pane-cmd-abort`: withdraw any Clearance parked for this request, its caller
/// having stopped waiting (ADR-0012 rule 3.4).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AbortEvent {
    req_id: u32,
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

    let (req_id, rx, on_human) = pending.register();
    if app.emit(EVENT, ControlEvent { req_id, request }).is_err() {
        pending.take(req_id);
        let _ = control_transport::write_line(&stream, r#"{"ok":false,"error":"app not ready"}"#);
        return;
    }
    let response = wait_reply(&stream, &rx, &on_human, req_id, &app, &pending);
    let _ = control_transport::write_line(&stream, &response);
}

/// Block for the frontend's reply, honouring two regimes:
/// - **normal:** give up after `REPLY_TIMEOUT` (a wedged webview must never hang a pane).
/// - **parked on a human** (`pane_cmd_parked` flipped `on_human`, a Clearance — ADR-0012 rule 3.4):
///   drop that deadline, but poll the caller's socket every `LIVENESS_POLL`; if the caller stops
///   waiting, emit `ABORT_EVENT` so the frontend withdraws the Clearance, and stop waiting. This is
///   what keeps a Clearance from outliving its caller — the invariant behind the zombie-spawn fix.
fn wait_reply(
    stream: &Stream,
    rx: &mpsc::Receiver<String>,
    on_human: &AtomicBool,
    req_id: u32,
    app: &AppHandle,
    pending: &PendingReplies,
) -> String {
    const TIMED_OUT: &str = r#"{"ok":false,"error":"timed out waiting for app"}"#;
    // Only meaningful before `on_human` is set; a parked-on-human request ignores it.
    let deadline = std::time::Instant::now() + REPLY_TIMEOUT;
    loop {
        let human = on_human.load(Ordering::Relaxed);
        let tick = if human {
            LIVENESS_POLL
        } else {
            match deadline.checked_duration_since(std::time::Instant::now()) {
                Some(left) => left.min(LIVENESS_POLL),
                None => {
                    pending.take(req_id);
                    return TIMED_OUT.to_string();
                }
            }
        };
        match rx.recv_timeout(tick) {
            Ok(r) => return r,
            Err(RecvTimeoutError::Disconnected) => {
                pending.take(req_id);
                return TIMED_OUT.to_string();
            }
            Err(RecvTimeoutError::Timeout) => {
                // Withdraw only once the frontend has parked on a human AND the caller has left,
                // so a normal in-flight request is never aborted by a transient poll.
                if human && control_transport::peer_closed(stream) {
                    if pending.take(req_id).is_some() {
                        let _ = app.emit(ABORT_EVENT, AbortEvent { req_id });
                    }
                    // The caller is gone, so this reply reaches no one — return a total value.
                    return r#"{"ok":false,"error":"caller withdrew"}"#.to_string();
                }
            }
        }
    }
}

/// The frontend's answer to a relayed request. `response` is an opaque JSON string Rust does
/// not interpret; it is delivered verbatim to the parked socket connection for `req_id`.
#[tauri::command]
pub fn pane_cmd_reply(pending: State<Arc<PendingReplies>>, req_id: u32, response: String) {
    if let Some(tx) = pending.take(req_id) {
        let _ = tx.send(response);
    }
}

/// The frontend declares that `req_id` is now parked on a human decision (a Clearance, ADR-0012
/// rule 3.4), so its reply deadline should be lifted — a person may take minutes. The relay keeps
/// the connection alive and polls the caller's socket instead, aborting only if the caller leaves.
/// A no-op if the request already completed (reply/timeout raced in).
#[tauri::command]
pub fn pane_cmd_parked(pending: State<Arc<PendingReplies>>, req_id: u32) {
    pending.mark_on_human(req_id);
}

#[cfg(test)]
mod tests {
    use super::PendingReplies;
    use std::sync::atomic::Ordering;

    #[test]
    fn register_ids_start_at_one_and_increment() {
        // ids are echoed back through JS, where 0 is falsy — so the first id must be 1, not 0.
        let pending = PendingReplies::new();
        let (id1, _rx1, _h1) = pending.register();
        let (id2, _rx2, _h2) = pending.register();
        assert_eq!(id1, 1, "first request id must be 1 (0 is falsy in JS)");
        assert_eq!(id2, 2, "ids increment per request");
    }

    #[test]
    fn take_hands_the_reply_across_then_clears_the_slot() {
        let pending = PendingReplies::new();
        let (id, rx, _h) = pending.register();
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

    #[test]
    fn mark_on_human_sets_the_flag_and_is_gone_after_take() {
        let pending = PendingReplies::new();
        let (id, _rx, human) = pending.register();
        assert!(!human.load(Ordering::Relaxed), "starts not parked-on-human");
        assert!(pending.mark_on_human(id), "marks a live parked request");
        assert!(
            human.load(Ordering::Relaxed),
            "the flag the accept thread polls is set"
        );
        pending.take(id);
        assert!(
            !pending.mark_on_human(id),
            "a completed request can't be parked (reply/timeout raced in)"
        );
    }
}
