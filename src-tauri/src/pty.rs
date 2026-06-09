//! M0 PTY engine — one PtyManager owning N PTYs keyed by PaneId.
//!
//! Each pane is an OS pseudo-terminal (portable-pty) running a login shell. Output is
//! streamed to the webview over a Tauri Channel; a dedicated reader thread feeds a flusher
//! thread that COALESCES on time (~16ms) and size (32KB) before sending — capping the
//! per-pane message rate so a flood (`yes`) can't drown the IPC bridge. See ADR-0003.
//!
//! Transport note (M0 baseline): bytes are base64-encoded into a `Channel<String>`. This is
//! the simplest guaranteed-correct path and the explicit thing the M0 flood test measures.
//! If base64 is the bottleneck, the next step is raw-byte channels / a WebSocket (ADR-0003).

use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tauri::ipc::Channel;

/// Emit at most one frame to the webview per this interval (frame-rate cap), and
/// flush a partial buffer this long after the last byte when the pane goes idle.
const FLUSH_INTERVAL: Duration = Duration::from_millis(16);
/// Hard cap on bytes coalesced into a single frame. Bounds per-message size and,
/// combined with the bounded reader→flusher channel, bounds total memory.
const FRAME_MAX: usize = 64 * 1024;
/// Bounded reader→flusher channel depth. When the flusher can't keep up the reader
/// blocks here, stops draining the PTY, the kernel PTY buffer fills, and the child
/// (`yes`, a big `cat`) is back-pressured by the OS — no unbounded queue, bounded RAM.
const CHANNEL_DEPTH: usize = 16;

pub struct PtyManager {
    // Arc so the per-pane reaper thread can remove its own entry on child exit.
    panes: Arc<Mutex<HashMap<u32, Pane>>>,
    next_id: Mutex<u32>,
}

struct Pane {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    // Lets `kill` terminate the child from the command thread even though the `Child`
    // itself lives in (and is reaped by) the reader/flusher thread.
    killer: Box<dyn ChildKiller + Send + Sync>,
    // The shell child's OS pid, so the Source Control panel can read its live cwd from
    // `/proc/<pid>/cwd` (see `cwd` below). `None` if the platform didn't report one.
    pid: Option<u32>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            panes: Arc::new(Mutex::new(HashMap::new())),
            next_id: Mutex::new(1),
        }
    }
}

/// Pick the shell to launch. An explicit `pref` (the Settings "default shell") wins when it
/// names an existing binary; otherwise prefer `$SHELL` (set in any normal session); when that
/// is unset or names a missing binary — possible for a bare desktop-launcher start (M6) —
/// fall back to `/bin/bash`, then `/bin/sh`, which exist on every Linux target we support.
fn resolve_shell(pref: Option<&str>) -> String {
    if let Some(p) = pref.map(str::trim).filter(|p| !p.is_empty()) {
        if std::path::Path::new(p).exists() {
            return p.to_string();
        }
    }
    if let Ok(sh) = std::env::var("SHELL") {
        if !sh.is_empty() && std::path::Path::new(&sh).exists() {
            return sh;
        }
    }
    for candidate in ["/bin/bash", "/bin/sh"] {
        if std::path::Path::new(candidate).exists() {
            return candidate.to_string();
        }
    }
    "/bin/sh".to_string()
}

