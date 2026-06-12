mod capture;
mod control;
mod docs;
mod git;
mod logs;
mod pty;
mod tray;
mod workspace;

use std::sync::Arc;

use control::PendingReplies;
use pty::PtyManager;
use tauri::ipc::Channel;
use tauri::State;

#[tauri::command]
#[allow(clippy::too_many_arguments)] // a flat IPC payload mirrors the JS spawn call 1:1
fn pty_spawn(
    mgr: State<PtyManager>,
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
    pty::spawn(
        &mgr, cols, rows, command, cwd, shell, name, log_path, on_output, on_exit,
    )
}

#[tauri::command]
fn pty_write(mgr: State<PtyManager>, id: u32, data: String) -> Result<(), String> {
    pty::write(&mgr, id, &data)
}

#[tauri::command]
fn pty_resize(mgr: State<PtyManager>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    pty::resize(&mgr, id, cols, rows)
}

#[tauri::command]
fn pty_kill(mgr: State<PtyManager>, id: u32) -> Result<(), String> {
    pty::kill(&mgr, id)
}

#[tauri::command]
fn pty_cwd(mgr: State<PtyManager>, id: u32) -> Result<Option<String>, String> {
    pty::cwd(&mgr, id)
}

#[tauri::command]
fn pty_busy(mgr: State<PtyManager>, id: u32) -> Result<Option<bool>, String> {
    pty::busy(&mgr, id)
}

#[tauri::command]
fn pty_foreground(mgr: State<PtyManager>, id: u32) -> Result<Option<String>, String> {
    pty::foreground(&mgr, id)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let pending = Arc::new(PendingReplies::new());
    tauri::Builder::default()
        .manage(PtyManager::new())
        .manage(pending.clone())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        // The global summon/hide hotkey is registered from TS (it's a user setting); the plugin
        // just needs to be present so those JS register/unregister calls have a backend.
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            pty_cwd,
            pty_busy,
            pty_foreground,
            control::pane_cmd_reply,
            capture::capture_region,
            git::git_status,
            git::git_branch,
            git::git_diff,
            docs::list_docs,
            docs::read_doc,
            logs::list_logs,
            logs::read_log_tail,
            workspace::state_save,
            workspace::state_load,
            workspace::session_log_path,
        ])
        .setup(move |app| {
            // Start the inter-pane control bus once the app handle exists (ADR-0007).
            control::start(app.handle().clone(), pending.clone());
            // System tray (summon/hide). A missing tray host (some Linux sessions) is non-fatal.
            if let Err(e) = tray::build(app) {
                eprintln!("termhaus: system tray unavailable ({e})");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
