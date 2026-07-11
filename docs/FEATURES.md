# Loom — feature catalogue

Every shipped capability, one line each: **what it is · where it lives · why** (ADR for the
design decision; `roadmap/…§` for the backlog entry it came from). This is the "what exists" index
— the counterpart to [`roadmap/`](roadmap/) ("what we might build") and [`adr/`](adr/) ("why").

> **Maintenance rule.** When a `roadmap/` item ships, add its line here and flip it to ✅ there (or
> drop it from the roadmap once this catalogue covers it). When you change a feature, update its
> line. Code comments that need design rationale should point at the **ADR**; comments that just
> need "where does this live" can point here.
>
> Legend: ✅ shipped · 🟡 partial / open sub-item · ❌ removed. `path` = primary source file(s).

---

## Terminal engine & panes
- ✅ **Real PTYs, one per pane** — `HashMap<PaneId, PtySession>`, a reader+coalescing-flush thread each. `src-tauri/src/pty.rs` · [ADR-0002](adr/0002-ptys-live-in-app-process-no-detach.md)
- ✅ **Output transport** — bytes over a Tauri `Channel<String>` (base64), frame-rate-capped + back-pressured so WebKitGTK survives floods. `pty.rs`, `src/lib/ptyClient.ts` · [ADR-0003](adr/0003-output-transport-channel-first-websocket-fallback.md)
- ✅ **Canvas renderer** (not WebGL) with `@xterm/addon-fit`. `src/components/Terminal.tsx` · [ADR-0006](adr/0006-canvas-renderer-not-webgl.md)
- ✅ **Login-interactive-shell launch** — panes spawn the user's real shell. `pty.rs` · [ADR-0004](adr/0004-launch-via-login-interactive-shell.md)
- ✅ **Split-tree layout** — binary `LayoutNode` grid, draggable gutters, split/collapse/promote. `src/lib/layout.ts`, `src/components/LayoutNode.tsx`
- ✅ **Grid presets** — 1/2/4/6/8/10/12-pane balanced trees. `src/lib/grid.ts`, `NewWorkspaceWizard.tsx`
- ✅ **Pane title bar & controls** — auto-name (Faye, Cleo…), focus ring, collapse/split/zoom/close. `Terminal.tsx`
- ✅ **Copy / paste / search / scrollback**. `src/lib/clipboard.ts`, `src/lib/scrollback.ts`, `src/lib/ansi.ts`
- ✅ **Multi-window tear-off** — a live pane retargets its output Channel to another window. `src/lib/detach.ts`, `DetachedPane.tsx`, `pty_retarget`
- ✅ **Per-agent border tint** — pane root gets `--agent-color` when an agent is detected. `Terminal.tsx` · roadmap/IDEAS §11

## Workspaces & layout
- ✅ **Left workspace rail** — name + terminal-count badge + close; switching swaps the whole grid, hidden PTYs stay alive. `src/components/WorkspaceRail.tsx`
- ✅ **New-workspace wizard** — 3-step Start → Layout → Agents. `NewWorkspaceWizard.tsx`
- ✅ **Presets capture the real layout** — deep-copied `tree` + `panes` snapshot. `src/stores/workspace.ts` · roadmap/IDEAS §5
- ✅ **Workspace templates with roles + seed prompts** — `prompt?` on `PaneSpec`, replayed on launch. `src/ipc/protocol.ts` · roadmap/AGENTIC-ENHANCEMENTS §3a
- ✅ **Duplicate workspace** — deep-clones split tree + panes. `stores/workspace.ts` · roadmap/IDEAS §7
- ✅ **Quick workspace switch** — `switch-workspace-1…9` (default Ctrl+Shift+1…9). `src/lib/keybindings.ts` · roadmap/IDEAS §6
- ✅ **Drag-to-reorder panes in overview** — draggable `.overview-hit` tiles. roadmap/IDEAS §8
- ✅ **Reopen / history search** — recently-closed panes & workspaces. `ReopenPanel.tsx`, `HistorySearch.tsx`, `src/lib/persist.ts`
- ✅ **Persistence** — Workspaces + trees + per-pane `PaneSpec` to `workspaces.json`; respawn, not scrollback-restore. `src-tauri/src/workspace.rs`

