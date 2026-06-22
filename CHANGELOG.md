# Changelog

All notable changes to Termhaus are documented here. The format is loosely based on
[Keep a Changelog](https://keepachangelog.com/), and the project follows semantic
versioning.

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
  reachable via broadcast and `th send`.
- Right-side **preview panel** (docked browser view).
- **System tray** + global summon/hide hotkey + close-to-tray.
- Faithful preset layouts, overview drag-reorder, and the **session-log viewer**.
- Workspace polish: `Ctrl+Shift+1–9` jump, duplicate workspace, shortcuts cheat-sheet,
  per-agent tint.
- **`th-mcp`** — the Termhaus MCP server, exposing the control bus as agent tools.
- **`th hooks`** — bridge Claude Code lifecycle events to the control bus.
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
- `th attention` — self-flagged "needs you" pane border.
- Per-pane AI agent badges and title-bar polish.
- Single-page workspace launcher with visual layout + fleet fill.
- `Ctrl+Shift+,` opens Settings; app shortcuts work without pane focus.
- Customizable workspace names + double-click rename in the rail.
- `Ctrl+Shift+ +/-` to change terminal font size.

## [0.3.0]

### Added
- **Inter-pane control bus** + the `th` CLI (ADR-0007).
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

- Termhaus terminal multiplexer (milestones M0–M6): real PTYs in resizable split grids,
  the left workspace rail, the Start→Layout→Agents wizard, broadcast input, and local
  JSON persistence of workspace intent.

[0.7.0]: https://github.com/lozymon/termhaus/releases/tag/v0.7.0
[0.6.0]: https://github.com/lozymon/termhaus/releases/tag/v0.6.0
[0.5.1]: https://github.com/lozymon/termhaus/releases/tag/v0.5.1
[0.3.0]: https://github.com/lozymon/termhaus/releases/tag/v0.3.0
