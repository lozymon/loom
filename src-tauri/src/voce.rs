// Launch `loom-voce` (the voice-dictation helper) for a single utterance, detached. A pure OS
// concern — like `editor.rs`, Rust just spawns the sibling binary; all product logic (which pane,
// the "listening" indicator) lives in TS. loom-voce transcribes one phrase and types it into the
// target pane over the control bus (`loom send <pane>`), so we inject the same bus-discovery env a
// PTY child gets (LOOM_SOCK + LOOM_BIN); it never parses pane output (ADR-0001 stays intact).

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};

use tauri::{AppHandle, Emitter};

/// Emitted to the webview when a spawned `loom-voce` exits (any outcome), so the pane's "listening"
/// indicator clears. Payload is the pane's routing name (its auto-name / `loom send` handle).
const VOCE_DONE_EVENT: &str = "voce://done";

/// Emitted per audio frame while a spawned `loom-voce` captures, carrying the mic level so the
/// webview can draw a live waveform. loom-voce prints `@LVL <rms>` lines on stdout (`--emit-levels`)
/// and we relay them as this event. Purely a UI meter — no pane *output* is ever read (ADR-0001).
const VOCE_LEVEL_EVENT: &str = "voce://level";

/// Payload for `voce://level`: which pane is capturing and its current mic RMS (0.0 = silence).
#[derive(Clone, serde::Serialize)]
struct VoceLevel {
    pane: String,
    level: f32,
}

/// A running `loom-voce` capture: the child (so `voce_cancel` can `kill()` it) plus its stdin pipe
/// (so `voce_finish` can send the "stop, transcribe, deliver" signal). Both are behind their own
/// lock so finish/cancel touch them briefly without contending with the reader thread, which only
/// locks the child (to `wait()`) after stdout EOF — by which point the process is already exiting.
struct Session {
    child: Mutex<Child>,
    stdin: Mutex<Option<ChildStdin>>,
}

/// Live captures keyed by pane name. Inserted on spawn; removed (and the child reaped) when the
/// helper exits, which the reader thread detects as stdout EOF.
fn active() -> &'static Mutex<HashMap<String, Arc<Session>>> {
    static ACTIVE: OnceLock<Mutex<HashMap<String, Arc<Session>>>> = OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The helper's binary name (Windows appends `.exe`, mirroring editor.rs's resolve).
fn voce_name() -> &'static str {
    if cfg!(windows) {
        "loom-voce.exe"
    } else {
        "loom-voce"
    }
}

/// Locate `loom-voce`, in order: an explicit `$LOOM_VOCE_BIN` override; a sibling of the running
/// `loom` binary (how it ships — same dir as `loom`); then the bare name on `PATH`.
///
/// The override matters in dev: loom-voce lives in this repo's `loom-voce/` crate but builds to its
/// own target dir (it's not a workspace member — kept out of Loom's default/CI build so the
/// whisper.cpp/cmake toolchain never touches it), so it isn't beside the dev `loom` binary. Point
/// `$LOOM_VOCE_BIN` at `loom-voce/target/release/loom-voce`, or just put it on `PATH`.
fn voce_bin() -> PathBuf {
    if let Some(p) = std::env::var_os("LOOM_VOCE_BIN") {
        let p = PathBuf::from(p);
        if p.is_file() {
            return p;
        }
    }
    if let Some(dir) = crate::control::loom_bin().and_then(|p| p.parent().map(PathBuf::from)) {
        let cand = dir.join(voce_name());
        if cand.is_file() {
            return cand;
        }
    }
    PathBuf::from(voce_name())
}

