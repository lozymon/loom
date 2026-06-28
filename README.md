# Loom

[![CI](https://github.com/lozymon/loom/actions/workflows/ci.yml/badge.svg)](https://github.com/lozymon/loom/actions/workflows/ci.yml)

**A Linux-first desktop control room of real terminals** — a GUI terminal multiplexer (think a graphical tmux / Terminator) that runs many PTYs at once in resizable split grids and a left workspace rail. It's tuned for driving fleets of CLI agents: spawn a wall of terminals, watch which ones need you, and let one agent drive the others over the `loom` control bus (including fanning a prompt to every pane with `loom broadcast`).

Generic first: a pane is just a real pseudo-terminal running *any* command — a shell, `claude`, a dev server, `tail -f`, `vim`. Loom never parses what a pane prints ([ADR-0001](docs/adr/0001-opaque-panes-no-agent-awareness.md)); agents are simply the most interesting thing you can run in one.

> Status: all milestones **M0–M6** complete. See [PLAN.md](PLAN.md) for the milestone-by-milestone build log and [docs/adr/](docs/adr/) for the architecture decisions.

## Features

- **Many real PTYs**, one OS process each — the kernel isolates panes for free; a flood in one (`yes`, a big `cat`) can't lock the UI or starve the others.
- **Split-grid layout** — a binary split tree per workspace: split any pane right/down, drag the gutters to resize, close to collapse and promote the sibling. Zoom a pane to fullscreen and back.
- **Workspace rail** — group panes into workspaces on a left rail; switching keeps hidden workspaces' terminals alive.
- **New-workspace wizard** — pick a working folder (with Recents) → tap a grid preset (1/2/4/6/8/10/12 terminals) → optionally set a per-pane launch command → go.
- **Pane attention signals** — a per-pane status dot shows when a pane is running a command, produced output you haven't looked at, or rang the bell — so you can tell at a glance which of a fleet of agents needs you. A pane also lights an **amber "needs you" border** when a command finishes in a pane you weren't watching, or when a process inside it calls `loom attention` (so an agent can flag itself the moment it's blocked on your input — see [Light a pane when an agent needs you](#light-a-pane-when-an-agent-needs-you)). Hidden workspaces flag activity on the rail. Optionally pop a **desktop notification** when a pane needs you while Loom is in the background (off by default; Settings → Notifications). (Metadata only — pane output is never parsed; [ADR-0001](docs/adr/0001-opaque-panes-no-agent-awareness.md).)
- **Overview mode** (`Ctrl+Shift+O`) — reflow the active workspace into a uniform tile wall to triage a whole fleet at a glance (agent badges, attention borders, and timers stay visible); click a tile or press Esc to drop back to the split grid. The terminals keep running — it's a view, not a re-layout.
- **Command palette** (`Ctrl+Shift+P`) — fuzzy-search every action plus jump-to-pane-by-name across all workspaces.
- **Inter-pane control bus** — a process *inside* a pane (e.g. a `claude` CLI) can drive the others with the bundled `loom` command: `loom list`, `loom send`, `loom spawn`, `loom read` (capture another pane's scrollback), `loom broadcast`, `loom focus`, and `loom attention` (light a pane's "needs you" border). One agent can kick off, prompt, and read back from another, without Loom ever parsing pane output ([ADR-0007](docs/adr/0007-inter-pane-control-bus.md)).
- **Drag to rearrange** — grab a pane's title-bar grip and drop it on another to swap their grid positions (the terminals keep running).
- **Presets** — save a workspace (folder + layout + per-pane commands) and relaunch it in one click.
- **Persistence** — workspaces, layouts, and per-pane intent are saved as JSON and respawned on launch (intent, not scrollback — terminals are ephemeral).
- **Source Control panel** — a VS Code-style git diff viewer (`Ctrl+Shift+G` or the rail's ⎇ button), scoped to the focused terminal's live working directory. Browse Staged / Changes, read unified diffs side-by-side, and send selected diff lines straight to the focused pane (read-only — no stage/commit yet).
- **Snapshot region → pane** — grab a screen region to a PNG and drop its path into the focused pane's prompt (`Ctrl+Shift+S`), e.g. to hand `claude` a screenshot.
- **Launch Claude here** — a per-pane title-bar button (✦) runs `claude` in that terminal's current directory; the wizard can also preset `claude` as a pane's launch command.
- **Terminal polish** — OS clipboard copy/paste, scrollback search, clickable web links, unicode11 widths, a focus ring, and pane titles that show the **current folder** (double-click to set a custom name; full path on hover, git branch alongside).
- **Settings & rebindable keys** — a tabbed Settings page (Appearance / Terminal / Keys): theme, font, cursor, scrollback, default shell/cwd, and every shortcut is rebindable within the `Ctrl+Shift` namespace.
- **Themes** — light and dark out of the box plus extra palettes (Midnight, Paper), switched from the rail and remembered across restarts. Each theme styles both the app chrome and the terminals; adding one is a CSS `[data-theme]` block + a registry entry (`src/lib/theme.ts`).
- **Plain keys pass through** — Loom claims only the `Ctrl+Shift` namespace ([ADR-0005](docs/adr/0005-ctrl-shift-shortcut-namespace.md)); everything else (plain `Ctrl+C` → SIGINT, arrows, function keys, `tmux`/`vim` keys) reaches the pane untouched.

## AI agents — bring your own CLI

A pane is just a real terminal, so any agent that ships a **command-line tool** runs in Loom today with no integration work — launch it from the wizard's per-pane command, type it into a shell, or `loom spawn` it. There's no standard API and Loom doesn't need one: it never parses pane output ([ADR-0001](docs/adr/0001-opaque-panes-no-agent-awareness.md)), so a CLI agent is just a command.

Known to work because they're terminal-native:

| Agent | Command |
|---|---|
| Claude Code | `claude` |
| OpenAI Codex CLI | `codex` |
| Google Gemini CLI | `gemini` |
| GitHub Copilot CLI | `copilot` (or `gh copilot`) |
| Amazon Q Developer | `q chat` |
| Aider (model-agnostic) | `aider` |
| Cursor (headless) | `cursor-agent` |

Run a fleet of them side by side and let one agent drive the others over the `loom` control bus — including fanning a prompt to every pane with `loom broadcast`. When a pane is launched as one of these, its title bar shows a small **agent badge** so you can tell at a glance which terminal is running which assistant. (Derived from the pane's launch command — still no output parsing; [ADR-0001](docs/adr/0001-opaque-panes-no-agent-awareness.md).) The wizard's Agents step has a quick-fill dropdown for the same list.

**Not a fit:** editor-only assistants that live inside VS Code / JetBrains (the classic Copilot autocomplete, Cline, Continue, Windsurf) — they speak an editor-extension protocol, not a terminal, so there's no command to host. Raw HTTP model APIs likewise aren't supported directly; run a CLI that wraps them (e.g. Aider) instead of building a chat client into a pane.

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
| `Ctrl+Shift+P` | Command palette (fuzzy actions + jump to pane) |
| `Ctrl+Shift+S` | Snapshot a screen region → focused pane |
| `Ctrl+Shift+G` | Open Source Control (git diff viewer) |

You can also double-click a pane's title to rename it.

## Driving panes from inside a pane

Every pane's process gets a `loom` CLI on its `PATH` and a few env vars (`$LOOM_SOCK`, and `$LOOM_PANE` — its own name). So a CLI agent running in one pane can orchestrate the others:

```bash
loom list                                   # every pane: name, live/dead, workspace
loom send Cleo claude "investigate the auth bug"   # type into pane "Cleo" + press Enter
loom send Cleo --no-enter ls                # type without the trailing newline
echo "$PROMPT" | loom send Cleo             # no text arg → reads stdin
loom spawn --name Cleo --cwd /repo claude   # open a NEW pane running a command
loom read Cleo -n 100                        # capture Cleo's last 100 scrollback lines
loom broadcast "run the tests"              # send to every live pane in the active workspace
loom focus Cleo                              # switch to Cleo's workspace and focus it
loom attention                              # light THIS pane's "needs you" border (clears on focus)
loom attention Cleo --clear                 # drop pane Cleo's border
```

It works over a per-user unix socket (`$XDG_RUNTIME_DIR/loom.sock`, mode 0600): Rust is a pure relay, all routing/naming/spawn logic lives in the frontend, and pane *output* is never parsed — this is an inbound command channel, distinct from the opacity rule ([ADR-0001](docs/adr/0001-opaque-panes-no-agent-awareness.md) / [ADR-0007](docs/adr/0007-inter-pane-control-bus.md)).

See **[docs/cli.md](docs/cli.md)** for the full `loom` command reference (every flag, `loom status`, `loom hooks`), and **[docs/agent-mcp.md](docs/agent-mcp.md)** / **[docs/agent-hooks.md](docs/agent-hooks.md)** for the model-native MCP tools and the auto-status hooks.

### Light a pane when an agent needs you

Loom can't tell "an agent is waiting for your answer" from "an agent is working" just by watching the process — both are a live foreground command, and pane output is never parsed ([ADR-0001](docs/adr/0001-opaque-panes-no-agent-awareness.md)). So the agent flags itself: a single `loom attention` call lights its pane's amber border, which clears the moment you focus it.

Claude Code can do this automatically with hooks. Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [ { "type": "command", "command": "loom attention 2>/dev/null || true" } ] }
    ],
    "Notification": [
      { "hooks": [ { "type": "command", "command": "loom attention 2>/dev/null || true" } ] }
    ]
  }
}
```

`Stop` fires when Claude finishes and yields back to you; `Notification` fires when it wants permission. The hook runs inside the pane, so `$LOOM_SOCK`/`$LOOM_PANE` are already set and `loom` is on `PATH` (the `2>/dev/null || true` makes it a no-op when run outside Loom). Any agent with a "done"/"needs input" hook — or even a plain `&& loom attention` after a long shell command — works the same way.

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

Artifacts land in `src-tauri/target/release/bundle/` (e.g. `deb/Loom_<version>_amd64.deb`). The `.deb` declares its WebKitGTK/GTK runtime deps automatically. The AppImage bundler downloads helper tools from GitHub on first run, so it needs network access.

## Project structure

```
src/                         SolidJS frontend (all UX + state)
  components/                Terminal, LayoutNode, WorkspaceRail, NewWorkspaceWizard, Settings, GitPanel
  stores/workspace.ts        normalized store: workspaces, trees, panes, focus/zoom, presets
  lib/                       grid (balanced tree + names), layout (geometry + neighbour),
                             ptyClient, paneRegistry, paneControl (loom relay handler), persist, theme
  ipc/protocol.ts            shared types: PaneId, PaneSpec, LayoutNode, Workspace, command names
src-tauri/src/               Rust shell (PTY engine + OS concerns)
  pty.rs                     PtyManager: spawn, reader/flusher coalescing, write/resize/kill, reaping
  control.rs                 inter-pane control bus: unix-socket relay + pane_cmd_reply
  main.rs                    one binary, three faces: GUI / control CLI / `loom mcp` dispatch
  cli.rs                     the `loom` control CLI (a face of the loom binary)
  mcp.rs                     the `loom mcp` MCP server (a face of the loom binary)
  lib.rs                     Tauri command handlers + Channel wiring (the frontend contract)
  workspace.rs               schema-agnostic JSON state load/save
docs/adr/                    architecture decision records
docs/cli.md                  the `loom` inter-pane control CLI reference
docs/agent-mcp.md            the `loom mcp` MCP server (agent tools)
docs/agent-hooks.md          wire a Claude Code agent into Loom
docs/troubleshooting.md      file locations, rendering, control-bus, build fixes
PLAN.md                      the milestone-by-milestone build plan + status
CHANGELOG.md                 release-by-release change log
```

## Architecture notes

A few decisions shape most of the code:

- **One `PtyManager`, N PTYs** — Rust owns a map of pane id → PTY master + child + reader thread. Product logic (layout, focus, broadcast routing) stays in TypeScript; Rust only does PTY/OS work.
- **Output = raw-byte Tauri `Channel`, input = cheap commands** — PTY output streams as bytes over a `Channel`, never per-line JSON. Keystrokes go back as `pty_write` ([ADR-0003](docs/adr/0003-output-transport-channel-first-websocket-fallback.md)).
- **Coalesce output or WebKitGTK locks up** — each reader thread buffers and flushes on a ~16ms tick or a 64KB threshold (bounded back-pressure, not byte-dropping), so a flood can't stall the main thread.
- **Flat, PaneId-keyed render layer** — the split tree is flattened into absolutely-positioned panes rather than a recursive flex tree, so splitting or closing never remounts a pane's `<Terminal>` and its PTY survives.
- **Login shells** — every pane runs `$SHELL -l(c)` so PATH / rc files / version managers load, even when launched from a desktop entry ([ADR-0004](docs/adr/0004-launch-via-login-interactive-shell.md)).
- **Persist intent, not scrollback** — on restart the trees rebuild and each pane re-runs its command in its cwd.
- **Inter-pane control = relay in Rust, routing in TS** — the `loom` CLI talks to a unix socket; Rust forwards the raw request to the webview and writes back the reply, never parsing the protocol; name resolution, writes, and `spawn` layout mutation stay in TypeScript ([ADR-0007](docs/adr/0007-inter-pane-control-bus.md)).

## License

MIT
