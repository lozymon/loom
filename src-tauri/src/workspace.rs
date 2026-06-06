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
    if !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
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
