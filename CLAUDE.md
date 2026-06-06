# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

This repo is **pre-implementation**. The only file is [PLAN.md](PLAN.md) — the authoritative, milestone-by-milestone build plan. No scaffold, `package.json`, `src-tauri/`, or git history exists yet. When implementing, follow PLAN.md's milestone order (M0→M6) and treat it as the source of truth; update it if the design changes.

> **Note:** This project pivoted. It is no longer the Claude Agent SDK control room. It is now a **GUI terminal multiplexer** — real PTYs in resizable split grids and a left workspace rail. Agents are just one thing you can run in a pane; the model is generic terminals (panes are opaque — Termhaus never parses their output; see [ADR-0001](docs/adr/0001-opaque-panes-no-agent-awareness.md)).

## What this is

Termhaus — a Linux-first desktop "control room" of real terminals. You run many PTYs at once, arranged in **resizable split grids and a left workspace rail** (a GUI tmux/Terminator), tuned for driving fleets of CLI agents — including a **broadcast-input** feature to prompt many panes at once. Stack is **locked in**: Tauri 2 (Rust shell + WebKitGTK webview), SolidJS + Vite + TypeScript frontend, **xterm.js** (`@xterm/xterm` 5.x) for rendering, and **`portable-pty`** (Rust) for PTYs. Persistence is local JSON (`workspace.json`); SQLite is deferred. Target environment: Node v24, Rust 1.96, Linux Mint 22.3.

## Commands (planned — not yet wired up)

- `npm run tauri dev` — run the app in development (opens the Tauri window, starts Vite + the Rust shell).
- Build/lint/test scripts do not exist yet. When adding them, record the actual commands here.

## Architecture — the non-obvious decisions

These cross-cutting rules shape nearly every file. Read them before touching the PTY layer, IPC, or layout engine.

**One PtyManager, N PTYs (one per pane).** Rust owns a `HashMap<PaneId, PtySession>`; each session is a PTY master (`portable-pty`), its child process, and a dedicated reader thread. The kernel isolates each pane's process for free. Build the manager so panes are addressed by `PaneId` indirection from day one.

**Rust does the core now (this inverts the old thin-Rust rule).** PTYs are an OS concern, so the engine lives in Rust: spawn PTY + child from a `PaneSpec`, pump master→webview, accept write/resize/kill, reap exited children, save/load `workspace.json`. Still **no product logic in Rust** — layout geometry, drag-resize, focus/zoom, the workspace rail, and broadcast routing all live in TypeScript/SolidJS. If it's UX or state, it's TS; if it's a PTY/OS syscall or packaging path, it's Rust.

**Output = Tauri `Channel` (raw bytes), input = cheap commands.** PTY output streams to the webview over a `tauri::ipc::Channel` carrying **raw bytes**, never per-line JSON events. Keystrokes go the other way as `pty_write(paneId, bytes)` commands; resize as `pty_resize(paneId, cols, rows)`; lifecycle as `pty_spawn`/`pty_kill`. Never round-trip terminal output through commands. The output Channel is byte-protocol-only — Rust logging goes to stderr/tracing, never into the stream.

**Coalesce output, or WebKitGTK locks up — hard rule.** Each reader thread buffers and flushes on a ~8–16ms tick *or* a 32–64KB size threshold, whichever first, to cap frames-per-second per pane under floods (`yes`, big `cat`). Feed chunks straight to `term.write()` (xterm has its own write buffer) — do not pre-split into per-token DOM work. Start on the **canvas** renderer; treat `@xterm/addon-webgl` as optional and fall back gracefully (WebGL under WebKitGTK is the flaky path). Bounded/drop buffers, not unbounded queues; throttle hidden Workspaces.

**The workspace rail is a LEFT vertical list; "new workspace" is a wizard.** The rail lists Workspaces (name + terminal-count badge + close ✕); switching swaps the whole grid, hidden Workspaces keep their PTYs alive. Hierarchy is exactly two levels (Workspace → Pane) — no tmux-style "window" layer, and "tab" is retired as a term. Clicking **+** opens a 3-step **Start→Layout→Agents** wizard: pick a working folder (with Recents/Presets) → tap a grid-preset tile (1/2/4/6/8/10/12 terminals → `buildBalancedTree(n)`) → optionally set per-pane launch commands → launch ("Open without AI" = plain shells). Don't build top tabs or a freeform-split-only creation flow.

