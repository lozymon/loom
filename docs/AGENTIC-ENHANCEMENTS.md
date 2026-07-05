# Loom — agentic-dev-env enhancements (discussion draft)

A fresh backlog aimed squarely at the thesis: *driving a fleet of CLI agents from one window.*
[IDEAS.md](IDEAS.md)'s Tier 1–3 are all **✅ shipped** — this doc picks up where that left off
and pushes past "run terminals side by side" into **orchestrating** a fleet.

Everything here stays **ADR-0001-safe**: Loom never parses pane *output*. State comes in through
the agent-pushed `loom` control bus ([ADR-0007](adr/0007-inter-pane-control-bus.md)) or through
byte-*flow timing* (when data moved, not what it said), never by scraping what scrolls by.

> Status legend: 🟢 mostly wiring existing primitives · 🟡 moderate · 🔴 larger bet.
> Nothing here is decided — this is the menu we're discussing.

---

## 1. Observability — see the fleet without staring at it

The hardest part of running N agents is knowing *which one needs you*. `loom status`/`attention`
already emit the signals; these are new *consumers* of them.

### 1a. Per-workspace "needs you" count 🟢 ✅ shipped
Rather than a standalone status strip (an earlier take that read as "another dashboard to babysit"),
the essential signal lives **on the rail row you already glance at**: an amber count pill showing
*how many* panes in that workspace are raising attention — invisible when zero, so it's quiet at
rest. The rail already had a binary state dot + attention border; this turns the yes/no into a count.

**✅ Built as:** `countNeedsAttention(ids)` (`stores/activity.ts`) mirrors the existing
`anyNeedsAttention`; `WorkspaceRail.tsx` renders it in a `<Show when={needsCount() > 0}>` amber pill
(`.rail-attn-pill`) before the neutral total-count badge — a corner notification-badge on the avatar
in the collapsed rail. Counts on the active workspace too, where it drains as `seePane` clears each
flagged pane on focus. Verified end-to-end in an isolated GUI run (raise → pill, clear → gone).

### 1b. Idle / stuck detection 🟡
A pane showing no PTY output for N seconds while self-reported "working" is probably wedged on a
prompt. Derive an attention signal from **byte-flow timing only** (stays ADR-0001-clean — we time
the stream, we don't read it). Feeds 1a.

### 1c. Cost / token HUD 🟡
If agents emit usage (via a `loom` call or a known file), aggregate spend per pane / workspace.
Running a fleet burns tokens invisibly today. Depends on a usage-reporting convention we'd define.

## 2. Coordination primitives — agents working *together*, not just in parallel

The control bus is the real moat. Today it's send / spawn / broadcast (fire-and-forget). Richer ops:

### 2a. Request/response with correlation 🟡
An agent asks another pane a question and **awaits a structured reply**, rather than fire-and-forget
`send`. Turns panes into callable workers. Extends `ControlRequest` in `protocol.ts`, handled in
`paneControl.ts`; needs a correlation id + a reply path back through the socket relay.

### 2b. Shared blackboard / scratchpad 🟡
A `loom note set/get` key-value store agents read/write to share plan state, claimed files,
"who's doing what." Prevents two agents clobbering the same work. New bus op + a small TS-side store.

### 2c. File-level claims / locking 🟡
`loom claim src/foo.ts` so a coordinator prevents collisions across a fleet. High value with the
worktree/detach model. Could build on 2b (a claim is a well-known note namespace).

## 3. Repeatability — capture a working setup and replay it

### 3a. Workspace templates with roles 🟡
Beyond grid presets: save a named fleet — "1 planner + 3 implementers + 1 reviewer" — each pane
pre-seeded with a launch command **and** an initial prompt. One click reconstitutes an agent team.
Extends the `Preset` snapshot (already carries `tree` + `panes`) with per-pane seed prompts.

### 3b. Session replay / transcript export 🟡
The session-log viewer (`logs.rs` / `SessionLogViewer.tsx`) already tails logs — add export-to-
markdown so a fleet run becomes a shareable artifact.

## 4. Safety rails

### 4a. Per-pane approval gating / dry-run 🟡
Pause a pane's input and require a human OK before a broadcast lands, so one bad `loom broadcast`
can't nuke every repo at once.

### 4b. Git-aware guardrails 🟡
`git.rs`/`GitPanel` already know branch state — warn (or block broadcast) when panes share a
branch/worktree and a destructive command is fanning out.

---

## Where I'd start

**1a is done** — the per-workspace "needs you" count pill shipped (see above). Next up: **1b (idle /
stuck detection)** is a natural follow-on that feeds the same pill, and **1c (cost HUD)** waits on a
usage-reporting convention.

Then the coordination trio (**2a/2b/2c**) is the real differentiator — it's what turns Loom from
"many terminals" into "an agent team." Bigger, but it's the moat.

## Open questions for discussion

- Do agents report **cost/usage** anywhere we can tap, or do we define a `loom usage` convention (1c)?
- Is the blackboard (2b) enough to get file-claims (2c) for near-free, or do we want real locks?
- Should approval gating (4a) be per-pane, per-workspace, or a broadcast-time confirm?
- Templates-with-roles (3a): seed prompts stored in `workspace.json`, or a separate templates file?
