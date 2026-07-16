# Loom

A Linux-first desktop **agent-first developer environment** built on real terminals — a control room for driving and observing a fleet of CLI agents, running many PTYs at once in resizable split grids and a left rail of workspaces. The engine stays generic (a Pane is any PTY); the product leads with agents.

## Language

**Pane**:
A single tile in the grid, bound one-to-one to a PTY running an arbitrary command. The fundamental unit Loom renders. Panes are *byte-opaque in the engine* — the PTY hot path streams their bytes and never parses them. Loom's awareness of an agent comes from what the agent pushes (bus/hooks/MCP) or the kernel exposes (cwd, foreground pgrp); a separate opt-in observer may derive *heuristic* signals from output, always marked lossy and overridden by a pushed signal (ADR-0008, ADR-0011). A Pane is **Live** (PTY running) or **Dead** (child exited; tile stays in place showing its exit code with a restart affordance). A Pane only leaves the layout when explicitly closed (✕), never automatically on child exit.
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
Writing one message (`text` + newline) to every Live Pane in a single Workspace at once, over the control bus. **Agent-driven only** — `loom broadcast` / the `loom mcp` tool: the human broadcast bar was removed 2026-06-25 as unused, because multi-agent work is cross-*project* and a single-Workspace fan-out never served it. Sends discrete messages, not mirrored live keystrokes, and never crosses Workspaces. Appends a newline, so it cannot carry control characters — a Broadcast is not an interrupt.
_Avoid_: synchronize, mirror (reserved for the deferred live-keystroke mode), blast, broadcast bar (removed — do not reintroduce a human one without revisiting that decision)

**Workspace**:
A top-level container shown as an entry in the left rail: a working folder plus one layout tree of Panes. The unit you switch between. Hierarchy is exactly two levels — Workspace contains Panes, with no intermediate layer.
_Avoid_: tab (implies top tabs and is overloaded — retired entirely), session, project, window (there is deliberately no tmux-style "window" layer)

## Remote control (planned — [ADR-0012](docs/adr/0012-remote-fleet-control-dial-out-vps-relay.md))

**Host**:
One running Loom — the process owning the Panes, the PTYs, and the control bus. Single-instance per machine, so in practice a Host is "the work laptop" or "the home desktop". A Device identifies a Host by its Bridge static key, never by name or address: the name is a mutable label, the key is the identity. The thing the app's picker picks and a Clearance names when it asks.
_Avoid_: instance (a coinage with no domain meaning), server, node, machine (the Host is the running Loom, not the box)

**Origin**:
The provenance of a bus command — `local` (a Pane/CLI on the same machine, ADR-0007's trust model) or `device:<name>`, where `<name>` is a Device label **scoped to its Host** (two Hosts may each hold a "kim-pixel" with no collision, since neither shares a namespace). The dimension the remote policy table and the audit timeline branch on; ADR-0007's bus was deliberately origin-blind, and remote control is what forces the distinction.
_Avoid_: source, caller, sender

**Device**:
A paired remote principal **as one Host knows it** — a public key, a routing id, and a Host-local label. Not a phone: a phone holds a Pairing with each Host it has scanned, with an **independent keypair per Pairing**, so one phone appears as N unrelated Devices across N Hosts and revoking it at work leaves home untouched. (The kind/run distinction mirrors Agent/Session.) The remote principal ADR-0007 excluded. A Host stores only the Device's *public* key — Revoke deletes it, and the next handshake fails at the Bridge, needing no help from the Relay.
_Avoid_: client, phone, mobile (the running app is the client; the paired identity is a Device), token (the Relay bearer token is a separate, availability-only thing)

**Pairing**:
The relationship between one Host and one Device, established in person by scanning the Host's QR. **The only trust anchor in remote control** — the sole thing that answers "is this *my* Loom?", and the reason a compromised Relay can break availability but never confidentiality. Carries the end-to-end key. A phone holds one Pairing per Host; revocation is always from the Host side.
_Avoid_: connection, link, session (a Session is an Agent run — a different thing entirely)

**Clearance**:
The go/no-go a bus command must obtain before it executes, whenever policy demands a human — the input gate, the spawn or destructive-broadcast guard, or a remote command's `approve` disposition. Parked and *non-blocking* (never a synchronous modal, which would freeze every Pane's rendering), answerable at the laptop or from a paired Device, and **default-denied** on timeout. Distinct from an Approval: an **Agent** raises an Approval about *its own work*; **Loom** raises a Clearance about *a command*. A Clearance is an authorization boundary only where actor and decider differ (an Agent's command, decided by the user) — for a command the user sent from their own Device it is a Confirmation, catching typos, not attackers.
_Avoid_: approval (a different thing — see above), confirm, modal, prompt

**Bridge**:
Loom's in-process network front-end onto the control bus: it dials out to the Relay, terminates the end-to-end hop, and injects the same `ControlRequest` the local socket would (tagged with its Origin). Transport only — routing and policy stay in TS, per the golden split.
_Avoid_: gateway, proxy, server

**Relay**:
The blind rendezvous service on the user's VPS that joins a Device's connection to its Host's and forwards sealed frames between them. Sees only ciphertext and routing metadata, never plaintext — its routing table is untrusted input, so misrouting yields an undecryptable frame rather than a leak. Blind, but not stateless: it remembers Pairings in order to route them.
_Avoid_: server, broker, hub
