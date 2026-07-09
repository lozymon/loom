//! Tiny JSON persistence for the frontend's workspace/recents state.
//!
//! Rust deliberately stays schema-agnostic here: the layout tree, panes, and recents are
//! product/UX concepts that live in TypeScript (CLAUDE.md: "no product logic in Rust"). So
//! these commands just read/write an opaque JSON blob per `key` under the app config dir —
//! the frontend owns the shape. Keys are fixed names (`workspaces`, `recents`); we still
//! sanitise to keep them from escaping the config directory.

use std::fs;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

fn config_path(app: &AppHandle, key: &str) -> Result<PathBuf, String> {
    if !key
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(format!("invalid state key: {key}"));
    }
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("{key}.json")))
}

/// Persist `json` under `<app config dir>/<key>.json`.
#[tauri::command]
pub fn state_save(app: AppHandle, key: String, json: String) -> Result<(), String> {
    let path = config_path(&app, &key)?;
    fs::write(path, json).map_err(|e| e.to_string())
}

/// Load the JSON previously saved under `key`, or `None` if it was never written.
#[tauri::command]
pub fn state_load(app: AppHandle, key: String) -> Result<Option<String>, String> {
    let path = config_path(&app, &key)?;
    match fs::read_to_string(&path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Reject a state key that isn't a flat, safe filename stem.
fn safe_key(key: &str) -> Result<(), String> {
    if key.is_empty()
        || !key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(format!("invalid state key: {key}"));
    }
    Ok(())
}

/// Persist project-scoped JSON to `<dir>/.loom/<key>.json` (like VSCode's `.vscode/`). This is the
/// per-*project* store — data that belongs with the project and can be committed/shared (the task
/// board, etc.), as opposed to `state_save`'s per-user Loom config. Creates `.loom/` if needed.
#[tauri::command]
pub fn project_state_save(dir: String, key: String, json: String) -> Result<(), String> {
    safe_key(&key)?;
    let base = PathBuf::from(&dir);
    if !base.is_dir() {
        return Err(format!("not a directory: {dir}"));
    }
    let loom = base.join(".loom");
    fs::create_dir_all(&loom).map_err(|e| e.to_string())?;
    fs::write(loom.join(format!("{key}.json")), json).map_err(|e| e.to_string())
}

/// Load JSON from `<dir>/.loom/<key>.json`, or `None` if the project has none yet.
#[tauri::command]
pub fn project_state_load(dir: String, key: String) -> Result<Option<String>, String> {
    safe_key(&key)?;
    let path = PathBuf::from(&dir)
        .join(".loom")
        .join(format!("{key}.json"));
    match fs::read_to_string(&path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Resolve (and ensure the directory for) a session-log file under `<app config dir>/logs/`.
/// The frontend decides *whether* to log and what to call each pane's file (product logic); we
/// just turn that name into a safe absolute path the PTY engine can append to. `name` is
/// sanitised to a flat filename so it can't escape the logs directory.
#[tauri::command]
pub fn session_log_path(app: AppHandle, name: String) -> Result<String, String> {
    let safe: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let safe = safe.trim_matches('.');
    let stem = if safe.is_empty() { "pane" } else { safe };
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("logs");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir
        .join(format!("{stem}.log"))
        .to_string_lossy()
        .into_owned())
}