**Layout = a binary split tree per workspace.** `LayoutNode` is `{kind:'leaf', paneId}` or `{kind:'split', dir:'row'|'col', ratio, a, b}`. Splitting replaces a leaf with a split (old leaf + new pane); closing collapses the parent and promotes the sibling. Draggable gutters mutate `ratio`. Each pane measures its box with `@xterm/addon-fit` → derives cols/rows → debounced `pty_resize`. Every pane has a title bar: auto-name (Faye, Cleo…) + per-pane controls (collapse/split/zoom/close) + focus ring. Grid presets are just `buildBalancedTree(n)` constructors, not a separate mode — the freeform splitter still works after launch.

**Persist intent, not scrollback.** `workspaces.json` stores Workspaces, each tree, and per-pane `PaneSpec` (command, cwd, env, title). On launch, rebuild the tree and **respawn** each command in its cwd — terminals are not restored to prior output (ephemeral). SQLite only enters the picture if searchable scrollback/session logging becomes a goal.

**Shared types in one module.** `PaneId`, `PaneSpec`, `LayoutNode`, `Workspace`, and command names live in `src/ipc/protocol.ts`; Rust command signatures mirror it.

**Inter-pane control bus = Rust socket relay, routing in TS** (ADR-0007). A process *inside* a pane (e.g. a `claude` CLI) can drive other panes via the `th` CLI → a unix socket at `$TERMHAUS_SOCK`. Rust is a **pure relay**: it forwards the raw request string to the webview as a `termhaus://pane-cmd` event and writes back whatever the frontend replies via `pane_cmd_reply` — it never parses the protocol. All routing (name→pane resolution, writes through the pane registry, `spawn` layout mutation) stays in TS, per the no-product-logic-in-Rust rule. Each PTY child gets `TERMHAUS_SOCK`/`TERMHAUS_PANE`/`TERMHAUS_CLI` injected and the CLI dir prepended to `PATH`. This is an **inbound command channel**, distinct from ADR-0001's opacity rule (which forbids parsing pane *output* — still rejected).

## Files to create (see PLAN.md for the full list)

- `src-tauri/src/pty.rs` — `PtyManager`: spawn, reader-thread + coalescing flush, write/resize/kill, child reaping.
- `src-tauri/src/commands.rs` — Tauri command handlers + Channel wiring (the frontend contract).
- `src-tauri/src/workspace.rs` — `workspace.json` load/save (serde).
- `src/ipc/protocol.ts` — shared types.
- `src/lib/ptyClient.ts` — spawn a pane, bind its xterm to the output Channel, wire write/resize/kill.
- `src/components/Terminal.tsx` / `LayoutNode.tsx` / `WorkspaceRail.tsx` / `NewWorkspaceWizard.tsx` / `BroadcastBar.tsx`.
- `src/stores/workspace.ts` — normalized store: Workspaces (rail), trees, panes, focus/zoom, broadcast selection.
- `src-tauri/tauri.conf.json` — packaging (.deb/AppImage, WebKitGTK dep).
- `src-tauri/src/control.rs` + `src-tauri/src/bin/th.rs` — inter-pane control bus: socket relay + the `th` CLI (ADR-0007). Frontend half: `src/lib/paneControl.ts`.

## Highest risk — prove before building further

**PTY throughput rendering smoothly in WebKitGTK via Tauri IPC** is the make-or-break assumption (top risk in PLAN.md). M0 must prove a single pane survives a flood (`yes`, big `cat`, `find /`) with no main-thread lockup and bounded memory, using raw-byte Channel + Rust-side coalescing + canvas renderer. **Do not build past M0 until the flood test passes.**

**Verify against the live stack before finalizing M0:** Tauri 2 `Channel` byte-streaming API and payload shape; `portable-pty` master read/write/resize + child-exit reaping on Linux; `@xterm/xterm` 5.x renderer + fit-addon behavior under WebKitGTK; whether `@xterm/addon-webgl` works at all in this webview.
