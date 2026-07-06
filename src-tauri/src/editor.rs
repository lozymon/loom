// Launch the user's external code editor, detached from Loom. A pure OS concern: the TS
// side (src/lib/editor.ts) builds the argv — splitting the configured command, substituting the
// target folder — and Rust just spawns it. No product logic here (CLAUDE.md), and nothing about
// the pane's contents: this opens a folder, the same as `git`/`docs` reading a working dir.

use std::process::{Command, Stdio};

use crate::winproc::NoConsoleWindow;

/// Resolve a bare editor program name to a launchable path. On Windows, an editor's PATH entry is
/// often a batch wrapper (VS Code ships `code.cmd`, not `code.exe`), and `CreateProcessW` only
/// auto-appends `.exe` — so `Command::new("code")` fails with "program not found". Walk `PATH` ×
/// `PATHEXT` to find the real file (`code.cmd`, `subl.exe`, …); std (Rust ≥1.77) then runs a
/// resolved `.cmd`/`.bat` safely via its internal cmd wrapper. A name that already has an
/// extension or a path separator is used as-is; an unresolved name falls through unchanged so the
/// spawn still surfaces a normal "not found" error.
#[cfg(windows)]
fn resolve_program(program: &str) -> String {
    let p = std::path::Path::new(program);
    if p.extension().is_some() || program.contains(['\\', '/']) {
        return program.to_string();
    }
    let exts = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
    let path = std::env::var_os("PATH").unwrap_or_default();
    for dir in std::env::split_paths(&path) {
        for ext in exts.split(';').filter(|e| !e.is_empty()) {
            let cand = dir.join(format!("{program}{ext}"));
            if cand.is_file() {
                return cand.to_string_lossy().into_owned();
            }
        }
    }
    program.to_string()
}

#[cfg(not(windows))]
fn resolve_program(program: &str) -> String {
    program.to_string()
}

/// Spawn `program` with `args` in `cwd`, detached: no stdio wired to Loom and not awaited, so
/// a long-lived GUI editor keeps running independently. Used by the title-bar "Editor" button to
/// open the user's editor at the focused pane's working folder.
#[tauri::command]
pub fn open_editor(program: String, args: Vec<String>, cwd: Option<String>) -> Result<(), String> {
    if program.trim().is_empty() {
        return Err("no editor configured".into());
    }
    let resolved = resolve_program(program.trim());
    let mut cmd = Command::new(&resolved);
    cmd.args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .no_console_window();
    if let Some(dir) = cwd.as_deref().filter(|d| !d.is_empty()) {
        cmd.current_dir(dir);
    }
    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("failed to launch {program}: {e}"))
}
