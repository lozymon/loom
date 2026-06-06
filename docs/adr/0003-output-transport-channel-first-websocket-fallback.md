# Output transport: Tauri Channel first, localhost WebSocket fallback

PTY output must reach the WebKitGTK webview fast enough to render terminal floods smoothly — the make-or-break risk. We commit to a `tauri::ipc::Channel` carrying coalesced raw bytes as the first choice because it adds no open port, no auth surface, and is idiomatic Tauri. But Tauri's IPC may JSON/base64-encode channel payloads crossing into WebKitGTK, so M0 is run as a spike with a defined acceptance bar; if the Channel cannot meet it even with coalescing, the named fallback is a localhost WebSocket served by Rust that streams true binary frames straight into the webview, bypassing the IPC bridge.

## Coalescing (applies to whichever transport)

Three dimensions, flush on whichever trips first: **time** (~8–16ms tick), **buffer size** (32–64KB), and a **per-flush byte cap** — a flooding pane drops intermediate already-scrolled-off bytes rather than shipping everything, since xterm only needs to reach the correct screen state.

## M0 acceptance bar (the gate)

- One pane running `yes` (unbounded flood): keystroke echo < ~100ms, no main-thread block > 100ms, memory bounded.
- 12 panes each streaming `find /` concurrently: all render, UI stays interactive, CPU sane.
- If the Channel misses this with coalescing + byte-cap, switch to the WebSocket fallback and re-test.

## M0 result (measured 2026-06-04, WebKitGTK 4.1 / Tauri 2.11 / Linux Mint)

**Channel + base64 PASSES the single-pane flood bar — no WebSocket fallback needed.** A single pane running `yes` (sustained flood) for 24s held steady at **~178 MB** main-process RSS and **~232 MB** web-process RSS, main thread at ~19% CPU, web render ~87% (one core, ~60 fps), screen scrolling live. The webview never locked up.

But this only held **after fixing a memory bug in the first cut**: the original reader→flusher path used an *unbounded* `mpsc::channel` and flushed on every 32KB fill with no rate cap, so under flood the main process ballooned 3.7→13.8 GB and did not drain after the producer died. The IPC/base64 was never the bottleneck the ADR worried about — *the unbounded queue and uncapped send rate were*.

The fix (see `src-tauri/src/pty.rs`): bounded `sync_channel`, a per-frame accumulator capped at `FRAME_MAX` (64KB), and **explicit pacing to one frame per `FLUSH_INTERVAL` (~16ms)**. The frame-rate cap is the load-bearing part — without it we post to the IPC as fast as base64 runs.

**Divergence from the coalescing spec above:** we chose **lossless PTY back-pressure over lossy drop-coalescing**. When the pipeline is full the reader stops draining the PTY, the kernel buffer fills, and the child (`yes`) blocks in `write()`. No "per-flush byte cap that drops intermediate bytes" — dropping raw terminal bytes risks tearing escape sequences, and back-pressure keeps the stream correct at the cost of throttling a flooding child to the delivered frame bandwidth (~4 MB/s at 64KB×60fps). Tune `FRAME_MAX`/`FLUSH_INTERVAL` if that ceiling bites real workloads.

**Still untested:** the 12-pane concurrent `find /` half of the bar — blocked on the split-grid layout (M1), since the app currently renders a single pane.

## Consequences

- The transport may change at M0 based on measurement; downstream code talks to a thin `ptyClient` abstraction so the swap doesn't touch callers.
- The WebSocket fallback, if taken, adds a port + lifecycle + a small local security surface to manage. **As of M0 it is not needed.**