/// Spawn `loom-voce --once --hold --pane <pane>` detached: start a monologue capture that records
/// through pauses (no auto-stop on silence) until `voce_finish` signals it via stdin, then it
/// transcribes and delivers. Returns as soon as the child is launched; a background thread relays
/// mic levels, then emits `voce://done` when the helper exits (finished, cancelled, or failure) so
/// the frontend can clear the pane's "listening" state. The session is tracked in `active()` so
/// `voce_finish` and `voce_cancel` can reach it.
#[tauri::command]
pub fn voce_dictate(app: AppHandle, pane: String, model: Option<String>) -> Result<(), String> {
    if pane.trim().is_empty() {
        return Err("no pane to dictate into".into());
    }
    let bin = voce_bin();
    let mut cmd = Command::new(&bin);
    cmd.arg("--once")
        .arg("--pane")
        .arg(&pane)
        .arg("--emit-levels")
        .arg("--hold");
    if let Some(m) = model.as_deref().map(str::trim).filter(|m| !m.is_empty()) {
        cmd.arg("--model").arg(m);
    }
    // stdin is piped so `voce_finish` can signal "stop and deliver"; stdout is piped to relay `@LVL`
    // mic-level lines to the webview meter; stderr (human logs) is discarded.
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // loom-voce delivers its transcript by shelling out to `loom send <pane>`, which needs the bus
    // socket and the loom binary — give it the same discovery env a pane child gets (pty.rs).
    cmd.env("LOOM_SOCK", crate::control::endpoint());
    if let Some(loom) = crate::control::loom_bin() {
        cmd.env("LOOM_BIN", loom.to_string_lossy().into_owned());
    }

    let mut child = cmd.spawn().map_err(|e| {
        format!(
            "failed to launch {}: {e} (set $LOOM_VOCE_BIN, or install loom-voce next to loom / on PATH)",
            bin.display()
        )
    })?;

    // Take the pipes before we hand the child to the registry.
    let stdout = child.stdout.take();
    let stdin = child.stdin.take();
    let session = Arc::new(Session {
        child: Mutex::new(child),
        stdin: Mutex::new(stdin),
    });
    active()
        .lock()
        .unwrap()
        .insert(pane.clone(), session.clone());

    // One thread owns the lifecycle. While the helper captures it prints `@LVL <rms>` lines to
    // stdout, which we relay to the webview meter as `voce://level`. When stdout hits EOF the helper
    // is exiting — whether it finished (`voce_finish`), was killed (`voce_cancel`), or ended on its
    // own — so we reap the child, drop it from the registry, and emit `voce://done`.
    std::thread::spawn(move || {
        if let Some(stdout) = stdout {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Some(rest) = line.strip_prefix("@LVL ") {
                    if let Ok(level) = rest.trim().parse::<f32>() {
                        let _ = app.emit(
                            VOCE_LEVEL_EVENT,
                            VoceLevel {
                                pane: pane.clone(),
                                level,
                            },
                        );
                    }
                }
            }
        }
        let _ = session.child.lock().unwrap().wait();
        active().lock().unwrap().remove(&pane);
        let _ = app.emit(VOCE_DONE_EVENT, pane);
    });
    Ok(())
}

/// Finish the monologue capturing for `pane` (the <Enter> key in the listening overlay): stop
/// recording, transcribe what was captured, and deliver it. We close the helper's stdin (writing a
/// newline first, then dropping the pipe for a guaranteed EOF), which its stdin watcher reads as the
/// "stop" signal. The helper then transcribes, delivers, and exits — the reader thread's stdout EOF
/// drives the usual teardown. A no-op if nothing is capturing for that pane.
#[tauri::command]
pub fn voce_finish(pane: String) -> Result<(), String> {
    let session = active().lock().unwrap().get(&pane).cloned();
    if let Some(session) = session {
        if let Some(mut stdin) = session.stdin.lock().unwrap().take() {
            let _ = stdin.write_all(b"\n");
            let _ = stdin.flush();
            // `stdin` drops here → the pipe closes → EOF, in case the newline alone wasn't read.
        }
    }
    Ok(())
}

/// Abort the `loom-voce` capturing for `pane`, if any (Esc in the listening overlay). Killing it
/// closes its stdout, so the reader thread reaps it and emits `voce://done` — the same teardown as a
/// normal exit. A no-op if nothing is capturing for that pane. Since the helper only delivers its
/// transcript on a clean finish, cancelling discards the utterance (nothing is typed into the pane).
#[tauri::command]
pub fn voce_cancel(pane: String) -> Result<(), String> {
    let session = active().lock().unwrap().get(&pane).cloned();
    if let Some(session) = session {
        let _ = session.child.lock().unwrap().kill();
    }
    Ok(())
}
