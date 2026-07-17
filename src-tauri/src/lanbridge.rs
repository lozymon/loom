//! LAN bridge (Plan 02 L1b/L1c) — a WebSocket front-end onto the control bus for the local-first
//! mobile app. A *second transport* feeding the exact relay the unix socket does: each frame is a
//! `ControlRequest`, handed to `control::relay_request` tagged `origin: device:<name>` (rule 3.1),
//! so all routing + the deny-by-default policy stay in TS. Pure transport.
//!
//! Synchronous `tungstenite` (no async runtime), thread-per-connection — matching `control.rs`.
//!
//! **L1c: pairing + sealing (`lansec.rs`).** The bridge now REQUIRES a pre-shared pairing key. Each
//! connection runs a salt handshake and every control frame is ChaCha20-Poly1305 sealed under a
//! per-connection key. Because only the paired phone holds the key, binding to the LAN is safe — so
//! this binds `0.0.0.0` (reachable by the phone), not localhost. Pairing is revocable (`unpair`).

use std::net::{TcpListener, TcpStream, UdpSocket};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tungstenite::Message;

use crate::control::{relay_request, PendingReplies};
use crate::lansec::{random32, Sealed, KEY_LEN, SALT_LEN};

/// Placeholder Origin until per-Device pairing names land; every LAN request is remote, so the
/// deny-by-default policy governs it regardless of the exact name.
const ORIGIN: &str = "device:lan";
/// How long the accept loop blocks between checks of the `running` flag (so `stop` is responsive).
const ACCEPT_POLL: Duration = Duration::from_millis(200);

/// Bridge state, managed by Tauri. `running` is shared with the accept thread; `psk` is the pairing
/// key (None ⇒ not paired ⇒ the bridge refuses to start).
pub struct LanBridge {
    running: Arc<AtomicBool>,
    port: AtomicU16,
    psk: Mutex<Option<[u8; KEY_LEN]>>,
}

impl LanBridge {
    pub fn new() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            port: AtomicU16::new(0),
            psk: Mutex::new(None),
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
    paired: bool,
}

/// The bits a phone needs to pair, for the laptop to render as a QR: where to connect + the key.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingInfo {
    /// `ws://<lan-ip>:<port>` — the address the phone dials.
    url: String,
    host: String,
    port: u16,
    /// The 32-byte pairing key, base64. The phone stores this and derives the session key from it.
    key: String,
}

fn key_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("lan-pairing.key"))
}

/// Load the persisted pairing key, or `None` if unpaired.
fn load_psk(app: &AppHandle) -> Option<[u8; KEY_LEN]> {
    let bytes = std::fs::read(key_path(app).ok()?).ok()?;
    (bytes.len() == KEY_LEN).then(|| {
        let mut k = [0u8; KEY_LEN];
        k.copy_from_slice(&bytes);
        k
    })
}