## Agent control bus (drive the fleet)
- ✅ **Inter-pane control bus** — Rust unix-socket relay (pure forwarder), routing in TS. `src-tauri/src/control.rs`, `control_transport.rs`, `src/lib/paneControl.ts` · [ADR-0007](adr/0007-inter-pane-control-bus.md)
- ✅ **`loom` CLI** — list / send / spawn / read / broadcast / focus / attention / status / card, from inside a pane. `src-tauri/src/cli.rs` · [reference/cli.md](reference/cli.md)
- ✅ **`loom mcp` server** — the control bus as model-native MCP tools (stdio JSON-RPC). `src-tauri/src/mcp.rs` · roadmap/IDEAS §C · [reference/agent-mcp.md](reference/agent-mcp.md)
- ✅ **`loom hooks`** — prints Claude Code hook config to auto-push lifecycle→status. `cli.rs` · roadmap/IDEAS §B · [reference/agent-hooks.md](reference/agent-hooks.md)
- ✅ **Broadcast (fan-out)** — one prompt to every pane / a saved group. `paneControl.ts`
- ✅ **Saved broadcast groups**. `src/stores/settings.ts` · roadmap/IDEAS §2
- ✅ **Voice dictation** — Ctrl+Shift+M → `loom-voce` (speech→text→`loom send`). `src-tauri/src/voce.rs`, `src/lib/voceClient.ts`, `ListeningOverlay.tsx`, `loom-voce/`

## Agent awareness (first-class, self-reported)
- ✅ **Agents first-class** — `Agent` / `Session` / `Task` entities from pushed signals. `src/stores/sessions.ts` · [ADR-0008](adr/0008-agents-first-class-via-self-report.md)
- ✅ **Panes stay opaque** — the PTY hot path never parses output. · [ADR-0001](adr/0001-opaque-panes-no-agent-awareness.md)
- ✅ **Agent-controlled status label** — `status` on `PaneActivity`. `src/stores/activity.ts` · roadmap/IDEAS §3
- ✅ **Attention / "needs-input" triage** — flag + resolve the flagged set. `activity.ts`, `stores/workspace.ts` (`flaggedTargets`) · roadmap/IDEAS §1
- ✅ **Per-workspace "needs you" count** — `countNeedsAttention(ids)`. `activity.ts` · roadmap/AGENTIC-ENHANCEMENTS §1a
- ✅ **Idle / stuck detection** — pure timing predicate (`isPaneStuck`, `idleStuckSeconds`). `src/lib/idle.ts` · roadmap/AGENTIC-ENHANCEMENTS §1b
- ✅ **Cost / token HUD** — per-session token/cost accounting for the Fleet panel. `src/lib/claudeUsage.ts` · roadmap/AGENTIC-ENHANCEMENTS §1c
- ✅ **Claude session detection** — resolve the live session in a pane's cwd. `src/lib/claudeSessions.ts`, `src-tauri/src/claude.rs`
- 🟡 **Heuristic output-observer tier** — *authorized, off by default*; a labeled, lossy awareness floor for hookless agents. No consumer wired yet. · [ADR-0011](adr/0011-heuristic-output-observer.md)

## Coordination primitives (agents working together)
- ✅ **Shared blackboard** — durable, project-scoped notes keyed by folder. `src/stores/blackboard.ts` · roadmap/ORCHESTRATION-IDEAS §4, roadmap/AGENTIC-ENHANCEMENTS §2b
- ✅ **File-level claims / locks** — sibling of the blackboard. `src/stores/claims.ts` · roadmap/AGENTIC-ENHANCEMENTS §2c
- ✅ **Path gates (`held`)** — mark a path held so a `claim` on it blocks. `claims.ts` · roadmap/ORCHESTRATION-IDEAS §3
- ✅ **Roles as a resolvable bus target** — persisted `role?` on `PaneSpec`; `loom send @reviewer`. `src/ipc/protocol.ts`, `Terminal.tsx` badge · roadmap/ORCHESTRATION-IDEAS §2
- ✅ **Ask/reply RPC** — correlated request/response, ~10s park cap. `src/lib/askRegistry.ts` · roadmap/AGENTIC-ENHANCEMENTS §2a
- ✅ **Task board** — a docked Kanban of cards that dispatch into panes; `loom card`. `src/stores/board.ts`, `BoardPanel.tsx` · roadmap/ORCHESTRATION-IDEAS §1
- ✅ **Approval gate + bus-command audit timeline**. `src/stores/audit.ts`, `FleetApprovals.tsx` · roadmap/ORCHESTRATION-IDEAS §3
- ✅ **Fleet panel** — makes blackboard / claims / roles state visible. `src/components/FleetPanel.tsx` · roadmap/AGENTIC-ENHANCEMENTS §2e
- ✅ **MCP parity for coordination tools** — the primitives above exposed as agent tools too. `mcp.rs` · roadmap/AGENTIC-ENHANCEMENTS §2d
- ✅ **Git-aware guardrails** — confirm gate on destructive `loom broadcast`. `src/lib/guardrails.ts`, `paneControl.ts` · roadmap/AGENTIC-ENHANCEMENTS §4b

