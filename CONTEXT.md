# Loom v2 — domain language

Loom v2 is a hub and thin clients for running many AI coding sessions at once, with Claude as the first-class engine. This glossary is the vocabulary for code, docs, and conversation. Terms carried over from v1 keep their v1 meaning unless noted.

## Core

**Hub**:
The long-running process on one machine that owns every Session, terminal, Approval queue, board, and the event log. Survives client disconnects. One per machine, one user per Hub. Replaces v1's **Host**, which was the desktop app itself.
_Avoid_: server (too generic), host (v1 term), daemon, backend

**Desktop app**:
The Tauri shell that starts or attaches to the local Hub, keeps it running in the tray, shows the Hub's own page, and delivers the global push-to-talk shortcut. Also the `loom` command when given arguments. Holds no product state.
_Avoid_: host (v1's in-process design)

**Client**:
A view attached to one or more Hubs: the desktop app, a browser tab, a PWA, the `loom` CLI, or the Cockpit's MCP server. Holds no product state of its own.
_Avoid_: frontend, app (ambiguous with the desktop shell), UI

**Session**:
One conversation or terminal run managed by a Hub, with an Adapter, a working directory, a Permission level, and a semantic State. Has a stable **name** from the name pool (faye, cleo, wade…) and a separate **engine session id** (e.g. Claude's UUID) used for resume.
_Avoid_: thread (T3's word), pane (a Pane is how a terminal Session is shown), agent (the kind of engine, not the run), conversation

**Adapter**:
The module that runs a Session on a particular engine and translates its output into normalized Session events. v2.0 has `claude-sdk` and `pty`. The Hub core never names a CLI; only Adapters do.
_Avoid_: driver, provider, integration

**State**:
A Session's semantic state: `starting`, `working`, `blocked`, `idle`, `done`, `error`. `blocked` always says what on: `approval`, `question`, or `input`. Every State change carries its **Provenance**.
_Avoid_: status (v1's free-text label, a different thing)

**Provenance**:
Where a signal came from, strongest first: `pushed` (the engine said so), `kernel` (process facts), `heuristic` (pattern-matched from screen, always labeled, opt-in). A weaker signal never overrides a stronger one.

**Event log**:
The Hub's append-only record of every normalized Session event, ordered by **seq**. Current state is a projection of it. Terminal bytes are streamed but never logged.
_Avoid_: history (a view over the log), journal

## Approvals

**Approval**:
Something a Session's engine needs decided before it continues, raised about its own work: a **permission** prompt for a tool call, or a **question** with options. Enters the Hub-wide queue.
_Avoid_: prompt (one field of it), clearance (v1's Loom-raised gate about a command, not in v2.0), notification

**Resolver**:
Which stage decided an Approval: `rule`, `steward`, `human`, `cockpit`, or `timeout`. Recorded on every resolution.

**Rule**:
A deterministic allow, deny, or always-ask entry in Claude Code's permission rule syntax, from the Hub or a project's `.loom/policy.json`. Deny beats everything.

**Steward**:
The Hub service that resolves Approvals rules could not, using a model session, within budgets, and escalates the rest to a human with a recommendation. Its model stage is a per-Hub switch; off on the work Hub.
_Avoid_: auto-approver, bot, guard

**Permission level**:
How much a Session may do without a human: `supervised`, `accept-edits`, `assisted`, `full`. Each Hub has a default and a maximum. Only a human may set `full`.
_Avoid_: mode (the engine's own term, e.g. `acceptEdits`, which a level maps to)

**Policy**:
The allow, deny, and always-ask Rules plus an optional approval timeout, in a hub `policy.json` or a project `.loom/policy.json`. Deny beats ask beats allow across both.
_Avoid_: settings (Claude Code's own files), config (hub.json)

**Trust**:
A hub's record that a person accepted a project's exact allow list. Without it those allow rules do nothing. Deny and ask rules never need trust, because they only restrict.
_Avoid_: approve (an Approval is a single request), whitelist

**Approval timeout**:
How long an Approval may wait for a decision before it is denied automatically. From the session, else the project Policy, else the hub Policy.

**Steward mode**:
`recommend`: the Steward only advises on the card. `decide`: it may allow or deny by itself when confident and within budget. Recommend is the default and the first week's setting.

**Override**:
A person rejecting an action the Steward allowed. It cannot undo a tool that ran; it lowers the Session to Supervised and tells the agent.

**Escalation**:
An Approval the Steward passes to a human, carrying its recommendation.

## Orchestration

**Cockpit**:
The one pinned Session per Hub that has tools to see and steer every other Session. An ordinary `claude-sdk` Session with extra tools, not a separate engine.
_Avoid_: orchestrator, main agent, coordinator (a role a Session may play, not the Cockpit itself)

**Session token**:
A per-launch token that lets an engine's tools act as its Session, with the Session's role (session or Cockpit). Distinct from the hub token a person uses.

**Notes**:
Short shared key and value pairs per project that Sessions use to coordinate. In memory only.
_Avoid_: blackboard (v1's name)

**Claim**:
A Session's advisory statement that it is working on a file. Claiming a file someone else holds fails. Released when the Session's engine stops.
_Avoid_: lock (nothing is enforced)

**Role**:
A system-prompt suffix a Session is started with, such as builder, reviewer, scout. Free-form.

**Mission**:
A prompt to the Cockpit describing multi-Session work. Not an entity; just the word for that kind of prompt.

**Card**:
A unit of work on a project's board, `.loom/board.json`. Dispatching a Card starts a Session pinned to it. Carried over from v1.

**Board**:
A project's list of Cards in `.loom/board.json`, in lanes: to do, running, review, done, failed.

**Run**:
Keeping up to N Cards running from the to-do lane. In memory only; never saved to the project.
_Avoid_: auto-drain (v1's name), swarm

**Worktree**:
A separate git checkout on its own branch that a Session can run in, kept in the hub's data directory. It belongs to its main repository for Policy, Trust, and the Board.

**Archive**:
Hiding a Session from the rail after stopping it, optionally removing its Worktree directory. The branch always stays.
_Avoid_: delete (nothing is deleted)

**Workspace**:
A working directory grouping Sessions in the rail. A Session may add a git **worktree** under it, only when asked.
_Avoid_: project (the repo), tab

## Remote and voice

**Hub max** / **Hub default**:
The ceiling and starting Permission level configured on a Hub. A project can lower them, never raise the max.

**Hub list**:
The Hubs one client is connected to at once, each with its own address, token, and connection. The rail shows a section per Hub; the overview and the approvals panel cover all of them. The same Hub reached by two addresses appears once, by hub id.
_Avoid_: workspace (that is a working directory), servers

**Tunnel**:
An SSH port forward from the machine you sit at to a remote Hub's loopback port, opened and kept alive by `loom tunnel`. Loom adds no encryption of its own.

**Push device**:
A browser or installed PWA that registered with a Hub for web push. The Hub notifies it when an Approval has waited for a person longer than the push delay. Stored as a Hub file, not events.
_Avoid_: subscriber, endpoint (that is the push service URL)

**Screen manifest**:
A TOML description of how a terminal CLI without hooks looks when it works, waits, or is idle, matched against the rendered screen. Opt-in per id; states it sets are labeled `heuristic` ("from screen").
_Avoid_: detector, parser

**Changes**:
A session's view of what it changed, from git: uncommitted work against HEAD, or a worktree branch against where it started. A person can revert a hunk or a file there. `files.changed` records the count after each turn.
_Avoid_: diff panel, GitPanel (v1)

**Relay**:
The service on the user's VPS that gives a Hub with no inbound path a public name, `https://<hub>.<relay domain>`. The Hub dials out to it; it forwards the visitor's TLS without opening it, so it sees names, addresses, and ciphertext only (ADR-0014).
_Avoid_: proxy, tunnel (that is SSH), bridge (v1)

**Enrollment**:
Permission for a Hub name on a Relay, made with `loom-relay add-hub`, proven with a secret the Relay stores only as a hash. It admits the Hub to the Relay; people still need the Hub's token.

**Push-to-talk**:
Holding `Ctrl+Shift+Space` (desktop) or a button (browser) to dictate. The transcript lands editable; Enter sends.

**Read-back**:
Speech output of selected events, in English or `pt_BR`. Everything read back is also written.

**Speech**:
Something a Session said out loud to the person with its `speak` tool, recorded as a `speech` event and shown in the timeline.
_Avoid_: announcement, TTS event
