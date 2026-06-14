//! Transport seam for the inter-pane control bus (ADR-0007 / PLAN M7.5).
//!
//! The line protocol — one JSON request line in, one JSON response line out — is platform-neutral
//! and lives in `control.rs` (the relay) and `control_sock.rs` (the `th` / `th-mcp` client). This
//! module is the ONLY place that knows *how the bytes travel*: a unix-domain socket today, behind
//! `#[cfg(unix)]`. The Windows named-pipe transport (M7.5) drops in here behind `#[cfg(windows)]`
//! by providing the same items — `Stream`, `Listener`, `endpoint`, `connect`, `bind`,
//! `probe_alive` — so neither the relay nor the client changes. Splitting it out now (Linux-only)
//! lets the seam be proven before any Windows code exists.
//!
//! Shared by the lib (`control.rs`) and both bins (`control_sock.rs`, pulled in via `#[path]`), so
//! it stays std-only — no Tauri, matching `control_sock.rs`. The platform `Stream` must implement
//! `Read`/`Write` on a *shared* `&Stream` (as `UnixStream` does), so the relay can read and write
//! over one borrowed handle without cloning it.

// Each side uses a different subset (the client connects + frames; the relay binds + accepts), so
// some items are unused per-target — the seam is deliberately whole, not trimmed to one caller.
#![allow(dead_code, unused_imports)]

use std::io::{self, BufRead, BufReader, Read, Write};

/// Write one newline-terminated line and flush. Transport-neutral framing.
pub fn write_line<W: Write>(mut w: W, payload: &str) -> io::Result<()> {
    w.write_all(payload.as_bytes())?;
    w.write_all(b"\n")?;
    w.flush()
}

/// Read one newline-terminated line, trimmed of the trailing newline. `Ok(None)` on EOF or a
/// blank line — callers treat both as "nothing to do".
pub fn read_line<R: Read>(r: R) -> io::Result<Option<String>> {
    let mut reader = BufReader::new(r);
    let mut line = String::new();
    if reader.read_line(&mut line)? == 0 {
        return Ok(None); // EOF
    }
    let trimmed = line.trim_end();
    Ok((!trimmed.is_empty()).then(|| trimmed.to_string()))
}

#[cfg(unix)]
pub use unix::{bind, connect, endpoint, probe_alive, Listener, Stream};

#[cfg(unix)]
mod unix {
    use std::io;
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::path::PathBuf;

    /// A connected bus stream. `&UnixStream` implements both `Read` and `Write`, so the relay reads
    /// and writes over a shared `&Stream` without cloning the handle.
    pub type Stream = UnixStream;
    /// Accepts connections via `.incoming()` (used by the relay's accept loop).
    pub type Listener = UnixListener;

    /// The server's bind address, also injected to pane children as `$TERMHAUS_SOCK`. Prefer
    /// `$XDG_RUNTIME_DIR` (a per-user, 0700 dir on every systemd Linux); fall back to a per-user
    /// name in `/tmp`. Same-user access is the whole trust boundary (ADR-0007) — the principals who
    /// can connect are exactly those who could already drive these terminals another way.
    pub fn endpoint() -> String {
        socket_path().to_string_lossy().into_owned()
    }

    fn socket_path() -> PathBuf {
        if let Some(dir) = std::env::var_os("XDG_RUNTIME_DIR") {
            let p = PathBuf::from(dir);
            if p.is_dir() {
                return p.join("termhaus.sock");
            }
        }
        let who = std::env::var("USER")
            .or_else(|_| std::env::var("LOGNAME"))
            .unwrap_or_else(|_| "user".to_string());
        std::env::temp_dir().join(format!("termhaus-{who}.sock"))
    }

    /// Connect to a running relay (the client reads the address from `$TERMHAUS_SOCK`).
    pub fn connect(addr: &str) -> io::Result<Stream> {
        UnixStream::connect(addr)
    }

    /// True if a live relay is already accepting at `addr` (vs a stale socket file left by a crash).
    pub fn probe_alive(addr: &str) -> bool {
        UnixStream::connect(addr).is_ok()
    }

    /// Bind a listener at `addr`, clearing any stale socket file first and restricting it to the
    /// owner (0600, belt-and-suspenders on the 0700 runtime dir). Callers MUST `probe_alive` first
    /// so a *live* instance is never clobbered.
    pub fn bind(addr: &str) -> io::Result<Listener> {
        let _ = std::fs::remove_file(addr);
        let listener = UnixListener::bind(addr)?;
        let _ = std::fs::set_permissions(addr, std::fs::Permissions::from_mode(0o600));
        Ok(listener)
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::{read_line, write_line};
    use std::os::unix::net::UnixStream;

    #[test]
    fn line_framing_round_trips() {
        let (a, b) = UnixStream::pair().unwrap();
        let req = r#"{"op":"list"}"#;
        write_line(&a, req).unwrap();
        assert_eq!(read_line(&b).unwrap().as_deref(), Some(req));
    }

    #[test]
    fn read_line_is_none_on_eof() {
        let (a, b) = UnixStream::pair().unwrap();
        drop(a); // close the write end → EOF on the read end
        assert_eq!(read_line(&b).unwrap(), None);
    }

    #[test]
    fn read_line_treats_blank_as_none() {
        let (a, b) = UnixStream::pair().unwrap();
        write_line(&a, "   ").unwrap(); // whitespace-only trims to empty → "nothing to do"
        assert_eq!(read_line(&b).unwrap(), None);
    }
}
