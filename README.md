# Termhaus

[![CI](https://github.com/lozymon/termhaus/actions/workflows/ci.yml/badge.svg)](https://github.com/lozymon/termhaus/actions/workflows/ci.yml)

**A Linux-first desktop control room of real terminals** — a GUI terminal multiplexer (think a graphical tmux / Terminator) that runs many PTYs at once in resizable split grids and a left workspace rail. It's tuned for driving fleets of CLI agents: the headline trick is **broadcast input** — type once and send it to many panes at the same time.

Generic first: a pane is just a real pseudo-terminal running *any* command — a shell, `claude`, a dev server, `tail -f`, `vim`. Termhaus never parses what a pane prints ([ADR-0001](docs/adr/0001-opaque-panes-no-agent-awareness.md)); agents are simply the most interesting thing you can run in one.

> Status: all milestones **M0–M6** complete. See [PLAN.md](PLAN.md) for the milestone-by-milestone build log and [docs/adr/](docs/adr/) for the architecture decisions.

## Features

- **Many real PTYs**, one OS process each — the kernel isolates panes for free; a flood in one (`yes`, a big `cat`) can't lock the UI or starve the others.
- **Split-grid layout** — a binary split tree per workspace: split any pane right/down, drag the gutters to resize, close to collapse and promote the sibling. Zoom a pane to fullscreen and back.
- **Workspace rail** — group panes into workspaces on a left rail; switching keeps hidden workspaces' terminals alive.
- **New-workspace wizard** — pick a working folder (with Recents) → tap a grid preset (1/2/4/6/8/10/12 terminals) → optionally set a per-pane launch command → go.
- **Broadcast input** — send a line to every live pane in the current workspace, or a hand-picked subset. Spawn 12 panes, broadcast one prompt to all.
- **Inter-pane control bus** — a process *inside* a pane (e.g. a `claude` CLI) can drive the others with the bundled `th` command: `th list`, `th send <pane> <text…>`, `th spawn <command…>`. One agent can kick off and prompt another, without Termhaus ever parsing pane output ([ADR-0007](docs/adr/0007-inter-pane-control-bus.md)).
- **Presets** — save a workspace (folder + layout + per-pane commands) and relaunch it in one click.
- **Persistence** — workspaces, layouts, and per-pane intent are saved as JSON and respawned on launch (intent, not scrollback — terminals are ephemeral).
- **Source Control panel** — a VS Code-style git diff viewer (`Ctrl+Shift+G` or the rail's ⎇ button), scoped to the focused terminal's live working directory. Browse Staged / Changes, read unified diffs side-by-side, and send selected diff lines straight to the focused pane (read-only — no stage/commit yet).
- **Snapshot region → pane** — grab a screen region to a PNG and drop its path into the focused pane's prompt (`Ctrl+Shift+S`), e.g. to hand `claude` a screenshot.
- **Launch Claude here** — a per-pane title-bar button (✦) runs `claude` in that terminal's current directory; the wizard can also preset `claude` as a pane's launch command.
- **Terminal polish** — OS clipboard copy/paste, scrollback search, clickable web links, unicode11 widths, named panes (Faye, Cleo…), and a focus ring.
- **Settings & rebindable keys** — a tabbed Settings page (Appearance / Terminal / Keys): theme, font, cursor, scrollback, default shell/cwd, and every shortcut is rebindable within the `Ctrl+Shift` namespace.
- **Themes** — light and dark out of the box plus extra palettes (Midnight, Paper), switched from the rail and remembered across restarts. Each theme styles both the app chrome and the terminals; adding one is a CSS `[data-theme]` block + a registry entry (`src/lib/theme.ts`).
- **Plain keys pass through** — Termhaus claims only the `Ctrl+Shift` namespace ([ADR-0005](docs/adr/0005-ctrl-shift-shortcut-namespace.md)); everything else (plain `Ctrl+C` → SIGINT, arrows, function keys, `tmux`/`vim` keys) reaches the pane untouched.

## Stack

| Layer | Choice |
|------|--------|
| Shell / windowing | [Tauri 2](https://tauri.app) (Rust + WebKitGTK webview) |
| Frontend | [SolidJS](https://solidjs.com) + [Vite](https://vitejs.dev) + TypeScript |
| Terminal rendering | [`@xterm/xterm`](https://xtermjs.org) 5.x (canvas renderer — [ADR-0006](docs/adr/0006-canvas-renderer-not-webgl.md)) |
| PTYs | [`portable-pty`](https://crates.io/crates/portable-pty) (Rust) |

## Keyboard shortcuts

All app shortcuts live in the `Ctrl+Shift` namespace; nothing else is intercepted. These are the **defaults** — the final key of every combo is rebindable in **Settings → Keys**.

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+C` / `V` | Copy selection / paste (plain `Ctrl+C` stays SIGINT) |
| `Ctrl+Shift+F` | Find in scrollback (`Enter` next, `Shift+Enter` prev, `Esc` close) |
| `Ctrl+Shift+D` / `E` | Split right / split down |
| `Ctrl+Shift+W` | Close pane |
| `Ctrl+Shift+Enter` | Zoom pane to fullscreen / restore |
| `Ctrl+Shift+←↑↓→` | Move focus to the adjacent pane |
| `Ctrl+Shift+PageUp` / `PageDown` | Previous / next workspace |
| `Ctrl+Shift+T` | New workspace (opens the wizard) |
| `Ctrl+Shift+S` | Snapshot a screen region → focused pane |
| `Ctrl+Shift+G` | Open Source Control (git diff viewer) |

You can also double-click a pane's title to rename it.

## Driving panes from inside a pane

Every pane's process gets a `th` CLI on its `PATH` and a few env vars (`$TERMHAUS_SOCK`, and `$TERMHAUS_PANE` — its own name). So a CLI agent running in one pane can orchestrate the others:

```bash
th list                                   # every pane: name, live/dead, workspace
th send Cleo claude "investigate the auth bug"   # type into pane "Cleo" + press Enter
th send Cleo --no-enter ls                # type without the trailing newline
echo "$PROMPT" | th send Cleo             # no text arg → reads stdin
th spawn --name Cleo --cwd /repo claude   # open a NEW pane running a command
```

It works over a per-user unix socket (`$XDG_RUNTIME_DIR/termhaus.sock`, mode 0600): Rust is a pure relay, all routing/naming/spawn logic lives in the frontend, and pane *output* is never parsed — this is an inbound command channel, distinct from the opacity rule ([ADR-0001](docs/adr/0001-opaque-panes-no-agent-awareness.md) / [ADR-0007](docs/adr/0007-inter-pane-control-bus.md)).

## Getting started

### Prerequisites

- **Node** 22+ (developed on v24) and **Rust** 1.77+ (developed on 1.96)
- Linux (developed on Linux Mint 22.3 / Ubuntu 24.04 base). The Tauri/WebKitGTK system libraries:

  ```bash
  sudo apt install -y libwebkit2gtk-4.1-dev build-essential curl wget file \
    libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
  ```

### Develop

```bash
npm install
npm run tauri dev      # opens the window; starts Vite + the Rust shell
```

### Build a package

```bash
npm run tauri build    # release binary + bundles (.deb, AppImage)
```

Artifacts land in `src-tauri/target/release/bundle/` (e.g. `deb/Termhaus_<version>_amd64.deb`). The `.deb` declares its WebKitGTK/GTK runtime deps automatically. The AppImage bundler downloads helper tools from GitHub on first run, so it needs network access.

## Project structure

```
src/                         SolidJS frontend (all UX + state)
  components/                Terminal, LayoutNode, WorkspaceRail, NewWorkspaceWizard, BroadcastBar, Settings, GitPanel
  stores/workspace.ts        normalized store: workspaces, trees, panes, focus/zoom, broadcast, presets
  lib/                       grid (balanced tree + names), layout (geometry + neighbour),
                             ptyClient, paneRegistry, paneControl (th relay handler), persist, theme
  ipc/protocol.ts            shared types: PaneId, PaneSpec, LayoutNode, Workspace, command names
src-tauri/src/               Rust shell (PTY engine + OS concerns)
  pty.rs                     PtyManager: spawn, reader/flusher coalescing, write/resize/kill, reaping
  control.rs                 inter-pane control bus: unix-socket relay + pane_cmd_reply
  bin/th.rs                  the `th` control CLI (a second binary)
  lib.rs                     Tauri command handlers + Channel wiring (the frontend contract)
  workspace.rs               schema-agnostic JSON state load/save
docs/adr/                    architecture decision records
PLAN.md                      the milestone-by-milestone build plan + status
```

## Architecture notes

A few decisions shape most of the code:

- **One `PtyManager`, N PTYs** — Rust owns a map of pane id → PTY master + child + reader thread. Product logic (layout, focus, broadcast routing) stays in TypeScript; Rust only does PTY/OS work.
- **Output = raw-byte Tauri `Channel`, input = cheap commands** — PTY output streams as bytes over a `Channel`, never per-line JSON. Keystrokes go back as `pty_write` ([ADR-0003](docs/adr/0003-output-transport-channel-first-websocket-fallback.md)).
- **Coalesce output or WebKitGTK locks up** — each reader thread buffers and flushes on a ~16ms tick or a 64KB threshold (bounded back-pressure, not byte-dropping), so a flood can't stall the main thread.
- **Flat, PaneId-keyed render layer** — the split tree is flattened into absolutely-positioned panes rather than a recursive flex tree, so splitting or closing never remounts a pane's `<Terminal>` and its PTY survives.
- **Login shells** — every pane runs `$SHELL -l(c)` so PATH / rc files / version managers load, even when launched from a desktop entry ([ADR-0004](docs/adr/0004-launch-via-login-interactive-shell.md)).
- **Persist intent, not scrollback** — on restart the trees rebuild and each pane re-runs its command in its cwd.
- **Inter-pane control = relay in Rust, routing in TS** — the `th` CLI talks to a unix socket; Rust forwards the raw request to the webview and writes back the reply, never parsing the protocol; name resolution, writes, and `spawn` layout mutation stay in TypeScript ([ADR-0007](docs/adr/0007-inter-pane-control-bus.md)).

## License

MIT
