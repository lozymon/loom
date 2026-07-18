mod capture;
mod claude;
pub mod cli;
mod control;
mod control_sock;
mod control_transport;
mod docs;
mod editor;
mod git;
mod lanbridge;
mod lansec;
mod logs;
pub mod mcp;
mod pty;
mod sessionlog;
mod tray;
mod voce;
mod winproc;
mod workspace;

use std::sync::Arc;

use control::PendingReplies;
use pty::PtyManager;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

#[tauri::command]
#[allow(clippy::too_many_arguments)] // a flat IPC payload mirrors the JS spawn call 1:1
fn pty_spawn(
    app: AppHandle,
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
        &mgr, app, cols, rows, command, cwd, shell, name, log_path, on_output, on_exit,
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

/// Write the OS clipboard so a copy is readable by *other* applications.
///
/// tauri-plugin-clipboard-manager uses arboard, which — inside this WebKitGTK app on X11 — owns the
/// CLIPBOARD selection in a way that doesn't serve external requestors, so "copy in Loom → paste in
/// a browser" came back empty. On Linux we instead write through GTK's own clipboard (the toolkit
/// the webview already runs on), which exports correctly; other platforms keep the plugin path.
#[tauri::command]
fn clipboard_set_text(app: AppHandle, text: String) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        // GTK clipboard calls must run on the GTK main thread; the closure captures only the String.
        app.run_on_main_thread(move || {
            gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD).set_text(text.as_str());
        })
        .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "linux"))]
    {
        use tauri_plugin_clipboard_manager::ClipboardExt;
        app.clipboard().write_text(text).map_err(|e| e.to_string())
    }
}

// Polled per visible pane every ~2s (Terminal.tsx refreshLoc). `async` so Tauri runs these on
// its worker pool instead of the main (WebKitGTK UI) thread — a synchronous command blocks the
// render thread, and 12 panes each doing a /proc read + git spawn at once froze the UI for 1-2s.
// The bodies don't `.await`; `async` here only relocates them off the UI thread.
#[tauri::command]
async fn pty_cwd(mgr: State<'_, PtyManager>, id: u32) -> Result<Option<String>, String> {
    pty::cwd(&mgr, id)
}

#[tauri::command]
fn pty_retarget(
    mgr: State<PtyManager>,
    id: u32,
    on_output: Channel<String>,
    on_exit: Channel<i32>,
) -> Result<(), String> {
    pty::retarget(&mgr, id, on_output, on_exit)
}

#[tauri::command]
async fn pty_busy(mgr: State<'_, PtyManager>, id: u32) -> Result<Option<bool>, String> {
    pty::busy(&mgr, id)
}

#[tauri::command]
async fn pty_foreground(mgr: State<'_, PtyManager>, id: u32) -> Result<Option<String>, String> {
    pty::foreground(&mgr, id)
}

/// Batched title-bar poll: busy + foreground + cwd in one round-trip (see pty::meta). Replaces the
/// per-tick `pty_busy`/`pty_foreground`/`pty_cwd` trio for the Terminal poll; those stay for other
/// callers. `async` for the same off-UI-thread reason as its siblings above.
#[tauri::command]
async fn pty_meta(mgr: State<'_, PtyManager>, id: u32) -> Result<pty::PaneMeta, String> {
    pty::meta(&mgr, id)
}

/// Advisory: would this command's program resolve in a launched pane? Used by the wizard to
/// warn before spawning an agent that isn't installed. Never blocks a launch (see pty docs).
#[tauri::command]
fn pty_check_command(command: String, shell: Option<String>) -> bool {
    pty::check_command(&command, shell.as_deref())
}

/// Installed WSL distributions for the new-workspace shell picker (empty off Windows / when WSL
/// isn't installed). `async` so the `wsl.exe --list` subprocess runs off the UI thread.
#[tauri::command]
async fn wsl_distros() -> Result<Vec<String>, String> {
    Ok(pty::wsl_distros())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let pending = Arc::new(PendingReplies::new());
    tauri::Builder::default()
        .manage(PtyManager::new())
        .manage(pending.clone())
        .manage(lanbridge::LanBridge::new())
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
            pty_retarget,
            pty_busy,
            pty_foreground,
            pty_meta,
            pty_check_command,
            clipboard_set_text,
            wsl_distros,
            control::pane_cmd_reply,
            control::pane_cmd_parked,
            lanbridge::lan_bridge_enable,
            lanbridge::lan_bridge_stop,
            lanbridge::lan_bridge_status,
            lanbridge::lan_bridge_pair,
            lanbridge::lan_bridge_unpair,
            editor::open_editor,
            voce::voce_dictate,
            voce::voce_finish,
            voce::voce_cancel,
            capture::capture_region,
            git::git_status,
            git::git_branch,
            git::git_diff,
            git::git_stage,
            git::git_unstage,
            git::git_commit,
            docs::list_docs,
            docs::read_doc,
            logs::list_logs,
            logs::read_log_tail,
            logs::export_markdown,
            claude::list_claude_sessions,
            claude::claude_session_exists,
            claude::claude_usage,
            workspace::state_save,
            workspace::state_load,
            workspace::project_state_save,
            workspace::project_state_load,
            workspace::session_log_path,
            sessionlog::session_log_save_session,
            sessionlog::session_log_save_task,
            sessionlog::session_log_search,
            sessionlog::session_log_recent,
            sessionlog::session_log_prune,
            sessionlog::audit_log_save,
            sessionlog::audit_log_recent,
            sessionlog::audit_log_prune,
            sessionlog::audit_log_clear,
        ])
        .setup(move |app| {
            // Start the inter-pane control bus once the app handle exists (ADR-0007).
            control::start(app.handle().clone(), pending.clone());
            // Dev seam (Plan 02 L1b): start the LAN bridge at boot if $LOOM_LAN_BRIDGE_PORT is set.
            // Localhost-only, off unless the env var is present; the Settings toggle arrives in L1c.
            lanbridge::autostart_from_env(
                app.handle(),
                &app.state::<lanbridge::LanBridge>(),
                pending.clone(),
            );
            // Restore the LAN bridge if the operator left it enabled (Settings → Remote) — so remote
            // access survives a laptop reboot instead of needing a manual re-enable each time.
            lanbridge::autostart_if_enabled(
                app.handle(),
                &app.state::<lanbridge::LanBridge>(),
                pending.clone(),
            );
            // Open the durable Session/Task history DB (ADR-0009). A failure here is non-fatal —
            // the live in-memory store still works; we just lose persistence/search this run.
            match sessionlog::open(app.handle()) {
                Ok(conn) => {
                    app.manage(sessionlog::SessionLog(std::sync::Mutex::new(conn)));
                }
                Err(e) => eprintln!("loom: session history DB unavailable ({e})"),
            }
            // System tray (summon/hide). A missing tray host (some Linux sessions) is non-fatal.
            if let Err(e) = tray::build(app) {
                eprintln!("loom: system tray unavailable ({e})");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
