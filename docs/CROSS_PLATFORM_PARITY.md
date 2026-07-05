# Cross-Platform Parity Plan — one code path, three targets

Goal: **every feature works on Linux, Windows, and macOS**, achieved not by adding a third
special case everywhere but by **deleting per-OS branches** — replacing shell-outs to OS binaries
(`flameshot`, `parecord`, `gnome-screenshot`) and hand-rolled syscalls (`/proc`, raw Win32) with
**one pure-Rust cross-platform path per feature**, verified on all three by CI. This continues the
move already made for the control bus (the `control_transport.rs` seam, M7.5).

Status today (the honest baseline):
- **Linux** — full-featured, primary target.
- **Windows** — shipping since M7 (NSIS installer, ConPTY panes, named-pipe bus, Snip & Sketch
  capture). Degraded: no process floor (`/proc` stubs → `None`).
- **macOS** — not yet built. Unix-shared code (PTY, UDS bus, login shells, git panel) works for
  free; the gaps are the same ones Windows degrades on, plus packaging.

> Status legend: `[ ]` todo · `[~]` in progress · `[x]` done
> Verification note: this dev box is **Linux**. Every change is verified locally on Linux
> (`cargo fmt`/`clippy`/`test` + `tsc` + `npm test`) and **cross-checked on Windows/macOS by CI**.
> Unlike Windows (mingw `cargo check` cross-compiles from Linux), there is **no cheap Linux→macOS
> check** (needs the Apple SDK), so a real `macos-latest` runner is the *only* macOS verifier —
> which is why Phase 0 comes first.

---

## The principle

The pain of N platforms comes from two habits. Kill both:

1. **Shelling out to OS-specific binaries** → replace with a pure-Rust crate that works everywhere.
2. **Hand-rolling OS syscalls behind `#[cfg]`** → replace with a cross-platform crate, or lean on
   an abstraction that already spans platforms (`portable-pty`).

What legitimately *stays* `#[cfg]` (genuine semantic differences, not worth fighting): login shell
vs PowerShell (no login concept on Windows), path separators / `/dev/null` vs `nul`, and per-store
signing. Everything else collapses to one path.

---

## Phase 0 — Parity harness (do first; it's the only macOS verifier)  `[~]`

