// Screen-region capture: shell out to a desktop screenshot tool, let the user drag-select a
// region, save the result as a PNG in the temp dir, and return its path. The frontend types
// that path into the focused pane (so a CLI agent like Claude Code can read the image). This
// is an OS concern, so it lives in Rust (CLAUDE.md: OS/syscalls in Rust, UX/state in TS).
//
// Linux-first (X11/Wayland). Prefers flameshot (a region selector that streams raw PNG to
// stdout, so we own the filename), falling back to gnome-screenshot's area mode. A user who
// cancels the selection produces no file → we report it as a benign "cancelled" error.

use std::io::ErrorKind;
use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

/// A unique temp path like `/tmp/termhaus-snap-<nanos>.png`.
fn snap_path() -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("termhaus-snap-{nanos}.png"))
}

/// Capture a user-selected screen region to a PNG; returns its absolute path.
#[tauri::command]
pub fn capture_region() -> Result<String, String> {
    let path = snap_path();

    // flameshot: `gui --raw` opens the region selector and prints the PNG to stdout.
    match Command::new("flameshot").args(["gui", "--raw"]).output() {
        Ok(out) => {
            if !out.status.success() {
                return Err(format!("flameshot exited with {}", out.status));
            }
            if out.stdout.is_empty() {
                return Err("capture cancelled".into());
            }
            std::fs::write(&path, &out.stdout).map_err(|e| format!("failed to save snapshot: {e}"))?;
            return Ok(path.to_string_lossy().into_owned());
        }
        // Only fall through when flameshot isn't installed; surface other errors.
        Err(e) if e.kind() != ErrorKind::NotFound => {
            return Err(format!("failed to launch flameshot: {e}"));
        }
        Err(_) => {}
    }

    // gnome-screenshot: `-a` area-select, `-f` write straight to our file.
    match Command::new("gnome-screenshot")
        .args(["-a", "-f"])
        .arg(&path)
        .status()
    {
        Ok(status) => {
            if !status.success() || !path.exists() {
                return Err("capture cancelled".into());
            }
            Ok(path.to_string_lossy().into_owned())
        }
        Err(e) if e.kind() == ErrorKind::NotFound => {
            Err("no screenshot tool found — install flameshot or gnome-screenshot".into())
        }
        Err(e) => Err(format!("failed to launch gnome-screenshot: {e}")),
    }
}
