# Changelog

All notable changes to Loom are documented here. The format is loosely based on
[Keep a Changelog](https://keepachangelog.com/), and the project follows semantic
versioning.

## [Unreleased]

### Added
- **Session transcript export** (AGENTIC-ENHANCEMENTS §3b) — the session-log viewer can turn a pane's
  transcript into a shareable Markdown artifact: **⧉ Copy MD** copies it to the clipboard (titled
  header + a fenced code block, ANSI stripped), and **⭳ Export…** saves it to a `.md` file via a
  native save dialog. Paste a fleet run straight into a PR, issue, or doc.
- **Durable, project-scoped blackboard** (ORCHESTRATION-IDEAS §4) — the shared blackboard
  (`loom note`) is now keyed by the project folder and persisted to `<repo>/.loom/notes.json` (like
  the task board), instead of being per-workspace and ephemeral. So a fleet's notes — who owns what,
  a discovered gotcha, a handed-off decision — travel with the repo, survive close/reopen, are shared
  by every workspace on that folder, and a **new session inherits what earlier ones learned**. Still
  agent-pushed, never scraped from output. Folderless workspaces stay in-memory.
- **Workspace templates with roles + seed prompts** (AGENTIC-ENHANCEMENTS §3a) — a saved fleet now
  reconstitutes a whole agent team in one click. Each pane carries a per-pane **seed prompt** (a new
  `seed` field in the New-workspace wizard, alongside cmd/cwd) that's typed in once on launch, and
  its **role** (which already rides on the pane spec, so presets capture it automatically). Seeds
  fire only on a genuine creation — never on restart or a session-resume — so an agent is briefed
  exactly once. Launch "planner + 3 implementers + reviewer", each pre-briefed, from a single preset.
- **Approval gate + bus-command audit timeline** (ORCHESTRATION-IDEAS §3) — two operator surfaces on
  the coordination bus. **Hold/gate:** `loom hold <path>` marks a path *held* so an agent's `claim`
  on it blocks until you release it (a lightweight approval gate reusing file claims); the Fleet
  panel shows a gated badge + a release button, and `hold_file` is an MCP tool. **Bus activity:** a
  new tab in the session-log viewer shows every cross-pane command (op · target · outcome) newest-
  first, with failures flagged — an auditable timeline of who drove whom. Opacity-safe: it records
  the commands Loom relays, never pane output.
- **Roles as a resolvable bus target** (ORCHESTRATION-IDEAS §2) — tag a pane with a role
  (`loom role reviewer`, or `loom role Cleo builder`) so a driving agent can address *the reviewer*
  instead of remembering pane names. Roles persist on the `PaneSpec` (survive restart), show as an
  accent title-bar badge and a column in `loom list`, and are targeted with a `role:<name>` prefix:
  `loom send role:reviewer "…"` fans out to **every** reviewer pane (a role is a group), `loom focus
  role:builder` reveals the first. Available over the bus and as the `set_role` MCP tool.

## [1.9.0] — 2026-07-09

A task board for driving a fleet — dispatch work cards into panes and let the board auto-drain a
queue — plus copy/paste that finally works inside the Claude Code CLI.

### Added
- **Task board** — a docked Kanban (Ctrl+Shift+B) that turns work into cards you *dispatch* into
  panes: each card is a launch spec + prompt, project-scoped in `.loom/board.json` (so it travels
  with the repo), with a floating Markdown editor and pointer drag-reorder. A dispatched card's live
  Session/Task state (ADR-0008) drives it back to Done on its own. Agents can create/list/move cards
  over the control bus (`loom card …` / the `card_*` MCP tools).
- **Board auto-drainer** — arm it and Loom keeps the In-progress lane filled to a concurrency cap by
  dispatching the top To-do cards, refilling a slot as each one finishes — the board becomes an
  autonomous work queue. Session-only (never persisted, so a repo can't ship it on), with a header
  toggle + a `loom card drain on --cap N` bus verb so a lead agent can start the swarm itself.

### Fixed
- **Copy/paste in the Claude Code CLI** — three separate bugs. Pastes now go through bracketed-paste
  mode, so multi-line text lands in claude's prompt as one block instead of submitting line-by-line.
  Copy writes through GTK's clipboard on Linux, so it reaches *other* apps (arboard, used by the
  clipboard plugin, doesn't export to external apps inside WebKitGTK). And Loom now honours **OSC
  52** — the escape sequence claude uses to copy — which was previously ignored, so claude's copies
  silently vanished (write-only; clipboard *reads* stay declined for privacy).

## [1.8.0] — 2026-07-08

A token/cost usage HUD for the Fleet panel, plus a small UI refinement to the resize seams.

### Added
- **Fleet usage HUD** — the Fleet panel now surfaces per-agent **token and estimated cost** totals.
  Usage is read from Claude's own on-disk session transcripts via the Rust `claude_usage` command
  (summing input / output / cache-read / cache-write tokens per model) — never from pane output
  (ADR-0001) — and priced with a small per-model $/MTok table. Cost is an *estimate*: rates are
  cached from the claude-api reference and can drift.

### Changed
- **Thinner resize seams** — the pane split gutters and the rail↔grid strip now paint a 2px centred
  hairline on hover instead of lighting up their full 6px grab width, with a soft fade. The 6px grab
  area is unchanged and seams stay invisible at rest.

## [1.7.0] — 2026-07-07

Two fleet features — knowing when an agent is stuck, and remembering agents you start by hand —
plus a platform fix that had been silently breaking live process detection on Linux.

### Added
- **Idle / stuck detection** — an agent pane that's been silent past a threshold (Settings → *Idle
  agent detection*, default 45s, 0 = off) is flagged "needs you": a steady amber ring + a "💤 idle"
  chip badge, and it joins the rail's attention count. Catches an agent (e.g. `claude`) that stays
  the foreground process while quietly waiting on a prompt — the case the busy→idle signal misses.
  Opacity-safe: byte-flow *timing* only (`lastOutputAt`), never output content.
- **Agent adoption** — start an agent *by hand* (type `claude` in a shell pane) and Loom remembers
  it as that pane's launch command, so it persists and **resumes on restart** instead of coming
  back a plain shell. Automatic by default (Settings → *Remember hand-started agents*), with a short
  dwell so a one-off `claude --help` isn't adopted; a manual "📌 keep" chip button when off. For
  Claude, the current conversation's session is captured so the restart resumes it.

### Fixed
- **Live process detection on Linux** — the pane's process snapshot used sysinfo's plain
  `refresh_processes`, which defaults to a minimal refresh that leaves argv *and* cwd empty. So the
  foreground-command read (live agent detection) and the cwd (pane title) both silently returned
  nothing: panes showed their pool name instead of the folder, and a hand-started agent was never
  noticed. Now fetches both via `ProcessRefreshKind::everything()`.

## [1.6.0] — 2026-07-06

Voice dictation goes multi-language: dictate in more than English, pick your Whisper model, and pin
or auto-detect the spoken language.

### Added
- **Multi-language dictation** — the dictation hotkey now transcribes any language a multilingual
  Whisper model supports (e.g. English + Portuguese + Norwegian), not just English.
- **Model picker** — choose the Whisper model in Settings. `*.en` models stay English-only; the
  multilingual models (small/medium/large-v3) auto-detect the spoken language. Models download on
  first use with progress feedback.
- **Forced language** — pin a dictation language (or Auto-detect) from Settings or the command
  palette (`Dictation language: …`), without reopening Settings each time.
- **Quantized models** — smaller/faster model variants for lower-memory machines.

## [1.5.1] — 2026-07-06

A Windows-focused follow-up to 1.5.0: make the Windows build actually ship and run. Linux and
macOS builds are unchanged.

### Fixed
- **Windows installer** — ship only the NSIS installer, not the raw `loom.exe` alongside it.
- **loom-voce on Windows** — the voice-dictation helper now builds and runs: statically link the
  MSVC runtime (no `MSVCP140.dll`/`VCRUNTIME140.dll` dependency on a clean machine, via
  `+crt-static` through `RUSTFLAGS`), and suppress the console-window popups every auxiliary child
  (git, editor, loom-voce, capture, `wsl.exe`) would otherwise flash.
- **Multi-agent workspaces on Windows** — spawn agent panes directly instead of through
  `powershell -Command`, and serialize PTY spawns so every pane in a multi-pane workspace starts
  reliably instead of racing.

### Added
- **loom-voce in the Windows installer** (P2.3) — the voice helper is bundled into the NSIS
  installer via `externalBin`, matching the Linux `.deb`/AppImage and the macOS dmg.

## [1.5.0] — 2026-07-05

Two themes: **fleet coordination** (agents working together over the control bus) and the start of
**cross-platform support** — macOS joins Linux and Windows as a buildable target. Everything stays
opacity-safe (ADR-0001), and the Linux build stays byte-identical and no-sudo-buildable.

Fleet coordination. The inter-pane control bus (ADR-0007) grows from fire-and-forget messaging into
a set of primitives a fleet of agents uses to work *together* — share state, avoid file collisions,
and call each other — on both the `loom` CLI and the `loom mcp` server, plus a Fleet panel to see it
all. Everything is agent-pushed and opacity-safe: Loom still never parses pane output (ADR-0001).

### Added
- **Shared blackboard** (`loom note set/get/list/del`; `board_*` MCP tools) — a per-workspace
  key/value board agents post plan state to and poll ("who owns what", a discovered gotcha), so a
  fleet can coordinate without clobbering each other's work. Scoped to the caller pane's workspace;
  each entry records its writer.
- **File claims** (`loom claim` / `release` / `claims`; `claim_file` / `release_file` /
  `list_claims` MCP tools) — cooperative advisory locks so two agents don't edit the same file.
  `claim` is an atomic test-and-set that exits non-zero when the path is already held, so
  `loom claim <path> || work_on_something_else` scripts cleanly. A pane's claims **auto-release**
  when its process exits or the pane is closed, so a crashed agent can't leave a stale lock.
- **Ask/reply RPC** (`loom ask <pane> <question>` / `loom reply <id> <answer>`; `ask_pane` /
  `reply_ask` MCP tools) — request/response over the bus: an agent asks another pane a question and
  **blocks until that pane's agent answers**, turning a pane into a callable worker
  (`answer=$(loom ask Cleo "which auth lib?")`). Correlation ids are carried in the prompt Loom
  types into the callee; a long-poll mailbox keeps it within the bus's parked-connection cap.
- **MCP parity for coordination** — the blackboard, claims, and ask/reply are all first-class
  `loom mcp` tools (nine new), so model-native agents reach them as tools instead of shelling out.
- **Fleet panel** (**Ctrl+Shift+K**, the title-bar ◈ button, or the command palette) — a docked
  side panel showing the active workspace's blackboard and file claims with live counts. Purely
  reactive: a note or claim from any pane updates it live, and it re-scopes when you switch
  workspaces.
- **Per-workspace "needs you" count** — each workspace row in the rail shows an amber pill with how
  many of its panes are raising attention (invisible when zero), turning the previous yes/no dot
  into a count so you can see at a glance which group wants you.

### Added — cross-platform
- **macOS is now a buildable target** — CI lints *and* builds a `.dmg` (arm64) on `macos-latest`,
  alongside the existing Linux `.deb`/AppImage and Windows NSIS installer. *(The dmg is unsigned for
  now — macOS Gatekeeper needs a right-click → Open until notarization lands.)*
- **Cross-platform process floor** — the live cwd, foreground-command, and busy signals that drive
  the Source Control panel and the agent badge now run on one `sysinfo`-based code path across Linux,
  macOS, and Windows (previously Linux-only `/proc` reads). macOS gains the full floor; Windows gains
  live cwd. Still process metadata only — never pane output (ADR-0001).
- **`Cmd+Shift` shortcuts on macOS** — the app-shortcut namespace (ADR-0005) renders and fires as
  `Cmd+Shift` on macOS (the native modifier, never sent to the PTY) and `Ctrl+Shift` everywhere else.
- **Voice dictation on macOS** — `loom-voce` gains a `cpal` capture backend (CoreAudio on macOS,
  WASAPI on Windows) with in-process resampling to 16kHz, and now ships inside the macOS `.app`.
  Linux keeps its header-free `parecord`/`arecord` path unchanged. *(Windows helper bundling and
  real-microphone verification are still pending.)*

## [1.4.0] — 2026-07-04

Work landed on top of the 1.3.0 release: a packaging fix so voice dictation works on the AppImage,
the voice-monologue and pane-identity features, and hardened tests around the PTY core.

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

## [1.3.0] — 2026-07-02

Voice dictation. A new speech-to-text helper lets you talk a prompt into a pane instead of typing it.

### Added
- **Voice dictation** (**Ctrl+Shift+M**) — a new `loom-voce` helper captures a single utterance,
  transcribes it on-device with whisper.cpp, and types the text into the focused pane over the
  control bus (`loom send`) — Loom never reads pane output (ADR-0001). Resolves the helper via
  `$LOOM_VOCE_BIN` → a sibling of `loom` → `PATH`. **Linux-only**: audio is captured through
  `parecord`/`arecord` (PulseAudio/ALSA).
- **`loom-commands` skill** — a reference skill for driving Loom panes from inside a pane (the
  `loom` inter-pane control CLI and the equivalent `loom mcp` tools).

### Build
- **`loom-voce` packaging** — the helper is a co-located but standalone Cargo crate (kept out of the
  `src-tauri` workspace so its whisper.cpp/cmake toolchain never touches the main build/CI).
  `npm run build:all` builds it and bundles it into the `.deb` beside `loom` at `/usr/bin/loom-voce`,
  so sibling-resolution needs no env var; the release CI job builds, bundles, and lint/tests it.

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
