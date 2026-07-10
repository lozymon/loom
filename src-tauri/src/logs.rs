//! Read-only access to the opt-in session logs (`settings.sessionLogging`) for the in-app log
//! viewer. Each pane appends its raw PTY output to `<app config dir>/logs/<name>.log` (see
//! `workspace::session_log_path`); these commands list those files and tail-read one. Filesystem
//! access is an OS concern → Rust (CLAUDE.md). Strictly read-only; nothing parses pane output for
//! product logic (ADR-0001) — this is the user explicitly opening a file they chose to record.

use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// One session-log file. `modified` is whole seconds since the Unix epoch (0 if unavailable), so
/// the UI can sort newest-first without pulling in a date crate.
#[derive(Serialize)]
pub struct LogEntry {
    name: String,
    path: String,
    size: u64,
    modified: u64,
}

/// The tail of a log: the last `<= max_bytes` decoded, whether it was truncated, and the full size.
#[derive(Serialize)]
pub struct LogTail {
    text: String,
    truncated: bool,
    size: u64,
}

fn logs_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("logs"))
}

/// List the `*.log` files under `<app config dir>/logs/`, newest-modified first. An absent dir
/// (logging never enabled) is a normal empty result, not an error.
#[tauri::command]
pub fn list_logs(app: AppHandle) -> Result<Vec<LogEntry>, String> {
    let dir = logs_dir(&app)?;
    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Ok(Vec::new()),
    };
    let mut out: Vec<LogEntry> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("log") {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        out.push(LogEntry {
            name: path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
            path: path.to_string_lossy().into_owned(),
            size: meta.len(),
            modified,
        });
    }
    out.sort_by(|a, b| {
        b.modified
            .cmp(&a.modified)
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(out)
}

/// Read the last `max_bytes` of a log file (lossily decoded). Reading from the tail keeps the
/// viewer responsive on logs that have grown to megabytes. The path must sit under the logs dir.
#[tauri::command]
pub fn read_log_tail(app: AppHandle, path: String, max_bytes: u64) -> Result<LogTail, String> {
    let dir = logs_dir(&app)?;
    let target = Path::new(&path);
    // Confine reads to the logs directory — the UI only ever passes paths it got from list_logs.
    if target.parent() != Some(dir.as_path()) {
        return Err("path is not a session log".into());
    }
    let cap = max_bytes.clamp(4 * 1024, 8 * 1024 * 1024);
    let mut file = fs::File::open(target).map_err(|e| format!("cannot read {path}: {e}"))?;
    let size = file.metadata().map_err(|e| e.to_string())?.len();
    let start = size.saturating_sub(cap);
    if start > 0 {
        file.seek(SeekFrom::Start(start))
            .map_err(|e| e.to_string())?;
    }
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok(LogTail {
        text: String::from_utf8_lossy(&buf).into_owned(),
        truncated: start > 0,
        size,
    })
}

/// Write an exported transcript (markdown) to a user-chosen `path` — the destination the save
/// dialog returned. Unlike the read commands this isn't confined to the logs dir: the user
/// explicitly picked where the artifact goes. Creates/overwrites the file.
#[tauri::command]
pub fn export_markdown(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content).map_err(|e| format!("cannot write {path}: {e}"))
}
