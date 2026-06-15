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
- [x] **B6 — Settle the M9-vs-M7.6 capture decision. DECIDED (2026-06-14): keep the existing
  shell-out capture for Linux; revisit capture tooling per-platform when that platform's port
  begins.** We *attempted* M9 (native `xcap`) but reverted it. Findings worth keeping:
  - `xcap` on Linux hard-depends on **PipeWire** (`libpipewire-0.3-dev` → `libspa-sys`/bindgen →
    `libclang`, plus `libgbm`/`libegl`/Wayland dev libs) — a heavy new system + packaging
    footprint, not the "zero external binaries" we expected.
  - The region-selector overlay needs a **transparent always-on-top window**, but WebKitGTK
    transparency on Linux is unreliable: the overlay rendered **opaque/black and trapped input**
    (only killing the app recovered). An in-app modal avoids the trap but can only select on a
    cramped, scaled-down multi-monitor preview. Neither was good enough to ship.
  - **Conclusion:** the current `flameshot → gnome-screenshot → grim+slurp` shell-out (with the
    missing-tool install hint) stays as the Linux path. For Windows (M7.6) pick a native Windows
    capture path *then*; macOS likewise (`screencapture -i`). A single cross-platform xcap path is
    not worth its Linux cost/instability. The `.deb` keeps its `gnome-screenshot` depends.
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

- [ ] **D10 — De-Linux the capture error string** in `Terminal.tsx` which hardcodes "flameshot
  or gnome-screenshot". Now that M9 is reverted (B6) and the shell-out capture stays, this hint
  is *correct* on Linux and stays; only generalise it when the Windows/macOS capture path lands
  (it can branch on platform then). Left as-is for now.

---

## Suggested sequencing

1. **A1–A3** — ~an hour of doc/branch hygiene. Do immediately.
2. **B5** (transport trait) and **B6** (capture decision) — the two that most reduce
   Windows risk, both pure Linux-side work.
3. **B4, C8–C9** — mechanical prep.
4. **D10** — whenever.
