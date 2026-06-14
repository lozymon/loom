# Pre-Windows Checklist

Loose ends to close on the **Linux side** before we open the Windows port (M7). The
porting work itself is already scoped in [PLAN.md](../PLAN.md) (M7.1–M7.6); this list is
the ground-clearing that should happen *first* so that effort branches off a clean,
accurate tree.

Status legend: `[ ]` todo · `[~]` in progress · `[x]` done

---

## A. Reconcile ground-truth (cheap — do first)

Stale or incorrect docs/state that would otherwise mislead the Windows effort.

- [x] **A1 — Fix CLAUDE.md line 7.** ~~It claims multi-window tear-off "lives on the
  `feat/multiwindow-teardown` branch pending live verification."~~ Updated to reflect that
  the feature is merged and shipping on `main` (`src/lib/detach.ts`, `DetachedPane.tsx`,
  `pty_retarget`).
- [x] **A2 — Decide fate of `origin/feat/fleet-ergonomics`.** Confirmed **fully contained
  in `main`** (0 unique commits; branch tip == merge-base). Nothing to salvage → **deleted
  the remote branch.**
- [x] **A3 — Verify multi-window tear-off live on Linux, record result.**
  `pty_retarget` re-points a live pane's output Channel to a new window — exactly the
  kind of thing that can behave differently under WebView2, so confirmed solid on Linux
  first. **Live test found a bug:** tearing off (or re-docking) a live pane dropped its
  painted scrollback — the PTY moves but the xterm buffer doesn't (`top` survived only
  because it repaints). **Fixed** via `@xterm/addon-serialize` + `src/lib/scrollback.ts`:
  snapshot on tear-off/close, replay on the other side (localStorage handoff, all-TS, no
  Rust change). `tsc` + 59 tests green; **user-verified live 2026-06-13** (history now
  transfers). Recorded in [docs/IDEAS.md](IDEAS.md) (Multi-window / tear-off entry).

## B. Make the Unix-only surface explicitly `#[cfg]`-clean

So M7's platform split is mechanical (additive `#[cfg(windows)]` arms), not archaeology.

- [x] **B4 — Wrap `pty.rs` shell spawning in `#[cfg(unix)]`** (M7.1 pre-work). **Done:**
  the launch model is now split into cfg-gated helpers — `resolve_shell`, `launch_command`
  (login args), `apply_locale_env` (TERM/COLORTERM), `home_dir` (HOME vs USERPROFILE),
  `command_resolves` (the `check_command` probe). Linux arms are the original behaviour,
  byte-identical and fully compile-checked here; Windows arms follow PLAN M7.1 (PowerShell /
  cmd, no login shell, USERPROFILE, advisory check skipped) and are **drafted but only
  compile on a Windows build — unverified on the Linux dev box, verify at M7.4** per the
  project's own deferral. The manual PATH `:` join was replaced with portable
  `std::env::join_paths` (no cfg, fully verified). clippy + fmt clean; `th spawn`
  round-trips a command pane through the new launch path unchanged.
- [x] **B5 — Define a control-bus transport seam, move UDS impl behind it** (M7.5
  pre-work). **Done:** new std-only `src-tauri/src/control_transport.rs` owns the transport
  (`endpoint`/`connect`/`bind`/`probe_alive`/`Stream`/`Listener` + line framing) behind
  `#[cfg(unix)]`; the Windows named-pipe arm drops into the same file at M7.5 with no change
  to `control.rs` (relay) or `control_sock.rs` (client). Wired into `lib.rs` + both bins via
  `#[path]` (mirrors `control_sock.rs`); `pty.rs` injects `control::endpoint()`. Linux build
  byte-identical (same XDG/tmp path, 0600 perms, stale-socket detection). `cargo check`
  (lib + th + th-mcp) + clippy + fmt all clean; **live-verified**: `th list` round-trips
  against the running app across both workspaces.
- [ ] **B6 — Settle the M9-vs-M7.6 capture decision. DECIDED (2026-06-13): do M9** (native
  `xcap` capture), not the cheap Windows gate-off. Rationale: capture today is a per-platform
  coin-flip on installed shell-out tools (unreliable even on Linux, absent on Windows/macOS);
  `xcap` is pure-Rust, zero external binaries, one code path across X11/Wayland/Windows/macOS,
  and it supersedes M7.6 + the macOS `screencapture -i` note while upgrading Linux too. Work:
  (1) Rust — add `xcap` + `image`, rewrite `capture.rs` to grab frames in-process, keep the
  command contract (PNG temp path / `"cancelled"`) so `Terminal.tsx` + `Ctrl+Shift+S` are
  untouched; (2) a transparent always-on-top Tauri overlay region-selector (multi-monitor
  coords, per-display DPI, freeze-frame, Esc-to-cancel — the real work).
- [x] **B7 — Confirm `/proc`-reader degradation is acceptable for Windows v1.** **DECIDED
  (2026-06-13): accept degraded for v1.** `pty_cwd`/`pty_busy`/`foreground` (`pty.rs` L341–434)
  already have `#[cfg(not(unix))]` stubs returning `None` → git/docs panels fall back to the
  workspace folder, no busy auto-flag, no live agent-badge. Zero extra work; not a blocker.

## C. Test / CI baseline

So a Windows regression is detectable from a box we *can't* run Windows on (M7.4 says
Windows verification can't be done from the Linux dev box).

- [x] **C8 — Add smoke-level Rust tests.** **Done:** 7 unit tests — transport line framing
  (`write_line`/`read_line` round-trip + EOF + blank-line over a `UnixStream` pair) and shell
  resolution (`resolve_shell` pref/fallback, `check_command` empty). First Rust tests in the
  repo; `cargo test --lib` builds the Tauri lib fine. All pass.
- [x] **C9 — Confirm Linux CI is green + decide the Windows-job approach.** **Done:** added a
  `cargo test --lib` step to the `rust-lint` CI job (reuses the clippy compile). Full Linux
  gate verified locally — `cargo fmt --all --check`, `cargo clippy --all-targets -D warnings`,
  `cargo test`, `npx tsc --noEmit`, `npm test` (59) all green. Windows-job approach is settled
  by PLAN M7.3 (a `tauri.windows.conf.json` overlay + a `windows-latest` job running
  `tauri build --bundles nsis`); **adding that job is M7.3 itself**, not pre-work.

## D. Optional polish

- [ ] **D10 — De-Linux the capture error string** in `Terminal.tsx` (L217–218) which
  hardcodes "flameshot or gnome-screenshot" (or let M9 remove it).

---

## Suggested sequencing

1. **A1–A3** — ~an hour of doc/branch hygiene. Do immediately.
2. **B5** (transport trait) and **B6** (capture decision) — the two that most reduce
   Windows risk, both pure Linux-side work.
3. **B4, C8–C9** — mechanical prep.
4. **D10** — whenever.