/// Persist a pairing key (owner-only on unix — it is a secret at rest).
fn save_psk(app: &AppHandle, psk: &[u8; KEY_LEN]) -> Result<(), String> {
    let path = key_path(app)?;
    std::fs::write(&path, psk).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// The primary LAN IP, via the UDP-connect trick (no packets are sent — `connect` on a UDP socket
/// just fixes the local address the kernel would route from).
fn lan_ip() -> Option<String> {
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("8.8.8.8:80").ok()?;
    sock.local_addr().ok().map(|a| a.ip().to_string())
}

/// Pair this laptop: generate a fresh key, persist it, load it into the running state, and return
/// the info to display as a QR. Re-pairing rotates the key (invalidating any old Device).
#[tauri::command]
pub fn lan_bridge_pair(state: State<LanBridge>, app: AppHandle) -> Result<PairingInfo, String> {
    let key = random32();
    save_psk(&app, &key)?;
    *state.psk.lock().map_err(|e| e.to_string())? = Some(key);
    let host = lan_ip().unwrap_or_else(|| "127.0.0.1".to_string());
    let port = state.port.load(Ordering::Relaxed);
    Ok(PairingInfo {
        url: format!("ws://{host}:{port}"),
        host,
        port,
        key: base64::engine::general_purpose::STANDARD.encode(key),
    })
}

/// Revoke pairing: stop the bridge, drop the key from memory and disk. A lost phone is cut off.
#[tauri::command]
pub fn lan_bridge_unpair(state: State<LanBridge>, app: AppHandle) -> Result<(), String> {
    state.running.store(false, Ordering::Relaxed);
    *state.psk.lock().map_err(|e| e.to_string())? = None;
    let _ = std::fs::remove_file(key_path(&app)?);
    Ok(())
}

#[tauri::command]
pub fn lan_bridge_start(
    state: State<LanBridge>,
    pending: State<Arc<PendingReplies>>,
    app: AppHandle,
    port: u16,
) -> Result<BridgeStatus, String> {
    // Load a persisted key into memory if we haven't yet this run.
    {
        let mut guard = state.psk.lock().map_err(|e| e.to_string())?;
        if guard.is_none() {
            *guard = load_psk(&app);
        }
    }
    let psk = state
        .psk
        .lock()
        .map_err(|e| e.to_string())?
        .ok_or("not paired — call lan_bridge_pair first")?;
    start_on(&state, pending.inner().clone(), app, port, psk)
}

/// Start core, shared by the command and the dev env-var autostart. Binds first (so a port clash
/// surfaces synchronously), flips `running`, then spawns the accept loop.
fn start_on(
    bridge: &LanBridge,
    pending: Arc<PendingReplies>,
    app: AppHandle,
    port: u16,
    psk: [u8; KEY_LEN],
) -> Result<BridgeStatus, String> {
    if bridge.running.load(Ordering::Relaxed) {
        return Err("LAN bridge is already running".to_string());
    }
    // Paired ⇒ safe to bind the LAN (only the key-holder can drive; every frame is sealed).
    let listener =
        TcpListener::bind(("0.0.0.0", port)).map_err(|e| format!("bind :{port} failed: {e}"))?;
    let bound = listener.local_addr().map(|a| a.port()).unwrap_or(port);
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;

    bridge.running.store(true, Ordering::Relaxed);
    bridge.port.store(bound, Ordering::Relaxed);
    let running = bridge.running.clone();
    std::thread::spawn(move || accept_loop(listener, running, app, pending, psk));
    Ok(BridgeStatus {
        running: true,
        port: bound,
        paired: true,
    })
}

/// Dev/headless seam: if `$LOOM_LAN_BRIDGE_PORT` is set, pair from `$LOOM_LAN_BRIDGE_KEY` (base64
/// 32 bytes) and start at boot. Lets the sealed transport be exercised end to end before the
/// Settings UI (L2) exists. Ignored (with a log) on any bad value.
pub fn autostart_from_env(app: &AppHandle, bridge: &LanBridge, pending: Arc<PendingReplies>) {
    let Ok(raw_port) = std::env::var("LOOM_LAN_BRIDGE_PORT") else {
        return;
    };
    let Ok(port) = raw_port.trim().parse::<u16>() else {
        eprintln!("loom: LOOM_LAN_BRIDGE_PORT is not a valid port ({raw_port:?})");
        return;
    };
    let psk = match std::env::var("LOOM_LAN_BRIDGE_KEY") {
        Ok(b64) => match base64::engine::general_purpose::STANDARD.decode(b64.trim()) {
            Ok(b) if b.len() == KEY_LEN => {
                let mut k = [0u8; KEY_LEN];
                k.copy_from_slice(&b);
                k
            }
            _ => {
                eprintln!("loom: LOOM_LAN_BRIDGE_KEY must be base64 of 32 bytes");
                return;
            }
        },
        Err(_) => {
            eprintln!(
                "loom: LOOM_LAN_BRIDGE_PORT set but LOOM_LAN_BRIDGE_KEY missing — not starting"
            );
            return;
        }
    };
    if let Ok(mut g) = bridge.psk.lock() {
        *g = Some(psk);
    }
    match start_on(bridge, pending, app.clone(), port, psk) {
        Ok(s) => eprintln!(
            "loom: LAN bridge (dev) listening on 0.0.0.0:{} (paired)",
            s.port
        ),
        Err(e) => eprintln!("loom: LAN bridge autostart failed ({e})"),
    }
}

#[tauri::command]
pub fn lan_bridge_stop(state: State<LanBridge>) {
    state.running.store(false, Ordering::Relaxed);
}

#[tauri::command]
pub fn lan_bridge_status(state: State<LanBridge>) -> BridgeStatus {
    BridgeStatus {
        running: state.running.load(Ordering::Relaxed),
        port: state.port.load(Ordering::Relaxed),
        paired: state.psk.lock().map(|g| g.is_some()).unwrap_or(false),
    }
}

/// Accept connections until `running` clears. Non-blocking listener + a short poll so `stop` is
/// prompt without a self-connect trick.
fn accept_loop(
    listener: TcpListener,
    running: Arc<AtomicBool>,
    app: AppHandle,
    pending: Arc<PendingReplies>,
    psk: [u8; KEY_LEN],
) {
    while running.load(Ordering::Relaxed) {
        match listener.accept() {
            Ok((stream, _addr)) => {
                if stream.set_nonblocking(false).is_err() {
                    continue;
                }
                let app = app.clone();
                let pending = pending.clone();
                std::thread::spawn(move || handle_ws(stream, app, pending, psk));
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(ACCEPT_POLL);
            }
            Err(_) => break,
        }
    }
}

/// One WS connection: WebSocket handshake, then the sealing handshake (client_salt → server_salt),
/// then each sealed frame is opened, relayed through the shared bus relay, and the reply sealed
/// back. A bad frame (wrong key / replay) or a Close ends the connection.
fn handle_ws(stream: TcpStream, app: AppHandle, pending: Arc<PendingReplies>, psk: [u8; KEY_LEN]) {
    let mut ws = match tungstenite::accept(stream) {
        Ok(w) => w,
        Err(_) => return,
    };

    // Sealing handshake: the client's first frame is its 32-byte salt; we answer with ours.
    let client_salt = match ws.read() {
        Ok(Message::Binary(b)) if b.len() == SALT_LEN => {
            let mut s = [0u8; SALT_LEN];
            s.copy_from_slice(&b);
            s
        }
        _ => return, // not our protocol
    };
    let server_salt = random32();
    if ws.write(Message::binary(server_salt.to_vec())).is_err() || ws.flush().is_err() {
        return;
    }
    let mut sealed = Sealed::server(&psk, &client_salt, &server_salt);

    loop {
        match ws.read() {
            Ok(Message::Binary(frame)) => {
                let Ok(plaintext) = sealed.open(&frame) else {
                    break; // wrong key or replay — an unauthenticated/hostile peer; drop it
                };
                let Ok(request) = String::from_utf8(plaintext) else {
                    break;
                };
                let response = {
                    let peer = ws.get_ref();
                    relay_request(&app, &pending, request, ORIGIN, || tcp_peer_closed(peer))
                };
                let out = sealed.seal(response.as_bytes());
                if ws.write(Message::binary(out)).is_err() || ws.flush().is_err() {
                    break;
                }
            }
            Ok(Message::Ping(payload)) => {
                let _ = ws.write(Message::Pong(payload));
                let _ = ws.flush();
            }
            Ok(Message::Close(_)) => break,
            Ok(_) => {}
            Err(_) => break,
        }
    }
}

/// Non-destructively check whether the phone closed its end while a Clearance is parked (rule 3.4).
/// `TcpStream::peek` reads with `MSG_PEEK` — consumes nothing, so the WS framing is untouched.
fn tcp_peer_closed(stream: &TcpStream) -> bool {
    if stream.set_nonblocking(true).is_err() {
        return false;
    }
    let mut buf = [0u8; 1];
    let closed = match stream.peek(&mut buf) {
        Ok(0) => true,
        Ok(_) => false,
        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => false,
        Err(_) => true,
    };
    let _ = stream.set_nonblocking(false);
    closed
}
