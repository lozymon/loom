// Screen-region capture: shell out to a desktop screenshot tool, let the user drag-select a
// region, save the result as a PNG in the temp dir, and return its path. The frontend types
// that path into the focused pane (so a CLI agent like Claude Code can read the image). This
// is an OS concern, so it lives in Rust (CLAUDE.md: OS/syscalls in Rust, UX/state in TS).
//
// Linux-first (X11/Wayland). Tries, in order: flameshot (a region selector that streams raw
// PNG to stdout, so we own the filename) → gnome-screenshot's area mode → grim+slurp (the
// wlroots-Wayland combo). A user who cancels the selection produces no file → we report it as
// a benign "cancelled" error; if none of the tools is installed we return a "no screenshot
// tool" error the frontend turns into an install hint.

// Two native region-capture paths: Linux shells out to flameshot/gnome-screenshot/grim (region
// selectors that hand us a PNG); Windows drives the built-in Snip & Sketch overlay
// (`ms-screenclip:`) via PowerShell and saves the snipped clipboard image. Both are interim until
// M9's xcap-based capture supersedes this whole file. `ErrorKind` is only used by the Unix chain.
#[cfg(unix)]
use std::io::ErrorKind;
use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

/// A unique temp path like `…/loom-snap-<nanos>.png` in the system temp dir.
fn snap_path() -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("loom-snap-{nanos}.png"))
}

/// Capture a user-selected screen region to a PNG; returns its absolute path.
#[cfg(unix)]
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
            std::fs::write(&path, &out.stdout)
                .map_err(|e| format!("failed to save snapshot: {e}"))?;
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
            return Ok(path.to_string_lossy().into_owned());
        }
        // Only fall through when gnome-screenshot isn't installed; surface other errors.
        Err(e) if e.kind() != ErrorKind::NotFound => {
            return Err(format!("failed to launch gnome-screenshot: {e}"));
        }
        Err(_) => {}
    }

    // grim + slurp: the wlroots-Wayland combo (Sway, Hyprland). `slurp` drags out a region
    // geometry, `grim -g` crops to it and writes our file. Does not cover GNOME/KDE Wayland,
    // which don't implement wlr-screencopy — those need gnome-screenshot/spectacle above.
    match Command::new("slurp").output() {
        Ok(sel) => {
            if !sel.status.success() || sel.stdout.is_empty() {
                return Err("capture cancelled".into());
            }
            let geom = String::from_utf8_lossy(&sel.stdout).trim().to_string();
            match Command::new("grim")
                .arg("-g")
                .arg(&geom)
                .arg(&path)
                .status()
            {
                Ok(status) if status.success() && path.exists() => {
                    return Ok(path.to_string_lossy().into_owned());
                }
                Ok(_) => return Err("capture cancelled".into()),
                Err(e) => return Err(format!("failed to launch grim: {e}")),
            }
        }
        // slurp missing → no tool at all; fall through to the final error.
        Err(e) if e.kind() != ErrorKind::NotFound => {
            return Err(format!("failed to launch slurp: {e}"));
        }
        Err(_) => {}
    }

    // The marker substring "no screenshot tool" is matched by the frontend (Terminal.tsx) to
    // show an install hint in the pane — keep it stable if you reword this.
    Err("no screenshot tool found — install flameshot, gnome-screenshot, or grim+slurp".into())
}

/// Windows: drive the built-in Snip & Sketch region selector (`ms-screenclip:`) and save the
/// snipped region — which it drops on the clipboard — to a PNG, returning its path. We let
/// PowerShell launch the URI, read the clipboard image, and PNG-encode it, so no image crate is
/// pulled in before M9's native xcap path. The clipboard *sequence number* is watched (not
/// cleared) so a cancelled snip leaves the user's existing clipboard untouched; pressing Esc
/// produces no new image, which times out into a benign "capture cancelled" (the frontend stays
/// silent on it, exactly like a cancelled Linux selection).
#[cfg(windows)]
#[tauri::command]
pub fn capture_region() -> Result<String, String> {
    let path = snap_path();

    // Single-quoted here-string (`@'…'@`) so PowerShell takes the C# verbatim. The out path is
    // passed via $env:TH_SNAP_OUT (set below) to avoid quoting it into the script. STA is required
    // for the WinForms clipboard; `-Sta` guarantees it. `ms-screenclip:` copies the region to the
    // clipboard by default (Snipping Tool's "auto copy"), which is what we read back.
    let script = r#"
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ThClip {
  [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
}
'@
$before = [ThClip]::GetClipboardSequenceNumber()
Start-Process 'ms-screenclip:'
$deadline = (Get-Date).AddSeconds(120)
$img = $null
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 200
  if ([ThClip]::GetClipboardSequenceNumber() -ne $before -and [System.Windows.Forms.Clipboard]::ContainsImage()) {
    $img = [System.Windows.Forms.Clipboard]::GetImage()
    break
  }
}
if ($null -eq $img) { [Console]::Error.WriteLine('cancelled'); exit 3 }
$img.Save($env:TH_SNAP_OUT, [System.Drawing.Imaging.ImageFormat]::Png)
"#;

    let status = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Sta", "-Command", script])
        .env("TH_SNAP_OUT", &path)
        .status()
        .map_err(|e| format!("failed to launch PowerShell for capture: {e}"))?;

    match status.code() {
        Some(0) if path.exists() => Ok(path.to_string_lossy().into_owned()),
        // Esc / timed-out snip — benign, surfaced like a cancelled Linux selection (silent).
        Some(3) => Err("capture cancelled".into()),
        Some(c) => Err(format!("capture failed (PowerShell exited {c})")),
        None => Err("capture failed (PowerShell terminated by a signal)".into()),
    }
}