- [x] **P0.1 — Add a `macos-latest` lint/test job to CI** (`.github/workflows/ci.yml`), mirroring
  `rust-lint`: `cargo fmt --check` + `clippy -D warnings` + `cargo test --lib`. macOS runners use
  the system WKWebView; no apt step. This is the keystone — it's what makes every later phase
  verifiable. **Done + verified:** `macos-lint` job added (runs on every push/PR); **green on its
  first real run** (PR #23, 2m38s) — the macOS arm is now actually exercised, not just assumed.
- [x] **P0.2 — Added the gated `macos-build` job** (dmg bundle) on release tags / `workflow_dispatch`,
  mirroring `windows-build`; uploads the `loom-macos-dmg` artifact and wired into the `release` job's
  `needs` + asset download. **Verified: the dmg built green** on a real `macos-latest` runner
  (dispatch run) — macOS now produces an installable app, not just a lint pass. **Notes:** the dmg is
  **unsigned** for now (Gatekeeper warns until notarization — Phase 5); `loom-voce` is **not** bundled
  (voice stays Linux-only until cpal, Phase 2), matching the Windows build; single-arch **arm64**.
- [x] **P0.3 — Added `tauri.macos.conf.json` overlay** (`"targets": ["dmg"]` + `minimumSystemVersion`);
  the base config already carried `identifier` (`com.loom.app`), `category`, and `icon.icns`, so no
  base change was needed. Linux `["deb","appimage"]` untouched (same pattern as the Windows overlay).
- [ ] **P0.4 — Runtime transparency check (mac).** The app window is `transparent: true` +
  `decorations: false` (frameless redesign). On macOS a transparent window may need
  `app.macOSPrivateApi: true` / an entitlement — a *runtime* concern the dmg build won't catch.
  Verify on first real Mac launch; flip the flag if the window renders opaque/black.

## Phase 1 — Process floor via `sysinfo` (unify `/proc` + stubs → one path)  `[x]` DONE

The floor (live cwd + foreground command + busy) drives the git/docs panel's live-cwd scoping and
the agent badge. Was Linux-only `/proc` reads with `#[cfg(not(unix))]` `None` stubs.

- [x] **P1.1 — Added `sysinfo` dep** (`0.33`, `default-features = false`, `features = ["system"]`);
  replaced `/proc/<pid>/cwd` and `/proc/<pid>/cmdline` reads in `pty.rs` with `sysinfo`
  (`Process::cwd()` / `Process::cmd()`), which resolve on all three OSes. A targeted `snapshot()`
  refreshes only the polled pids (no full process scan) to keep the ~2s tick cheap.
- [x] **P1.2 — Collapsed the `#[cfg]` split.** `cwd`/`busy`/`foreground`/`meta` are now **single,
  un-gated cross-platform functions**; the six `#[cfg(unix)]`/`#[cfg(not(unix))]` variants and the
  `/proc` `read_cmdline` helper are gone. Correction to the original plan: `MasterPty::process_
  group_leader()` is itself `#[cfg(unix)]` in `portable-pty` (Windows has no pgrp), so the pgrp read
  is isolated to **one tiny `foreground_leader` helper** (`#[cfg(unix)]` + a `None` stub) instead of
  living un-gated — the four public functions stay single-path.
- [x] **P1.3 — Result:** macOS gets the full floor (leader via portable-pty + strings via sysinfo);
  **Windows gains live cwd** (sysinfo works there even though pgrp/busy stays `None`). Opacity stance
  unchanged — process metadata, never pane output (ADR-0001 carve-out / ADR-0008 kernel provenance).
- **Verified on all three:** Linux `cargo fmt`/`clippy -D warnings`/`cargo test --lib` (20) green;
  **Windows cross-check** `cargo check --target x86_64-pc-windows-gnu --all-targets` clean; **macOS
  `macos-lint` green** (PR #23) — the first real macOS run, so the sysinfo floor is exercised there.

## Phase 2 — Voice capture on macOS/Windows via `cpal`  `[~]` (backend done; bundling pending)

`loom-voce/src/audio.rs` shelled out to `parecord`/`arecord` (Linux-only).

**Design correction (important):** the plan originally said "replace with cpal everywhere." That
would **break the Linux build on a no-sudo box** — cpal → `alsa-sys` needs `libasound2-dev` at build
time, the exact thing `parecord` was chosen to avoid. So the seam is **cfg-split**, not unified:

- [x] **P2.1 — cfg-split `start_capture`.** `#[cfg(target_os = "linux")]` keeps the parecord/arecord
  shell-out **verbatim** (no new build deps); `#[cfg(not(target_os = "linux"))]` uses **cpal**
  (CoreAudio/WASAPI). The cpal backend downmixes the device's native channels → mono and resamples
  native-rate → 16kHz in-process (`Resampler`, streaming linear interpolation), preserving the
  `Sender<Vec<f32>>` / 16kHz-mono-frame contract the STT loop expects.
- [x] **P2.2 — `cpal` is target-gated** (`[target.'cfg(not(target_os = "linux"))'.dependencies]`), so
  the Linux build pulls nothing new and stays header-free / no-sudo-buildable. **Verification:** the
  ubuntu `voce` job compiles the Linux arm; a new **`voce-macos`** CI job (clippy on macos-latest)
  compiles the cpal arm — the only place it's built (this box has no cmake, so loom-voce can't build
  locally at all).
- [~] **P2.3 — Bundle `loom-voce` into the macOS package (done); Windows is a follow-up.** macOS:
  the `macos-build` job builds `loom-voce`, stages it as `binaries/loom-voce-<triple>`, and **injects
  `externalBin` into the macOS overlay for that build only** (kept OUT of the committed
  `tauri.macos.conf.json` on purpose — tauri validates `externalBin` on *every* cargo build, so a
  committed entry would break `macos-lint`/dev builds that don't stage the binary). `voce.rs`
  resolves the shipped helper as a sibling of `loom`,
  with a fallback that also accepts a triple-suffixed sidecar name (robust to either tauri naming).
  **No model bundling needed** — `loom-voce` auto-downloads the whisper model on first use (curl/wget,
  present on macOS). **Windows loom-voce bundling: deliberately deferred** (the `windows-build` job is
  unchanged) — whisper.cpp bindgen needs libclang on the runner, a separate blind-CI risk to take on
  its own. Local mac builds now require staging the sidecar first (or `tauri build` fails on the
  missing `externalBin`); CI handles it. `binaries/` is gitignored.
- **Runtime verification still owed (P2.4):** no CI has a microphone, and no Mac is in the loop, so
  the dmg-shipped helper is **compile/bundle-verified only**. Real capture→transcription on macOS
  needs a human to install the dmg and run dictation (Cmd+Shift+M) once — the first true end-to-end
  check of the cpal path. This is the natural "needs a Mac" boundary flagged in the plan.

## Phase 3 — Region capture via `xcap` + in-house overlay (M9; unify 3 paths → one)  `[ ]`

Already scoped as PLAN M9. Replaces the Linux shell-out chain **and** the Windows Snip & Sketch
path **and** the missing macOS path with one owned implementation, zero external binaries.

- [ ] **P3.1 — Frame grab in Rust via `xcap`** (pure-Rust monitor capture, all three OSes).
- [ ] **P3.2 — In-house region selector:** a transparent, borderless, always-on-top Tauri overlay
  over the monitor(s) showing the frozen frame; drag a rectangle → crop with the `image` crate →
  write the PNG to the temp path the existing flow already types into the pane. Command contract
  (PNG path / "cancelled") unchanged, so `Terminal.tsx`/`captureToPane` + `Ctrl+Shift+S` are untouched.
- [ ] **P3.3 — RISK: WebKitGTK transparency.** The first M9 attempt (checklist B6) died here — the
  overlay rendered opaque/black and trapped input on Linux. This is the one item that needs a
  spike before committing; the `xcap` frame-grab half is safe regardless. If transparency stays
  unsolvable on WebKitGTK, fall back to a per-OS *selector* (native on mac/win, in-app on Linux)
  while still sharing the `xcap` grab — a smaller win, but still one grab path.
- [ ] **P3.4 — Build deps honesty:** `xcap` on Linux pulls PipeWire + libclang (`libspa`/bindgen).
  Acceptable on CI; a one-time local `apt install`. Document it.

## Phase 4 — Shortcuts: a logical `Mod` key (the one real macOS UX divergence)  `[x]` DONE (PR #24)

- [x] **P4.1 — Introduced the platform-aware chord in `lib/keybindings.ts`** — `appChord(e)`
  (primary modifier = `metaKey` on macOS, `ctrlKey` elsewhere; Shift required; other modifier +
  Alt excluded) plus `MOD_LABEL`/`MOD_NAMESPACE` for rendering. All four dispatch sites (App,
  Terminal, DetachedPane, Settings capture) call it; the cheat-sheet, palette, Settings list, and
  pane-menu labels all follow the platform. Platform detected once from `navigator` (guarded for
  the node test env → non-mac, the CI path). Pure TS.
- [x] **P4.2 — Amended ADR-0005** — `Ctrl+Shift` is the *logical* namespace; `Cmd+Shift` its macOS
  rendering; the split lives only in `appChord`.
- **Verified:** `tsc` clean; 182 frontend tests green (incl. 4 new `appChord` tests).
- **Known follow-up (P4.3, not done):** ~25 static `title="… (Ctrl+Shift+X)"` tooltip strings across
  TitleBar/WorkspaceRail/EmptyWorkspace/etc. still read "Ctrl" literally on macOS. Functional
  shortcuts + all *dynamic* labels are platform-correct; converting the static tooltips (route them
  through `formatBinding`/`MOD_NAMESPACE`) is mechanical cleanup for a follow-up.

## Phase 5 — Packaging, signing & docs  `[ ]`

- [ ] **P5.1 — macOS code signing + notarization** (Apple Developer account, `$99/yr`; hardened
  runtime + `notarytool`). Non-code bureaucracy but required for a Gatekeeper-clean `.dmg`. Document
  the flow; wire secrets into `macos-build`.
- [ ] **P5.2 — Reconcile the "Linux-first" positioning** across CLAUDE.md, README, PLAN, ADRs →
  "Linux + Windows shipping, macOS supported" once Phases 0–4 land.
- [ ] **P5.3 — Generalize Linux-only user-facing strings** (e.g. the capture install hint in
  `Terminal.tsx`, checklist D10) once M9 removes the shell-out.

---

## Sequencing & rationale

1. **Phase 0** first — without a macOS runner nothing else is verifiable.
2. **Phase 1 (sysinfo)** next — highest value/lowest risk, fully Linux-verifiable, and it *deletes*
   code (six `#[cfg]` variants → four plain functions).
3. **Phase 2 (cpal)** — bounded, self-contained crate swap in the standalone helper.
4. **Phase 4 (Mod key)** — small, pure-TS; can land any time.
5. **Phase 3 (M9 capture)** — last and riskiest (the overlay spike); the frame-grab half is safe,
   the transparency question is the gate.
6. **Phase 5** — packaging/signing/docs alongside as each platform lands.

Every phase keeps the Linux build byte-identical in behaviour and leaves the tree greener (fewer
platform branches), never adds a fourth special case.