## Side panels & tools
- ✅ **Interactive git panel** — stage / commit, still user-confirmed. `src/components/GitPanel.tsx`, `src-tauri/src/git.rs`, `src/lib/gitClient.ts` · [ADR-0010](adr/0010-interactive-git.md)
- ✅ **Docs reader** — walk the focused pane's cwd for markdown, mark & send to a Claude pane. `DocsPanel.tsx`, `src-tauri/src/docs.rs`, `src/lib/docsClient.ts` · roadmap/IDEAS §4
- ✅ **Session-log viewer + transcript export** — tail logs; ⧉ Copy MD / export. `SessionLogViewer.tsx`, `src-tauri/src/logs.rs`+`sessionlog.rs` · roadmap/IDEAS §10, roadmap/AGENTIC-ENHANCEMENTS §3b
- ✅ **Command palette**. `src/components/CommandPalette.tsx`
- ✅ **Shortcuts cheat-sheet overlay (`?`)** — derived from the keybinding table. `ShortcutsOverlay.tsx` · roadmap/IDEAS §9
- ✅ **Region capture → pane** — screenshot into a pane's prompt. `src-tauri/src/capture.rs`, `src/lib/capture.ts`
- ✅ **Markdown editor**. `src/components/MarkdownEditor.tsx`, `src/lib/markdown.ts`
- ✅ **Settings & themes**. `src/components/Settings.tsx`, `src/stores/theme.ts`

## System integration & platform
- ✅ **System tray** — summon / hide the window. `src-tauri/src/tray.rs` · roadmap/IDEAS (bigger bets)
- ✅ **Global hotkey**. `src/lib/globalHotkey.ts` · roadmap/IDEAS (bigger bets)
- ✅ **Ctrl+Shift shortcut namespace** — everything else passes through to the PTY. `src/lib/keybindings.ts` · [ADR-0005](adr/0005-ctrl-shift-shortcut-namespace.md)
- ✅ **Platform-aware `Mod` key** — Cmd+Shift on macOS. `keybindings.ts` · roadmap/CROSS_PLATFORM_PARITY §P4
- 🟡 **SQLite session/task log** — decision recorded; store lands when the logging need is built out. · [ADR-0009](adr/0009-sqlite-session-task-log.md)
- 🟡 **Cross-platform parity (Linux / macOS / Windows)** — Linux + macOS/Windows builds ship; region-capture parity (P3) and signing/docs (P5) open. · roadmap/CROSS_PLATFORM_PARITY

## Open (tracked in roadmap, not yet built)
- 🟡 **Per-pane approval gating / dry-run** — roadmap/AGENTIC-ENHANCEMENTS §4a
- 🟡 **De-Linux the capture error string** — roadmap/PRE_WINDOWS_CHECKLIST D10
- 🟡 **Cross-OS region capture, code-signing/notarization** — roadmap/CROSS_PLATFORM_PARITY P3 / P5

## Removed (kept for the record)
- ❌ **Human broadcast-input bar** — removed 2026-06-25 (fan-out is agent-driven only now). See [roadmap/ASSESSMENT.md](roadmap/ASSESSMENT.md)
- ❌ **Embedded browser preview** — shipped then removed 2026-06-25. roadmap/IDEAS (bigger bets)
