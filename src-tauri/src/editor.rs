// Launch the user's external code editor, detached from Termhaus. A pure OS concern: the TS
// side (src/lib/editor.ts) builds the argv — splitting the configured command, substituting the
// target folder — and Rust just spawns it. No product logic here (CLAUDE.md), and nothing about
// the pane's contents: this opens a folder, the same as `git`/`docs` reading a working dir.

use std::process::{Command, Stdio};

/// Spawn `program` with `args` in `cwd`, detached: no stdio wired to Termhaus and not awaited, so
/// a long-lived GUI editor keeps running independently. Used by the title-bar "Editor" button to
/// open the user's editor at the focused pane's working folder.
#[tauri::command]
pub fn open_editor(program: String, args: Vec<String>, cwd: Option<String>) -> Result<(), String> {
    if program.trim().is_empty() {
        return Err("no editor configured".into());
    }
    let mut cmd = Command::new(&program);
    cmd.args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(dir) = cwd.as_deref().filter(|d| !d.is_empty()) {
        cmd.current_dir(dir);
    }
    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("failed to launch {program}: {e}"))
}
