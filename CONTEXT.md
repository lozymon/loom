# Loom

A Linux-first desktop "control room" of real terminals — a GUI terminal multiplexer that runs many PTYs at once in resizable split grids and a left rail of workspaces.

## Language

**Pane**:
A single tile in the grid, bound one-to-one to a PTY running an arbitrary command. The fundamental unit Loom renders. Panes are *opaque* — Loom streams their bytes but never interprets them. A Pane is **Live** (PTY running) or **Dead** (child exited; tile stays in place showing its exit code with a restart affordance). A Pane only leaves the layout when explicitly closed (✕), never automatically on child exit.
_Avoid_: terminal (the visible thing is a Pane; "terminal" is ambiguous between the UI tile and the OS device), window, cell

**Pane name**:
A short, distinct human name (Faye, Cleo, Wade…) auto-assigned from a curated pool, unique within a Workspace, shown in the title bar. A pure label for referring to a Pane — never its identity (that is the `PaneId`). Persisted and user-renamable. Distinct names exist because a fleet often runs the same command, making command/index labels useless.
_Avoid_: title (use in code/`PaneSpec` only), label, id (the id is the PaneId, a different thing)

**Dead Pane**:
A Pane whose child process has exited. Its tile is retained in place (greyed, showing exit code) rather than collapsing the grid — preserving layout and post-mortem evidence. Restart respawns the same command in the same slot.
_Avoid_: closed pane, zombie

**PTY**:
The OS pseudo-terminal (master/slave pair) behind a Pane. Owned by Rust; one per Pane.
_Avoid_: tty, console

**Agent**:
A *kind* of CLI agent Loom can run and represent — Claude Code, Codex, Aider, or a user-defined one — held as a registry entry (stable `AgentId`) and resolved from a Pane's launch command. The kind, not the running instance (that is a Session). See [ADR-0008](docs/adr/0008-agents-first-class-via-self-report.md).
_Avoid_: agent type, bot, tool

**Session**:
One run of an Agent inside a Pane, over time — the durable unit the fleet view and session log key off (not the Pane, not an ephemeral status flag). A Pane hosts many Sessions in sequence (each launch, including a `--resume`, is a new one); at most one is Live at a time. Its record outlives the Pane.
_Avoid_: agent (the run is a Session, the kind is an Agent), conversation, thread

**Task**:
A unit of work an Agent reports doing within a Session — granularity is the agent's to set (one per turn by default, finer when it explicitly declares them). Its title and touched files are always agent-pushed, never inferred from a Pane's output.
_Avoid_: turn, job, step

**Approval**:
The structured "needs you" a Task carries while blocked on the user — the agent's actual prompt plus its kind (permission / question / choice). The rich form of the coarse `attention` signal; it lives and dies with its Task's blocked state, not as a standalone entity.
_Avoid_: prompt (just one field of it), notification

**Attention**:
The coarse "needs you" signal — a binary amber border a Pane's agent raises and clears by pushing a signal (never inferred from output). The opacity-safe floor beneath Approval.
_Avoid_: alert, notification, badge

**Status**:
A short, agent-pushed label for what a Pane's agent is doing (e.g. "running tests"), shown in the title bar and overview. The coarse floor beneath Task.
_Avoid_: state (a Session/Task has a `state`; this is a free-text label)

**Working folder**:
The directory a Workspace's Panes launch in. It is the default launch cwd for every Pane; a Pane may override it. Only the *launch* cwd is persisted and restored — never the live directory a shell later `cd`s into.
_Avoid_: project root, pwd, current directory (the live cwd is deliberately not tracked)

**Broadcast**:
Typing a message once in a dedicated bar and writing it (`text` + newline) to every Live Pane in the *current* Workspace at once, optionally narrowed to a selected subset. Sends discrete messages, not mirrored live keystrokes, and never crosses Workspaces.
_Avoid_: synchronize, mirror (reserved for the deferred live-keystroke mode), blast

**Workspace**:
A top-level container shown as an entry in the left rail: a working folder plus one layout tree of Panes. The unit you switch between. Hierarchy is exactly two levels — Workspace contains Panes, with no intermediate layer.
_Avoid_: tab (implies top tabs and is overloaded — retired entirely), session, project, window (there is deliberately no tmux-style "window" layer)
