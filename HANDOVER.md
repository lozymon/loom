# HANDOVER — for the next Claude Code session

> A snapshot to get a fresh session productive fast. The durable "why" lives in
> [CLAUDE.md](CLAUDE.md), [PLAN.md](PLAN.md), [CONTEXT.md](CONTEXT.md) and the
> [ADRs](docs/adr/). This file is the *current state* on top of those.
>
> Last updated: 2026-06-18 · Branch: `main` · Version: `0.5.1`

## TL;DR

Termhaus is a **Linux-first GUI terminal multiplexer** (a GUI tmux/Terminator)
for driving fleets of CLI agents: many real PTYs in resizable split grids with a
left workspace rail and broadcast-input. It is **implemented and shipping** —
the whole M0–M11 plan *and* the IDEAS.md follow-up roadmap are done. Treat new
work as incremental on a mature, healthy codebase, not greenfield.

**Stack (locked in):** Tauri 2 (Rust + WebKitGTK) · SolidJS + Vite + TypeScript ·
xterm.js (`@xterm/xterm` 5.x) · `portable-pty` (Rust). Persistence is local JSON
(`workspace.json`); SQLite deferred.

## Current health (verified this session)

- `npm test` → **59 tests, 8 files, all passing** (~300ms).
- `cargo check` (in `src-tauri/`) → **clean**.
- `git status` → **clean working tree** on `main`.
- Tags present: `v0.3.0`, `v0.5.1`. `package.json` is at `0.5.1`
  (note: CLAUDE.md prose still says "v0.5.0" — minor staleness, not a bug).

Recent commits cluster around CI/release plumbing (GitHub Release with .deb +
Windows installer on `v*` tags), a UI-poll perf fix, M7 Windows support
(Linux-side, cross-checked), and the capture decision (keep shell-out).

## How to run / check

```bash
npm run tauri dev      # run the app (Tauri window + Vite + Rust shell)
npm run build          # Vite prod build (tsc-checked)
npx tsc --noEmit       # standalone frontend typecheck
npm test               # Vitest unit suite (pure-logic libs)

cd src-tauri
cargo check            # Rust typecheck
cargo clippy           # lints
cargo fmt --check      # CI enforces rustfmt (there's also an auto-format hook)
```

The Rust crate builds the app **plus two extra binaries**: `th` (inter-pane
control CLI, ADR-0007) and `th-mcp` (MCP server) — both std + serde_json only,
sharing `src-tauri/src/control_sock.rs`.

## The architecture rules that bite if ignored

These are from CLAUDE.md / ADRs — re-stated here because they shape almost every
change:

1. **One `PtyManager`, N PTYs** — Rust owns `HashMap<PaneId, PtySession>`; panes
   addressed by `PaneId` indirection. (`pty.rs`)
2. **Rust does the core, but no product logic in Rust.** PTYs/OS syscalls/packaging
   → Rust. Layout, focus/zoom, rail, broadcast routing, bus *routing* → TS/SolidJS.
3. **Output = Tauri `Channel` (base64 in `Channel<String>`); input = cheap
   commands** (`pty_write`/`pty_resize`/`pty_spawn`/`pty_kill`/`pty_retarget`).
   Never round-trip terminal output through commands. The output Channel is
   byte-protocol-only — Rust logs go to stderr.
4. **Coalesce output or WebKitGTK locks up** — reader threads flush on ~8–16ms
   tick *or* 32–64KB, whichever first; bounded/drop buffers. **Do not regress the
   coalescing/back-pressure in `pty.rs`** (ADR-0003, ADR-0006). Canvas renderer,
   not WebGL (ADR-0006).
5. **Panes are opaque** — Termhaus never parses pane *output* (ADR-0001). The
   inter-pane control bus (ADR-0007) is an *inbound* command channel and is the
   only exception; Rust is a pure socket relay, routing stays in TS.
6. **Persist intent, not scrollback** — `workspaces.json` stores trees + per-pane
   `PaneSpec`; on launch, respawn commands (terminals are ephemeral).
7. **Layout = binary split tree** per workspace (`LayoutNode` leaf/split).
8. **Shared types in one module** — `src/ipc/protocol.ts`; Rust signatures mirror it.

## Where things live (the map)

**Rust (`src-tauri/src/`):** `pty.rs` (PtyManager) · `lib.rs` (command handlers +
Channel wiring + tray/plugin setup) · `control.rs` + `bin/th.rs` (control bus +
CLI) · `bin/th-mcp.rs` (MCP server) · `control_sock.rs` · `tray.rs` · `git.rs` ·
`docs.rs` · `logs.rs` · `capture.rs` · `workspace.rs`.

**Frontend (`src/`):** `ipc/protocol.ts` (shared types/commands) · `lib/ptyClient.ts` ·
`lib/paneControl.ts` (bus routing) · `lib/detach.ts` (multi-window tear-off) ·
`stores/workspace.ts` (normalized state) · `stores/{activity,settings,theme}.ts` ·
`components/` — `Terminal`, `LayoutNode`, `WorkspaceRail`, `NewWorkspaceWizard`,
`BroadcastBar`, `GitPanel`, `DocsPanel`, `SessionLogViewer`, `PreviewPanel`,
`ShortcutsOverlay`, `CommandPalette`, `Settings`, `TitleBar`.

**Tests:** Vitest covers pure-logic libs only (layout, grid, matching, agents,
markdown, ansi, keybindings, gitClient). Rust has a first set of unit tests wired
into CI (`cargo test`). UI/integration is not unit-tested — verify by running.

## Common change patterns (follow the grain)

- **New side panel** → mirror `GitPanel.tsx`.
- **New shortcut** → add an action to `lib/keybindings.ts`, wire *both* dispatch
  maps (App global + Terminal). Shortcut namespace is `Ctrl+Shift+…` (ADR-0005).
- **New bus op** → extend `ControlRequest` in `protocol.ts`, handle in
  `paneControl.ts`, add a `th` / `th-mcp` front-end.

## Source-of-truth docs

- [CLAUDE.md](CLAUDE.md) — the operating rules (this handover compresses them).
- [PLAN.md](PLAN.md) — design + milestones M0–M11 (the *why*).
- [CONTEXT.md](CONTEXT.md) — the **glossary** (Pane, Pane name, Dead Pane, PTY,
  Agent, Working folder…). Use this vocabulary; "tab"/"window"/"terminal-as-tile"
  are retired terms.
- [docs/adr/](docs/adr/) — 0001 opacity · 0002 PTYs in-process · 0003 Channel
  transport · 0004 login/interactive shell launch · 0005 Ctrl+Shift namespace ·
  0006 canvas not WebGL · 0007 inter-pane control bus.
- [docs/IDEAS.md](docs/IDEAS.md) — post-v1 feature log (each item has "✅ Built as").
- [docs/agent-hooks.md](docs/agent-hooks.md) · [docs/agent-mcp.md](docs/agent-mcp.md)
  — the `th hooks` + `th-mcp` integration arc.
- [docs/PRE_WINDOWS_CHECKLIST.md](docs/PRE_WINDOWS_CHECKLIST.md) ·
  [SECURITY_REVIEW.md](SECURITY_REVIEW.md).

## Suggested first moves for the next session

1. Skim CLAUDE.md + the relevant ADR before touching the PTY layer, IPC, or
   layout engine.
2. Re-run the health checks above to confirm nothing drifted.
3. There is **no flagged in-flight work** — the tree is clean. Take direction
   from the user; default to incremental changes that respect the rules above.
4. Minor housekeeping if it's ever in scope: bump the "v0.5.0" prose in CLAUDE.md
   to match `package.json` (`0.5.1`).
