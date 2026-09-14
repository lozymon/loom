# pty sidecar

Rust PTY process the hub spawns: `portable-pty` (ConPTY on Windows) with v1's coalescing reader and bounded back-pressure, streaming bytes to the hub over a local socket. Ported from v1 `src-tauri/src/pty.rs` in M2. No product logic (ADR-0002).
