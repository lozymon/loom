mod capture;
mod pty;
mod workspace;

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
    on_output: Channel<String>,
    on_exit: Channel<i32>,
) -> Result<u32, String> {
    pty::spawn(&mgr, cols, rows, command, cwd, shell, on_output, on_exit)
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(PtyManager::new())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            capture::capture_region,
            workspace::state_save,
            workspace::state_load,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
