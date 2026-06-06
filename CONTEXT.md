# Termhaus

A Linux-first desktop "control room" of real terminals — a GUI terminal multiplexer that runs many PTYs at once in resizable split grids and a left rail of workspaces.

## Language

**Pane**:
A single tile in the grid, bound one-to-one to a PTY running an arbitrary command. The fundamental unit Termhaus renders. Panes are *opaque* — Termhaus streams their bytes but never interprets them. A Pane is **Live** (PTY running) or **Dead** (child exited; tile stays in place showing its exit code with a restart affordance). A Pane only leaves the layout when explicitly closed (✕), never automatically on child exit.
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
Not a first-class concept. An "agent" is merely a Pane whose launch command happens to be a CLI like `claude`. Termhaus has no awareness of what runs inside a Pane.
_Avoid_: session, bot (do not reintroduce an Agent entity)

**Working folder**:
The directory a Workspace's Panes launch in. It is the default launch cwd for every Pane; a Pane may override it. Only the *launch* cwd is persisted and restored — never the live directory a shell later `cd`s into.
_Avoid_: project root, pwd, current directory (the live cwd is deliberately not tracked)

**Broadcast**:
Typing a message once in a dedicated bar and writing it (`text` + newline) to every Live Pane in the *current* Workspace at once, optionally narrowed to a selected subset. Sends discrete messages, not mirrored live keystrokes, and never crosses Workspaces.
_Avoid_: synchronize, mirror (reserved for the deferred live-keystroke mode), blast

**Workspace**:
A top-level container shown as an entry in the left rail: a working folder plus one layout tree of Panes. The unit you switch between. Hierarchy is exactly two levels — Workspace contains Panes, with no intermediate layer.
_Avoid_: tab (implies top tabs and is overloaded — retired entirely), session, project, window (there is deliberately no tmux-style "window" layer)