/// Spawn a login-interactive shell in a fresh PTY and start streaming its output.
/// Returns the new PaneId. See ADR-0004 for why we launch via the login shell.
#[allow(clippy::too_many_arguments)] // mirrors the IPC spawn payload (cols/rows/cmd/cwd/shell/channels)
pub fn spawn(
    mgr: &PtyManager,
    cols: u16,
    rows: u16,
    command: Option<String>,
    cwd: Option<String>,
    shell: Option<String>,
    name: Option<String>,
    log_path: Option<String>,
    on_output: Channel<String>,
    on_exit: Channel<i32>,
) -> Result<u32, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    // Always launch via the login shell so PATH / rc files / version managers load — a
    // plain pane gets an interactive `$SHELL -l`, a command pane gets `$SHELL -lc "<cmd>"`
    // (not a direct execvp), so a missing binary just prints into the pane and exits to a
    // Dead pane rather than failing the spawn. See ADR-0004. The `-l` is also what fixes
    // PATH when Termhaus is started from a desktop launcher (M6): a bundled launch inherits
    // only the session env, so the login shell must re-source the profile.
    let shell = resolve_shell(shell.as_deref());
    let mut cmd = CommandBuilder::new(&shell);
    cmd.arg("-l");
    if let Some(c) = command.as_deref().filter(|c| !c.trim().is_empty()) {
        cmd.arg("-c");
        cmd.arg(c);
    }
    // Start in the requested folder; fall back to $HOME if it's missing/unset (the wizard's
    // working folder may have been deleted between sessions — PLAN failure handling).
    let home = std::env::var("HOME").ok();
    let dir = cwd
        .filter(|d| std::path::Path::new(d).is_dir())
        .or_else(|| home.clone());
    if let Some(dir) = dir {
        cmd.cwd(dir);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    // Inter-pane control bus discovery (ADR-0007): tell the child where the socket is, what
    // its own pane is called (so an agent can address panes relative to itself), and make the
    // `th` CLI directly invokable by exposing its path and prepending its dir to PATH.
    cmd.env(
        "TERMHAUS_SOCK",
        crate::control::socket_path().to_string_lossy().into_owned(),
    );
    if let Some(name) = name.as_deref().filter(|n| !n.is_empty()) {
        cmd.env("TERMHAUS_PANE", name);
    }
    if let Some(cli) = crate::control::cli_path() {
        cmd.env("TERMHAUS_CLI", cli.to_string_lossy().into_owned());
        if let Some(dir) = cli.parent().map(|d| d.to_string_lossy().into_owned()) {
            let path = std::env::var("PATH").unwrap_or_default();
            cmd.env("PATH", format!("{dir}:{path}"));
        }
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    // A killer we can store in the Pane to terminate the child from `kill`, while the
    // `Child` itself moves into the reaper thread below for `wait()`.
    let killer = child.clone_killer();
    // Grab the pid before the `Child` moves into the reaper thread — used to read the
    // shell's live cwd for the Source Control panel.
    let pid = child.process_id();
    // Close our handle to the slave so EOF propagates when the child exits.
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    // Keep the master alive for resize() for the pane's lifetime.
    let master = pair.master;

    let id = {
        let mut next = mgr.next_id.lock().unwrap();
        let id = *next;
        *next += 1;
        id
    };

    // Reader thread: blocking reads off the PTY master -> raw chunks down a *bounded*
    // sync channel. When the flusher falls behind, `send` blocks here: the reader stops
    // draining the PTY, the kernel buffer fills, and the child is OS-back-pressured.
    let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(CHANNEL_DEPTH);
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF — child exited
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    // Optional session log (opt-in, per-pane): append the raw PTY output to a file as it
    // streams. This is product-driven (the frontend decides the path when logging is on) but
    // the *writing* is an OS concern, so it rides the flusher thread alongside the IPC send.
    // We tee the un-encoded bytes — the log is the verbatim terminal stream, escape codes and
    // all (matching what xterm received), never the base64 frames.
    let mut log = log_path
        .as_deref()
        .filter(|p| !p.trim().is_empty())
        .and_then(
            |p| match OpenOptions::new().create(true).append(true).open(p) {
                Ok(f) => Some(std::io::BufWriter::new(f)),
                Err(e) => {
                    eprintln!(
                        "termhaus: session log unavailable at {p} ({e}); logging off for this pane"
                    );
                    None
                }
            },
        );

    // Flusher thread: coalesce into one frame and emit at most once per FLUSH_INTERVAL.
    // The frame-rate cap is what keeps WebKitGTK alive under a flood — without it we'd
    // post to the IPC as fast as base64 runs and balloon the main process. acc is capped
    // at FRAME_MAX; when it's full we stop draining `rx`, which back-pressures the reader.
    let mut child = child;
    let panes = mgr.panes.clone();
    std::thread::spawn(move || {
        let engine = base64::engine::general_purpose::STANDARD;
        let mut acc: Vec<u8> = Vec::with_capacity(FRAME_MAX);
        // Block until the first byte of the next frame; `recv` erroring means the reader
        // is gone (child exited), which ends the loop and falls through to reaping.
        while let Ok(first) = rx.recv() {
            acc.extend_from_slice(&first);
            let frame_start = Instant::now();
            // Greedily coalesce whatever is already queued, up to the per-frame cap.
            // Leaving the rest in `rx` is deliberate: a full channel blocks the reader.
            while acc.len() < FRAME_MAX {
                match rx.try_recv() {
                    Ok(chunk) => acc.extend_from_slice(&chunk),
                    Err(_) => break,
                }
            }
            if let Some(w) = log.as_mut() {
                let _ = w.write_all(&acc);
                let _ = w.flush();
            }
            let _ = on_output.send(engine.encode(&acc));
            acc.clear();
            // Pace: hold the floor at one frame per FLUSH_INTERVAL so we never out-run
            // the webview's ability to render (the cause of the unbounded-memory flood).
            if let Some(rest) = FLUSH_INTERVAL.checked_sub(frame_start.elapsed()) {
                std::thread::sleep(rest);
            }
        }
        // Reap the child so it doesn't linger as a zombie, report its exit, and drop the
        // pane so a dead PaneId stops resolving (write/resize/kill become no-ops).
        let code = match child.wait() {
            Ok(status) => status.exit_code() as i32,
            Err(_) => -1,
        };
        let _ = on_exit.send(code);
        panes.lock().unwrap().remove(&id);
    });

    mgr.panes.lock().unwrap().insert(
        id,
        Pane {
            master,
            writer,
            killer,
            pid,
        },
    );
    Ok(id)
}

/// Best-effort current working directory of a pane's shell, read from `/proc/<pid>/cwd`.
/// This is the one place Termhaus inspects a pane's live process state — used only for the
/// explicit Source Control action to scope `git` to where the focused terminal actually is
/// (see ADR-0001's "live cwd" carve-out). Returns `None` (not an error) when the pid is
/// unknown or the link can't be read — e.g. the child already exited — so callers fall back.
#[cfg(unix)]
pub fn cwd(mgr: &PtyManager, id: u32) -> Result<Option<String>, String> {
    let pid = match mgr.panes.lock().unwrap().get(&id) {
        Some(p) => p.pid,
        None => return Ok(None),
    };
    let Some(pid) = pid else { return Ok(None) };
    match std::fs::read_link(format!("/proc/{pid}/cwd")) {
        Ok(path) => Ok(Some(path.to_string_lossy().into_owned())),
        Err(_) => Ok(None),
    }
}

/// Non-Unix stub: no `/proc`, so the panel falls back to the workspace folder (see M7).
#[cfg(not(unix))]
pub fn cwd(_mgr: &PtyManager, _id: u32) -> Result<Option<String>, String> {
    Ok(None)
}

/// Whether a pane is "busy" — running a foreground command rather than sitting at the shell
/// prompt. We read the PTY's foreground process group (`tcgetpgrp` on the master, via
/// portable-pty) and compare it to the shell's own pid: at the prompt the shell *is* the
/// foreground group leader, so a different leader means some child command holds the terminal.
/// This is a metadata signal (kernel process state), never pane output — it stays inside
/// ADR-0001's opacity rule, the same carve-out as `cwd`. `None` when the answer is unknown
/// (pid/leader unavailable, e.g. the child just exited) so the UI shows no busy state.
#[cfg(unix)]
pub fn busy(mgr: &PtyManager, id: u32) -> Result<Option<bool>, String> {
    let panes = mgr.panes.lock().unwrap();
    let Some(pane) = panes.get(&id) else {
        return Ok(None);
    };
    let Some(pid) = pane.pid else {
        return Ok(None);
    };
    match pane.master.process_group_leader() {
        Some(leader) => Ok(Some(leader != pid as i32)),
        None => Ok(None),
    }
}

/// Non-Unix stub: no foreground-process-group query, so panes never report busy (see M7).
#[cfg(not(unix))]
pub fn busy(_mgr: &PtyManager, _id: u32) -> Result<Option<bool>, String> {
    Ok(None)
}

/// Forward keystrokes (UTF-8) from the webview into the pane's PTY.
pub fn write(mgr: &PtyManager, id: u32, data: &str) -> Result<(), String> {
    let mut panes = mgr.panes.lock().unwrap();
    let pane = panes.get_mut(&id).ok_or("no such pane")?;
    pane.writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    pane.writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

/// Tell the PTY its new dimensions (after the webview's fit addon recomputes cols/rows).
pub fn resize(mgr: &PtyManager, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let panes = mgr.panes.lock().unwrap();
    let pane = panes.get(&id).ok_or("no such pane")?;
    pane.master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Terminate a pane's child and drop its PTY. The reaper thread then fires `on_exit` and
/// removes the entry, so this is idempotent — killing an already-dead pane is a no-op.
pub fn kill(mgr: &PtyManager, id: u32) -> Result<(), String> {
    let mut pane = match mgr.panes.lock().unwrap().remove(&id) {
        Some(p) => p,
        None => return Ok(()),
    };
    let _ = pane.killer.kill();
    // Dropping `pane` here closes the master/writer; the reaper observes the child exit.
    Ok(())
}
