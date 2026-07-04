# Changelog

All notable changes to Loom are documented here. The format is loosely based on
[Keep a Changelog](https://keepachangelog.com/), and the project follows semantic
versioning.

## [Unreleased]

Work landed on top of the 1.3.0 release: a packaging fix so voice dictation works on the AppImage,
the post-release voice-monologue and pane-identity features, and hardened tests around the PTY core.

### Added
- **Voice monologue dictation** — the dictation hotkey (**Ctrl+Shift+M**) starts a hold-mode capture
  that records through pauses (no silence auto-stop), with a live mic waveform and explicit
  finish/cancel keys, so a full multi-sentence prompt can be dictated into a pane. (Linux only — the
  helper captures via PulseAudio/ALSA; see Fixed.)
- **Pane pool-name watermark** — each pane shows its pool name (e.g. Wade/Cleo) as a subtle corner
  watermark.

### Fixed
- **Voice dictation on the AppImage** — the AppImage now bundles the `loom-voce` helper beside `loom`
  (it shipped only in the `.deb`), so **Ctrl+Shift+M** resolves the helper on AppImage installs
  instead of silently failing to find it. Voice dictation remains **Linux-only**: `loom-voce`
  captures audio via `parecord`/`arecord` (PulseAudio/ALSA), so the Windows NSIS installer ships no
  helper and the hotkey there reports it couldn't start — now documented in CLAUDE.md.

### Internal
- **PTY core test coverage** — unit tests for the output-coalescing cap (the flood-protection
  back-pressure path, ADR-0003/0006) and the inter-pane control-bus reply registry. The coalescing
  loop was extracted from the flusher into a pure, testable function with no behaviour change; the
  crate's `cargo test` count went 7 → 14.

## [1.2.0] — 2026-06-30

Title-bar and pane-chrome refresh. The window frame and per-pane controls are reorganised for a
cleaner, more legible look — inspired by VS Code's frame — and three previously mouse-only pane
actions gain keyboard shortcuts.

### Added
- **Keyboard shortcuts for three pane actions** — Launch Claude in a pane (**Ctrl+Shift+L**), tear a
  pane off into its own window (**Ctrl+Shift+N**), and view a pane's session log (**Ctrl+Shift+J**).
  All rebindable in Settings → Keyboard and listed in the shortcuts cheat-sheet.

### Changed
- **Title bar** — the app-action menu (Overview, Palette, Git, Docs, History, Reopen, Settings,
  Shortcuts) moves from left-side text labels to a right-aligned row of icons beside the window
  controls, separated by a divider; minimise/maximise/close are enlarged with crisp SVG glyphs. All
  icons follow the active theme.
- **Per-pane hover controls** — cryptic unicode glyphs are replaced by a consistent set of line
  icons, and the bar is decluttered: only the core actions stay inline (Open in editor, Split, Zoom,
  Close) with the rest tucked into a `⋯` overflow menu whose rows carry text labels and keybinding
  hints.
- **Pane identity chip** — the pane name is set in the UI sans (matching the title bar) with a
  hairline divider before the branch/status, and the chip and hover-control clusters are unified as
  matching glass pills of equal height.

## [1.1.0] — 2026-06-29

Preserve and restore agent work across restarts. Claude Code panes now keep their conversation,
and closed panes/workspaces (and any past Claude session) can be brought back.

### Added
- **Claude session resume** — each Claude Code pane is pinned a stable session id (first run
  `--session-id`, later runs `--resume`), so quitting and reopening Loom resumes that pane's own
  conversation. Per-pane ids let many Claude panes share a folder and still resume their own
  thread. A pinned id only resumes when its transcript actually exists on disk, otherwise it
  re-pins and starts fresh (no more "No conversation found" when a first run was blocked at the
  trust dialog). Toggle in Settings → Agent resume (on by default). Opacity-safe: Loom builds the
  launch command from its own spec and Claude's on-disk session store, never pane output (ADR-0001).
- **Reopen history** — closing a pane or workspace records it (with its session id) in a persisted,
  newest-first list; reopening a Claude pane resumes its conversation. Surfaced three ways:
  **Ctrl+Shift+Z** (reopen last closed), command-palette entries, and a new **Reopen** top-bar
  panel that also browses and resumes **any** past Claude session found under `~/.claude/projects`.
- **Keyboard shortcuts** — **Ctrl+Shift+Y** opens the Reopen panel, **Ctrl+Shift+H** opens History
  (both rebindable in Settings → Keyboard).

## [1.0.0] — 2026-06-29

First stable release. Loom is reoriented from a *generic GUI terminal multiplexer* into an
**agent-first developer environment** — the multiplexer core is unchanged (real PTYs in split
grids, the workspace rail, tear-off), but agents are now first-class and the defaults, surfaces,
and brand lead with driving fleets of CLI agents.

### Added
- **Agents are first-class** (ADR-0008, superseding ADR-0001's "no agent entity" stance). A real
  `Agent`/`Session`/`Task` domain model, fed only by agent-*pushed* signals — Claude Code hooks
  (`loom hooks`, now the full lifecycle taxonomy) and the `loom mcp` server — **never** by parsing
  pane output. The PTY engine stays byte-opaque.
- **Fleet board** — overview mode shows each pane's live agent Task (title + files touched),
  tinted amber for a "needs you" pane.
- **Approvals triage** — a bottom strip lists agents blocked on you with their actual prompt;
  answer the right pane inline (y/n or free text).
- **Interactive git** (ADR-0010) — the Source Control panel grows from read-only to
  review → stage → commit, with per-file and Stage-all controls and a commit bar. Every write is
  user-initiated; Loom never auto-commits, and the writes are not exposed over the control bus.
- **Durable agent history** (ADR-0009) — a SQLite session/task log with cross-session search (the
  command palette and the new **History** top-bar entry), bounded-window pruning configurable in
  Settings → Terminal → Agent history. History survives restarts; live PTYs do not (ADR-0002).
- **New brand** — the woven Loom mark (cyan warp × amber weft) across the title bar, window/tray
  icons, and favicon; the default theme accent moves to the brand cyan.

### Changed
- Reoriented the product identity and defaults toward agent-first. The generic-multiplexer engine
  underneath is untouched — split grids, plain shells, freeform splitting, and multi-window
  tear-off all still work.

## [0.11.0] — 2026-06-25

### Added
- **Code-review queue in Source Control** — the git diff panel is now a review tool.
  Select a diff region (drag lines, or click a hunk header to grab the whole hunk),
  optionally attach a note, then **Send ▸** it to the focused agent pane or **＋** queue
  it. Queued comments collect in a review bar (removable chips) and **Send review ▸**
  sends them all as one numbered "Code review — N comments" message. The panel now stays
  open across sends (review is iterative), and whole-file **＋ file / Send file** shortcuts
  are available. Still strictly read-only — staging/commit stays with the agent.

### Changed
- **Docs panel markdown rendering** now uses a real CommonMark engine (markdown-it):
  tables, nested lists, strikethrough, and proper soft-wrap reflow instead of the previous
  minimal parser. Selecting a rendered block still sends the raw markdown source. The panel
  also gains a fuzzy **filter box** with arrow/Enter navigation, a **change-folder** button
  to re-point the scanned root, and it now **stays open after a send**; the folder scan
  reaches deeper (4 levels).

### Removed
- **Right-side web preview panel** — embedding an `<iframe>` browser was scope creep for a
  terminal multiplexer; a real browser is one Alt-Tab away. The panel, its `Ctrl+Shift+B`
  shortcut/nav item, and its settings were removed.
- **Human broadcast bar** — the manual prompt-to-many-panes bar (and its target modes, saved
  groups, snippets, history, stagger, and per-pane target toggle) was removed as unused;
  multi-agent work here is cross-project, which the single-workspace bar never served. The
  agent-facing fan-out is kept: `loom broadcast` and the `loom mcp` `broadcast` tool still fan a
  prompt to every pane in a workspace via the inter-pane control bus.

### Fixed
- **Mid-stream session-log write failures are now surfaced** — if a pane's opt-in session log
  fails to write partway through, the pane flags the error instead of silently dropping output
  from the log.

## [0.10.0] — 2026-06-24

### Added
- **Per-pane shell picker with WSL support (Windows)** — choose PowerShell, Command
  Prompt, or any installed WSL distro per pane in the new-workspace wizard, so a single
  workspace can mix shells (e.g. Claude in WSL/Ubuntu beside a PowerShell pane). The
  "Fill every pane with" row gains a matching `[agent] in [shell]` selector, and the
  chosen shell is remembered per pane and restored on relaunch.
- **Region capture on Windows** — the screenshot-to-pane control now works on Windows by
  driving the built-in Snip & Sketch overlay and saving the snip as PNG, matching the
  Linux flameshot/grim contract (a cancelled snip leaves the clipboard intact).

### Changed
- **Command panes drop into a shell on exit** — when a pane launched with a command
  (e.g. `claude`) exits, it now opens an interactive shell in the same folder instead of
  going dead, so you keep a usable terminal. Typing `exit` then closes the pane as usual.

### Fixed
- **Panes froze on process exit (Windows)** — quitting a program in a pane (e.g. exiting
  Claude) left the pane stuck on its last frame. On Windows ConPTY the PTY reader never
  sees EOF while the pseudoconsole stays open, so the exit was never detected. Exit is now
  observed independently and the pseudoconsole torn down in the documented ConPTY order,
  so the pane reports the exit and recovers.
- **External editor & `loom` CLI resolution on Windows** — a bare editor command like `code`
  now resolves via PATH×PATHEXT (`code.cmd`), and the `loom`/`loom mcp` sidecar binaries are
  found with their `.exe` suffix so a pane's inter-pane control bus is wired up.

## [0.9.0] — 2026

### Added
- **Open folder in external editor** — a `✎` control on each pane (and `Ctrl+Shift+I`,
  rebindable) launches your configured editor on the pane's working folder. Set the
  command in Settings → Terminal → External editor (e.g. `code`, `subl`, `zed`); the
  folder is appended, or substituted for a `{dir}` token.

### Fixed
- **Copy under WebKitGTK 2.5x (Linux Mint)** — `Ctrl+Shift+C` could silently drop the
  copy when the xterm selection was already cleared as the keystroke was processed,
  leaving the clipboard stale. The last selection is now cached and used as a fallback.

## [0.8.0] — 2026

### Added
- **Per-workspace Source Control & Docs panels** — each workspace independently
  owns whether the docked SC / Docs / Preview panel is open, and the source folder
  is captured from the active terminal when you open it and pinned to that
  workspace. Switching workspaces shows only what that workspace had open.
- Project (repo) name in the Source Control header, beside the branch.
- Documentation: `docs/cli.md` (the `loom` CLI reference), `docs/troubleshooting.md`,
  and this `CHANGELOG.md`.

## [0.7.0] — 2026

### Added
- Collapsible workspace rail with lettered avatars.
- Setting to show/hide the broadcast bar.

## [0.6.0]

### Changed
- **Frameless redesign**: resizable side panels, a Settings overlay, and a refreshed
  window chrome.

## [0.5.1]

### Added
- Multi-window **tear-off**: pop a pane into its own window; torn-off panes stay
  reachable via broadcast and `loom send`.
- Right-side **preview panel** (docked browser view).
- **System tray** + global summon/hide hotkey + close-to-tray.
- Faithful preset layouts, overview drag-reorder, and the **session-log viewer**.
- Workspace polish: `Ctrl+Shift+1–9` jump, duplicate workspace, shortcuts cheat-sheet,
  per-agent tint.
- **`loom mcp`** — the Loom MCP server, exposing the control bus as agent tools.
- **`loom hooks`** — bridge Claude Code lifecycle events to the control bus.
- **Docs reader**: Raw/Preview markdown toggle; mark a passage and send it to a pane.
- **Fleet console**: flagged-reply broadcast, saved groups, agent status.
- Windows support (Linux-side, cross-checked).

### Fixed
- Preserve scrollback across pane tear-off / re-dock.
- Periodic poll no longer freezes the UI thread.
- Square off window corners when maximized/fullscreen.

### Security
- Fixed markdown XSS; hardened file-read commands and the control bus; CSP verified.

## [0.4.0]

### Added
- **Overview mode** — uniform tile wall for fleet-glance (`Ctrl+Shift+O`).
- Desktop notifications on attention + persisted broadcast history.
- `loom attention` — self-flagged "needs you" pane border.
- Per-pane AI agent badges and title-bar polish.
- Single-page workspace launcher with visual layout + fleet fill.
- `Ctrl+Shift+,` opens Settings; app shortcuts work without pane focus.
- Customizable workspace names + double-click rename in the rail.
- `Ctrl+Shift+ +/-` to change terminal font size.

## [0.3.0]

### Added
- **Inter-pane control bus** + the `loom` CLI (ADR-0007).
- Source-control panel with a git diff viewer; send selected diff lines to a pane.
- Per-pane button to launch Claude in the terminal's cwd.
- Snapshot a screen region into the focused pane.
- Live cwd + git branch in pane title bars.
- Configurable key bindings; theming system with light mode and selectable themes.
- Command palette, broadcast power-ups, drag-swap, session logging.

### Fixed
- Stop paste duplicating under WebKitGTK.
- Don't clobber a live control socket on startup.
- Debounce pane refit to stop resize stutter.

## [0.1.0] — initial release

- Loom terminal multiplexer (milestones M0–M6): real PTYs in resizable split grids,
  the left workspace rail, the Start→Layout→Agents wizard, broadcast input, and local
  JSON persistence of workspace intent.

[0.8.0]: https://github.com/lozymon/loom/releases/tag/v0.8.0
[0.7.0]: https://github.com/lozymon/loom/releases/tag/v0.7.0
[0.6.0]: https://github.com/lozymon/loom/releases/tag/v0.6.0
[0.5.1]: https://github.com/lozymon/loom/releases/tag/v0.5.1
[0.3.0]: https://github.com/lozymon/loom/releases/tag/v0.3.0
