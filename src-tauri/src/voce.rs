// Launch `loom-voce` (the voice-dictation helper) for a single utterance, detached. A pure OS
// concern — like `editor.rs`, Rust just spawns the sibling binary; all product logic (which pane,
// the "listening" indicator) lives in TS. loom-voce transcribes one phrase and types it into the
// target pane over the control bus (`loom send <pane>`), so we inject the same bus-discovery env a
// PTY child gets (LOOM_SOCK + LOOM_BIN); it never parses pane output (ADR-0001 stays intact).

use std::path::PathBuf;
use std::process::{Command, Stdio};

use tauri::{AppHandle, Emitter};

/// Emitted to the webview when a spawned `loom-voce` exits (any outcome), so the pane's "listening"
/// indicator clears. Payload is the pane's routing name (its auto-name / `loom send` handle).
const VOCE_DONE_EVENT: &str = "voce://done";

/// The helper's binary name (Windows appends `.exe`, mirroring editor.rs's resolve).
fn voce_name() -> &'static str {
    if cfg!(windows) {
        "loom-voce.exe"
    } else {
        "loom-voce"
    }
}

/// Locate `loom-voce`: prefer a sibling of the running `loom` binary (how it ships — same dir as
/// `loom`), falling back to the bare name so a dev with it on `PATH` still works.
fn voce_bin() -> PathBuf {
    if let Some(dir) = crate::control::loom_bin().and_then(|p| p.parent().map(PathBuf::from)) {
        let cand = dir.join(voce_name());
        if cand.is_file() {
            return cand;
        }
    }
    PathBuf::from(voce_name())
}

/// Spawn `loom-voce --once --pane <pane>` detached: capture one utterance, deliver it, exit. Returns
/// as soon as the child is launched; a background thread waits on it and emits `voce://done` so the
/// frontend can clear the pane's "listening" state whether it succeeded, heard nothing, or failed.
#[tauri::command]
pub fn voce_dictate(app: AppHandle, pane: String, model: Option<String>) -> Result<(), String> {
    if pane.trim().is_empty() {
        return Err("no pane to dictate into".into());
    }
    let bin = voce_bin();
    let mut cmd = Command::new(&bin);
    cmd.arg("--once").arg("--pane").arg(&pane);
    if let Some(m) = model.as_deref().map(str::trim).filter(|m| !m.is_empty()) {
        cmd.arg("--model").arg(m);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // loom-voce delivers its transcript by shelling out to `loom send <pane>`, which needs the bus
    // socket and the loom binary — give it the same discovery env a pane child gets (pty.rs).
    cmd.env("LOOM_SOCK", crate::control::endpoint());
    if let Some(loom) = crate::control::loom_bin() {
        cmd.env("LOOM_BIN", loom.to_string_lossy().into_owned());
    }

    let mut child = cmd.spawn().map_err(|e| {
        format!(
            "failed to launch {}: {e} (is loom-voce installed next to loom or on PATH?)",
            bin.display()
        )
    })?;

    // Fire-and-forget reaper: clear the indicator when the helper exits. A failed emit is harmless.
    std::thread::spawn(move || {
        let _ = child.wait();
        let _ = app.emit(VOCE_DONE_EVENT, pane);
    });
    Ok(())
}
