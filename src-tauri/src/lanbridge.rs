//! LAN bridge (Plan 02 L1b) — a WebSocket front-end onto the control bus for the local-first mobile
//! app. It is a *second transport* feeding the exact relay the unix socket does: each WS text frame
//! is a `ControlRequest` line, handed to `control::relay_request` tagged `origin: device:<name>`
//! (ADR-0012 rule 3.1), so all routing and the deny-by-default policy stay in TS. Pure transport.
//!
//! Synchronous `tungstenite` (no async runtime), thread-per-connection — matching `control.rs`'s
//! std-threads model rather than pulling in tokio.
//!
//! **Off by default and localhost-only in L1b.** Binding to the LAN with no pairing would expose an
//! unauthenticated command channel to anyone on the Wi-Fi; pairing + frame encryption + LAN binding
//! all arrive together in L1c. Until then this binds `127.0.0.1` so the transport can be proven end
//! to end (from a local WS client) without exposing anything. The origin name is a placeholder
//! (`device:lan`) until pairing mints real Device identities.

use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, State};
use tungstenite::Message;

use crate::control::{relay_request, PendingReplies};

/// Placeholder Origin until L1c pairing mints per-Device names. Every LAN request is remote, so it
/// is governed by the deny-by-default policy table regardless of the exact name.
const ORIGIN: &str = "device:lan";
/// How long the accept loop blocks between checks of the `running` flag (so `stop` is responsive).
const ACCEPT_POLL: Duration = Duration::from_millis(200);

/// Bridge state, managed by Tauri. `running` is shared with the accept thread so `stop` can end it.
pub struct LanBridge {
    running: Arc<AtomicBool>,
    port: AtomicU16,
}

impl LanBridge {
    pub fn new() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            port: AtomicU16::new(0),
        }
    }
}

