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

The control bus is the real moat. Today it's **fire-and-forget, one-way**: `loom send Cleo "run
tests"` types into Cleo's PTY and the sender learns only "delivered" — it can't *hear back*, and
there's no shared state between panes. The sender certainly can't read Cleo's answer without
scraping output, which ADR-0001 forbids. Section 2 fixes exactly that. All three ops stay
opacity-safe: agents *push* structured data through the bus; Loom never parses pane output.

**Build order (cheapest first):** 2b → 2c → 2a — **all three now shipped.** The blackboard came
first (smallest), claims layered on the same shape, and ask/reply (the stateful one) last.

### 2b. Shared blackboard / scratchpad 🟡 — *building now*
**Scenario:** Faye (coordinator) decides "Cleo owns the API, Wade owns the UI." Today the only way
to record that is to type it into each agent's terminal, and nothing keeps it — ten minutes later
Wade can't ask "who's doing the API?" A blackboard is a classic multi-agent shared surface:

```
loom note set plan.api "Cleo — in progress"
loom note set plan.ui  "Wade — done"
loom note get plan.api          # any pane reads it
loom note list                  # dump the whole board
```

It's **pull** (agents read when they need it) — calmer than 2a's push. Good for "who's doing what,"
the agreed plan, a discovered gotcha ("staging DB down, skip integration tests"). Cheap: a new bus
op plus a small reactive store (mirrors `stores/activity.ts`), and it's naturally UI-visible (a side
panel could render the board). **Scope:** the board is per-workspace (matches Loom's mental model);
a `--workspace` flag overrides, and the caller's workspace is the default. Global-but-namespaced is
a future extension.

### 2c. File-level claims / locking 🟡 ✅ shipped
**Scenario:** the scariest fleet failure — `loom broadcast "fix the failing tests"` to four panes,
two of them independently start editing `src/auth.ts`, and they stomp each other. A lightweight
cooperative lock prevents it:

```
loom claim src/auth.ts          # -> "claimed", or fails "held by Cleo" (exit 1)
loom release src/auth.ts        # holder-only; --force to clear a stale lock
loom claims                     # the whole allocation
```

It's **advisory** — agents opt in by calling `claim`; Loom doesn't intercept filesystem writes — but
for cooperating agents that's enough. The `claim` is an atomic test-and-set: it fails (exit 1) if
another pane holds the path, so `loom claim x || work_on_something_else` scripts cleanly.

**✅ Built as:** `stores/claims.ts` — a *sibling* of the blackboard (same per-workspace, ephemeral,
opacity-safe shape) rather than a literal `claim:` namespace inside it, so `note list` stays
notes-only and a user's note key can't collide with a lock. `claimFile` is the test-and-set,
`releaseFile` is holder-scoped (`--force` overrides); `claim`/`release`/`claims` ops in
`protocol.ts`/`paneControl.ts` (a `claimContext()` requires the caller pane as holder identity);
the `loom claim|release|claims` CLI in `cli.rs`; claims dropped on workspace close, and a pane's
claims **auto-release when it dies** — its process exits (`Terminal` `onExit`) or it's closed
(`closePane`) both call `releasePaneClaims` → `releaseClaimsBy`, so a crashed or finished agent
can't leave a lock blocking the fleet. Notes deliberately *don't* clear this way (shared plan state,
not owned). `--force` remains for clearing a lock a still-running pane forgot to release.

### 2a. Request/response with correlation 🟡 ✅ shipped
**Scenario:** Faye needs an answer from Cleo. Today `loom send` types the question in but Faye never
hears the reply. Make it a real RPC that **blocks until Cleo answers**:

```
answer=$(loom ask Cleo "which auth library are we using?")
# Cleo's agent responds: loom reply <id> "lucia-auth"   (id comes from the injected prompt)
```

**Correlation:** each `ask` mints an id, typed into the callee's pane inside the reply instructions;
the reply echoes it so concurrent questions match up. It turns a pane from "a thing you shout at"
into a **callable worker**.

**✅ Built as:** the relay caps each parked connection at ~10s (a fast-fail for a wedged frontend),
and Rust is a pure relay that can't special-case an `ask` — so rather than hold one socket open for
an agent-speed answer, `ask` is a **long-poll mailbox**: it returns a correlation id immediately,
then the `loom ask` CLI loops `ask.await` in <10s slices until the reply lands or the ask expires.
`lib/askRegistry.ts` is the correlation state (parked polls, reply-beats-poll stashing, expiry,
cancel); `ask`/`ask.await`/`reply` ops in `protocol.ts`/`paneControl.ts` (`ask` injects the prompt
+ reply recipe and returns the id; `reply` delivers); `run_ask()` in `cli.rs` is the poll loop.
`ask` exits non-zero on timeout so `answer=$(loom ask …) || handle_no_answer` scripts cleanly.
Verified end-to-end (happy-path RPC, `$(…)` capture, timeout, unknown-pane/expired-ask errors).
*Follow-up:* a `--timeout` is the only bound today; a UI list of open asks would help debugging.

> **Cross-cutting design tension — scope.** Per-workspace (simple, matches Loom's model) vs.
> global-but-namespaced (more powerful; real fleets span repos across workspaces — the very reason
> the human broadcast bar was removed). We start **per-workspace** and can widen later.

### 2d. MCP parity for the coordination tools ✅ shipped
All three primitives are now **model-native**, not just CLI: `loom mcp` exposes `board_set`/`get`/
`list`/`del` (§2b), `claim_file`/`release_file`/`list_claims` (§2c), and `ask_pane`/`reply_ask`
(§2a) as agent tools, alongside the existing pane tools. **✅ Built as:** the tool catalogue + a
pure, unit-tested `build_request(name, args, pane)` in `mcp.rs` (the caller pane is threaded in from
`$LOOM_PANE` for workspace scope / writer / holder identity); `ask_pane` runs the same long-poll
loop as the CLI and returns the answer as a structured tool result. Verified end-to-end over
JSON-RPC (tools/list, cross-pane board read, claim enforcement, blocking `ask_pane` → `reply_ask`).

### 2e. Fleet panel — make the coordination state visible ✅ shipped
The blackboard and file claims are cross-pane state a fleet builds up invisibly; you could only see
it by running `loom note list` / `loom claims` in a pane. **✅ Built as:** `FleetPanel.tsx`, a docked
right-side panel (Ctrl+Shift+K, the title-bar ◈ button, or the command palette) that shows the
active workspace's **Blackboard** (key → value + writer) and **File claims** (path → holder) with
live counts. Purely reactive off the `blackboard`/`claims` stores — a note or claim from any pane
updates it live, no polling — and re-scopes when you switch workspaces. Mirrors the Source Control /
Docs panel shell. *Follow-up:* open asks aren't shown yet (the ask registry isn't a reactive store).

## 3. Repeatability — capture a working setup and replay it

### 3a. Workspace templates with roles 🟡 ✅ shipped
Beyond grid presets: save a named fleet — "1 planner + 3 implementers + 1 reviewer" — each pane
pre-seeded with a launch command **and** an initial prompt. One click reconstitutes an agent team.
Extends the `Preset` snapshot (already carries `tree` + `panes`) with per-pane seed prompts.

**✅ Built as:** a `prompt?` field on `PaneSpec` (`protocol.ts`) — a seed typed into the pane once,
delivered by `createWorkspace` → `deliverSeedPrompts` (`stores/workspace.ts`) after a short boot
delay, via the same `writeToPanes` path the task board uses. Fired only on a genuine *creation*
(wizard / preset launch / duplicate), never on restart (which restores workspaces without calling
`createWorkspace`) or a `keepSession` resume — so an agent is briefed exactly once. **Roles come for
free:** they already live on `PaneSpec` (§2, ORCHESTRATION-IDEAS), so a preset that snapshots `panes`
carries each pane's role too. The New-workspace wizard gained a per-pane **seed** input alongside
cmd/cwd (`NewWorkspaceWizard.tsx`), so a fleet of "builder + reviewer + …", each briefed, launches in
one click. Verified end-to-end: a saved preset relaunched two panes with their `builder`/`reviewer`
badges and their seed prompts already run.

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
