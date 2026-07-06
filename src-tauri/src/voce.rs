// Launch `loom-voce` (the voice-dictation helper) for a single utterance, detached. A pure OS
// concern — like `editor.rs`, Rust just spawns the sibling binary; all product logic (which pane,
// the "listening" indicator) lives in TS. loom-voce transcribes one phrase and types it into the
// target pane over the control bus (`loom send <pane>`), so we inject the same bus-discovery env a
// PTY child gets (LOOM_SOCK + LOOM_BIN); it never parses pane output (ADR-0001 stays intact).

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};

use crate::winproc::NoConsoleWindow;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

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

/// Emitted while a spawned `loom-voce` is fetching a Whisper model on first use — the one-time
/// download that would otherwise block startup invisibly (its stderr is `/dev/null`, so curl's own
/// progress bar is lost). We can't see loom-voce's stderr, but we *can* watch its cache: this fires
/// with `bytes` growing as the `.part` file fills, then once more with `done: true` when the model
/// lands (or the helper exits). The frontend shows a "Downloading model…" state so the wait reads as
/// progress, not a hang.
const VOCE_DOWNLOAD_EVENT: &str = "voce://download";

/// Payload for `voce://download`: which pane, which model, bytes fetched so far, and whether the
/// download has finished (model present) — `done: true` clears the frontend's downloading state.
#[derive(Clone, serde::Serialize)]
struct VoceDownload {
    pane: String,
    model: String,
    bytes: u64,
    done: bool,
}

/// loom-voce's model cache root, mirroring `stt.rs::cache_dir`: `$XDG_CACHE_HOME`, then
/// `$HOME/.cache` (Linux/macOS), then `%LOCALAPPDATA%`/`%USERPROFILE%\.cache` (Windows). `None` if
/// none resolve — we then skip the download indicator (loom-voce would fail the same way anyway).
fn cache_root() -> Option<PathBuf> {
    if let Some(x) = std::env::var_os("XDG_CACHE_HOME").filter(|s| !s.is_empty()) {
        return Some(PathBuf::from(x));
    }
    if let Some(h) = std::env::var_os("HOME").filter(|s| !s.is_empty()) {
        return Some(PathBuf::from(h).join(".cache"));
    }
    #[cfg(windows)]
    {
        if let Some(l) = std::env::var_os("LOCALAPPDATA").filter(|s| !s.is_empty()) {
            return Some(PathBuf::from(l));
        }
        if let Some(p) = std::env::var_os("USERPROFILE").filter(|s| !s.is_empty()) {
            return Some(PathBuf::from(p).join(".cache"));
        }
    }
    None
}

/// Where loom-voce caches a model and its in-progress `.part` file, mirroring `stt.rs::ensure_model`
/// exactly: `<cache>/loom-voce/ggml-<model>.bin`. Returns `(model_path, part_path)`.
fn model_cache_paths(model: &str) -> Option<(PathBuf, PathBuf)> {
    let bin = cache_root()?
        .join("loom-voce")
        .join(format!("ggml-{model}.bin"));
    let part = bin.with_extension("part");
    Some((bin, part))
}

/// True when a model file exists and is non-empty (a finished download).
fn model_present(path: &Path) -> bool {
    path.metadata().map(|m| m.len() > 0).unwrap_or(false)
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
        // Bundled-sidecar fallback: tauri's `externalBin` ships the helper beside `loom`, but may
        // leave the target-triple suffix on the name (`loom-voce-aarch64-apple-darwin`) rather than
        // the plain `loom-voce`. Accept the first `loom-voce`-prefixed sibling so resolution works
        // whichever way the bundle names it (Windows still requires the `.exe`).
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                let ok_ext = !cfg!(windows) || name.ends_with(".exe");
                if name.starts_with("loom-voce") && ok_ext && entry.path().is_file() {
                    return entry.path();
                }
            }
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
pub fn voce_dictate(
    app: AppHandle,
    pane: String,
    model: Option<String>,
    language: Option<String>,
) -> Result<(), String> {
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
    // The model loom-voce will load (its own default is base.en); resolve it here so we pass it
    // explicitly *and* know which cache file to watch for the first-use download below.
    let effective_model = model
        .as_deref()
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .unwrap_or("base.en")
        .to_string();
    cmd.arg("--model").arg(&effective_model);
    // Empty → omit the flag, so loom-voce auto-detects (the multi-language default).
    if let Some(l) = language.as_deref().map(str::trim).filter(|l| !l.is_empty()) {
        cmd.arg("--language").arg(l);
    }
    // stdin is piped so `voce_finish` can signal "stop and deliver"; stdout is piped to relay `@LVL`
    // mic-level lines to the webview meter; stderr (human logs) is discarded.
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .no_console_window();
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

    // Set true once the helper has exited, so the download poller (below) stops even if the model
    // never appeared (a failed/aborted download).
    let exited = Arc::new(AtomicBool::new(false));

    // First-use model download: loom-voce fetches the model inside `load()` — before it captures —
    // with its stderr discarded, so a big model (medium ≈ 1.5 GB) blocks startup invisibly. If the
    // model isn't cached yet, watch the cache and relay progress so the frontend can show it, rather
    // than sitting on a silent "Listening…". A no-op when the model is already present.
    if let Some((bin_path, part_path)) = model_cache_paths(&effective_model) {
        if !model_present(&bin_path) {
            let _ = app.emit(
                VOCE_DOWNLOAD_EVENT,
                VoceDownload {
                    pane: pane.clone(),
                    model: effective_model.clone(),
                    bytes: 0,
                    done: false,
                },
            );
            let app_dl = app.clone();
            let pane_dl = pane.clone();
            let model_dl = effective_model.clone();
            let exited_dl = exited.clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_millis(400));
                // Model landed (download finished + atomically renamed), or the helper exited before
                // it did — either way we're done watching. Clear the frontend's downloading state.
                let finished = model_present(&bin_path) || exited_dl.load(Ordering::Relaxed);
                let bytes = if finished {
                    0
                } else {
                    part_path.metadata().map(|m| m.len()).unwrap_or(0)
                };
                let _ = app_dl.emit(
                    VOCE_DOWNLOAD_EVENT,
                    VoceDownload {
                        pane: pane_dl.clone(),
                        model: model_dl.clone(),
                        bytes,
                        done: finished,
                    },
                );
                if finished {
                    break;
                }
            });
        }
    }

    // One thread owns the lifecycle. While the helper captures it prints `@LVL <rms>` lines to
    // stdout, which we relay to the webview meter as `voce://level`. When stdout hits EOF the helper
    // is exiting — whether it finished (`voce_finish`), was killed (`voce_cancel`), or ended on its
    // own — so we reap the child, drop it from the registry, and emit `voce://done`.
    let exited_reader = exited.clone();
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
        exited_reader.store(true, Ordering::Relaxed);
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