impl Default for LanBridge {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeStatus {
    running: bool,
    port: u16,
}

/// Start the LAN bridge on `127.0.0.1:<port>` (localhost-only in L1b). Idempotent-ish: errors if it
/// is already running. Binds first (so a port clash surfaces synchronously), then spawns the accept
/// loop.
#[tauri::command]
pub fn lan_bridge_start(
    state: State<LanBridge>,
    pending: State<Arc<PendingReplies>>,
    app: AppHandle,
    port: u16,
) -> Result<BridgeStatus, String> {
    start_on(&state, pending.inner().clone(), app, port)
}

/// Start core, shared by the command and the dev env-var autostart. Binds first (so a port clash
/// surfaces synchronously), flips `running`, then spawns the accept loop.
fn start_on(
    bridge: &LanBridge,
    pending: Arc<PendingReplies>,
    app: AppHandle,
    port: u16,
) -> Result<BridgeStatus, String> {
    if bridge.running.load(Ordering::Relaxed) {
        return Err("LAN bridge is already running".to_string());
    }
    let listener =
        TcpListener::bind(("127.0.0.1", port)).map_err(|e| format!("bind :{port} failed: {e}"))?;
    let bound = listener.local_addr().map(|a| a.port()).unwrap_or(port);
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;

    bridge.running.store(true, Ordering::Relaxed);
    bridge.port.store(bound, Ordering::Relaxed);
    let running = bridge.running.clone();
    std::thread::spawn(move || accept_loop(listener, running, app, pending));
    Ok(BridgeStatus {
        running: true,
        port: bound,
    })
}

/// Dev/headless seam: if `$LOOM_LAN_BRIDGE_PORT` is set, start the bridge at boot (localhost-only, as
/// always in L1b). Called from `lib.rs` setup. Lets the transport be exercised end to end before the
/// Settings toggle (L1c) exists; a bad value or a bind failure is logged and otherwise ignored.
pub fn autostart_from_env(app: &AppHandle, bridge: &LanBridge, pending: Arc<PendingReplies>) {
    let Ok(raw) = std::env::var("LOOM_LAN_BRIDGE_PORT") else {
        return;
    };
    let Ok(port) = raw.trim().parse::<u16>() else {
        eprintln!("loom: LOOM_LAN_BRIDGE_PORT is not a valid port ({raw:?})");
        return;
    };
    match start_on(bridge, pending, app.clone(), port) {
        Ok(s) => eprintln!("loom: LAN bridge (dev) listening on 127.0.0.1:{}", s.port),
        Err(e) => eprintln!("loom: LAN bridge autostart failed ({e})"),
    }
}

/// Stop the bridge — the accept loop notices on its next poll and exits; open connections drain on
/// their own next read.
#[tauri::command]
pub fn lan_bridge_stop(state: State<LanBridge>) {
    state.running.store(false, Ordering::Relaxed);
}

#[tauri::command]
pub fn lan_bridge_status(state: State<LanBridge>) -> BridgeStatus {
    BridgeStatus {
        running: state.running.load(Ordering::Relaxed),
        port: state.port.load(Ordering::Relaxed),
    }
}

/// Accept connections until `running` clears. Non-blocking listener + a short poll so `stop` is
/// prompt without a self-connect trick.
fn accept_loop(
    listener: TcpListener,
    running: Arc<AtomicBool>,
    app: AppHandle,
    pending: Arc<PendingReplies>,
) {
    while running.load(Ordering::Relaxed) {
        match listener.accept() {
            Ok((stream, _addr)) => {
                // The WS handshake + framing want a blocking stream.
                if stream.set_nonblocking(false).is_err() {
                    continue;
                }
                let app = app.clone();
                let pending = pending.clone();
                std::thread::spawn(move || handle_ws(stream, app, pending));
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(ACCEPT_POLL);
            }
            Err(_) => break, // listener broke — give up the loop
        }
    }
}

/// One WS connection: handshake, then relay each text frame through the shared bus relay and write
/// back the reply. A Close frame or any error ends the connection.
fn handle_ws(stream: TcpStream, app: AppHandle, pending: Arc<PendingReplies>) {
    let mut ws = match tungstenite::accept(stream) {
        Ok(w) => w,
        Err(_) => return, // not a WebSocket client / handshake failed
    };
    loop {
        match ws.read() {
            Ok(Message::Text(txt)) => {
                let request = txt.to_string();
                // Scope the borrow of the underlying stream (for the liveness peek) so it ends
                // before we write the reply back through `ws`.
                let response = {
                    let peer = ws.get_ref();
                    relay_request(&app, &pending, request, ORIGIN, || tcp_peer_closed(peer))
                };
                if ws.write(Message::text(response)).is_err() || ws.flush().is_err() {
                    break;
                }
            }
            Ok(Message::Ping(payload)) => {
                let _ = ws.write(Message::Pong(payload));
                let _ = ws.flush();
            }
            Ok(Message::Close(_)) => break,
            Ok(_) => {}      // Pong / Binary / Frame — ignore
            Err(_) => break, // peer gone or protocol error
        }
    }
}

/// Non-destructively check whether the phone closed its end while a Clearance is parked (rule 3.4).
/// `TcpStream::peek` (stable, unlike the unix side) reads with `MSG_PEEK` — it consumes nothing, so
/// the WS framing on the same stream is untouched. Conservative on error: a hard failure reads as
/// "gone" rather than risk a stuck Clearance.
fn tcp_peer_closed(stream: &TcpStream) -> bool {
    if stream.set_nonblocking(true).is_err() {
        return false;
    }
    let mut buf = [0u8; 1];
    let closed = match stream.peek(&mut buf) {
        Ok(0) => true,  // orderly EOF — phone gone
        Ok(_) => false, // a frame waiting, but alive
        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => false, // nothing pending — waiting
        Err(_) => true, // hard error — treat as gone
    };
    let _ = stream.set_nonblocking(false); // restore blocking for the WS IO
    closed
}
