# Loom → Agent-First Developer Environment — Plan

> **Status:** proposal / planning. This is the design doc for reorienting Loom from a
> *GUI terminal multiplexer that happens to run agents* into an **agent-first developer
> environment** built on real terminals. It does not change code yet — it decides what to
> change, add, and remove, and in what order.
>
> Source-of-truth docs it touches: [PLAN.md](PLAN.md) (milestones/why), the
> [ADRs](docs/adr/) (esp. [ADR-0001](docs/adr/0001-opaque-panes-no-agent-awareness.md)),
> [docs/IDEAS.md](docs/IDEAS.md), [docs/ASSESSMENT.md](docs/ASSESSMENT.md),
> [CLAUDE.md](CLAUDE.md), [README.md](README.md). Those get reframed in Phase 5.

## 1. The decision (what "agent-first" means here)

Four scoping decisions, made up front, that constrain everything below:

| Axis | Decision | Consequence |
| --- | --- | --- |
| **Opacity / awareness** | **Full agent-aware pivot.** Introduce real `Agent` / `Session` / `Task` entities; Loom understands agent lifecycles end-to-end. | Reverses ADR-0001's "no Agent/Session entity" (shipped as ADR-0008). Output-scraping later relaxed to a labeled, opt-in heuristic tier — ADR-0011. |
| **Surfaces** | **Terminal-centric + interactive git.** No built-in code editor, no separate task/plan/orchestration panels. | Awareness shows up *in the surfaces we already have* (title bars, overview/fleet board, badges) + a git panel promoted to stage/commit. |
| **Orchestration** | **Stay a host.** No built-in "brain." One agent-in-a-pane can still drive the fleet via the bus/MCP. | Loom *observes and represents* agents; it doesn't plan or dispatch work itself. |
| **Identity** | **Reorient the product.** Agent-first leads the defaults, onboarding, and docs. | The generic-multiplexer framing recedes (but the engine stays generic underneath). |

### 1.1 The load-bearing principle

> **Agents become first-class in the *data model and the product*, but the awareness data
> still arrives as structured, agent-*pushed* signals — never by parsing the PTY byte stream.**

This is the hinge of the whole plan. The "full pivot" you chose is about *modeling* agents
(durable `Session`/`Task` entities, a real lifecycle, persistence, a fleet view) — it is **not**
a mandate to scrape ANSI/TUI output. You explicitly rejected the "tail/parse output" option, and
that instinct is correct: output-scraping is exactly the fragility [ADR-0001](docs/adr/0001-opaque-panes-no-agent-awareness.md)
was written to avoid (agent-version-specific, brittle, re-imports the coupling we escaped).

So the engine stays **byte-opaque** (the coalescing/back-pressure PTY core in `pty.rs` never
parses a thing), and a **structured side-channel** — the inter-pane control bus
([ADR-0007](docs/adr/0007-inter-pane-control-bus.md)), extended — carries lifecycle facts. We
already have three push mechanisms shipping today; this plan *enriches* them rather than replacing
the model:

- **Agent hooks** (`loom hooks`, [docs/agent-hooks.md](docs/agent-hooks.md)) — Claude Code fires
  `SessionStart`/`SessionEnd`/`UserPromptSubmit`/`PreToolUse`/`PostToolUse`/`Notification`/`Stop`.
  Today we wire three of them to coarse `status`/`attention`. We wire the full set to real
  session/task events.
- **MCP server** (`loom mcp`, [docs/agent-mcp.md](docs/agent-mcp.md)) — the model *pushes* richer
  state as deliberate tool calls (`begin_task`, `request_approval`, …).
- **Coarse, opacity-safe OS signal** — `pty_busy`/`pty_foreground` already derive running/idle from
  the foreground process group (kernel state, not output). This is the **graceful-degradation
  floor**: an agent with *no* hooks still appears as a live session that's running or idle.

The result: rich for hook/MCP-capable agents (Claude Code today), coarse-but-correct for everything
else — and the byte engine never gets touched.

> **Amendment (2026-07-05, [ADR-0011](docs/adr/0011-heuristic-output-observer.md)).** The
> engine-opacity half of this principle is absolute and unchanged (`pty.rs` never parses). The
> *awareness-provenance* half is relaxed: **below** the OS floor sits an **opt-in, per-agent-kind
> heuristic tier** — a separate TS observer of the bytes the frontend already renders — for
> hookless agents (Aider, Gemini, Codex). It is always labeled a guess and always overridden by a
> pushed/kernel fact, so "pushed = truth" still holds; it just no longer means "output is never
> read for a lossy hint." The heuristic never becomes ground truth.

## 2. Where Loom is today (the starting point)

Loom is a *finished, shipping* product (v0.5.0): M0–M11 plus the whole IDEAS.md roadmap. The agent
integration arc already shipped (hooks → MCP), and the data model is deliberately agent-*absent*:

- **`src/ipc/protocol.ts`** — the entire domain is `PaneId`, `PaneSpec`, `LayoutNode`, `Workspace`,
  and the `ControlRequest` bus vocabulary (`list/send/spawn/read/broadcast/focus/attention/status`).
  **There is no `Agent`, `Session`, or `Task` type.**
- **`src/lib/agents.ts`** — "agent" is a *derived label*: `detectAgent(command)` regex-matches the
  launch string to a static `AgentDef` (badge colour/icon). Ephemeral, not persisted, not an entity.
- **`src/stores/activity.ts`** — agent *state* (`status`, attention) lives here as **ephemeral
  per-pane flags**, pushed over the bus, cleared on respawn. No history, no session concept.
- **Persistence** — `workspace.json` only (intent, not scrollback; SQLite deferred — PLAN.md flags
  session-log/search as its trigger condition).
- **`src-tauri/src/git.rs`** — **read-only** diff viewer (status + diff), scoped to the focused
  pane's live cwd. No stage/commit (deliberately deferred in M8).
- **ASSESSMENT.md** already names the two highest-value unbuilt features: **cross-pane session-log
  search** (the SQLite trigger) and an **agent-lifecycle timeline / fleet dashboard**. Both fall
  directly out of this pivot.

The good news: the *seams this pivot needs already exist*. We are extending the bus, promoting a
store, and adding persistence — not rebuilding the engine.

## 3. The new domain model

This is the heart of the change. Three new first-class entities, defined in `src/ipc/protocol.ts`
(product state ⇒ lives in TS per the no-product-logic-in-Rust rule; Rust only relays + persists).

```ts
// Identity of an agent definition (Claude Code, Codex, a user-defined one…). Promotes
// lib/agents.ts AgentDef from a static badge table into a persisted, configurable registry.
type AgentId = string;

// A run of an agent inside a pane, over time. Created on SessionStart (hook/MCP) or on first
// activity for a hook-less agent; closed on SessionEnd / child exit. THIS is what overview,
// the fleet board, and the session log key off — not the ephemeral pane flags.
interface Session {
  id: SessionId;
  paneId: PaneId;            // which pane it ran in (may outlive the pane)
  agentId: AgentId;          // resolved agent definition
  cwd: string;
  startedAt: number;
  endedAt?: number;
  state: "running" | "blocked" | "idle" | "done" | "failed";
  taskIds: TaskId[];
}

// A unit of work an agent reports doing within a session. Fed by UserPromptSubmit/Stop
// (coarse: one task per turn) or by explicit MCP `begin_task`/`complete_task` (rich).
interface Task {
  id: TaskId;
  sessionId: SessionId;
  title: string;            // agent-pushed; never inferred from output
  state: "running" | "blocked" | "done" | "failed";
  startedAt: number;
  endedAt?: number;
  files?: string[];         // paths the agent says it touched (→ interactive git review)
  approval?: Approval;      // present while blocked on the user
}

// A blocked-on-user moment, richer than today's binary amber flag.
interface Approval {
  prompt: string;           // "Run `rm -rf build`?" — pushed by the agent, not scraped
  kind: "permission" | "question" | "choice";
  resolvedAt?: number;
}
```

And the bus vocabulary (`ControlRequest` in `protocol.ts`) grows a **lifecycle event family**,
relayed verbatim by Rust exactly like today's ops:

```ts
// New ops — all agent-pushed, all opacity-safe (no output parsing):
| { op: "session.start"; agent: AgentId; cwd?: string }
| { op: "session.end"; outcome: "done" | "failed" }
| { op: "task.begin"; title: string }
| { op: "task.update"; files?: string[]; note?: string }
| { op: "task.end"; outcome: "done" | "failed" }
| { op: "approval.request"; prompt: string; kind: Approval["kind"] }
| { op: "approval.resolve" }
```

These map 1:1 onto Claude Code's hook taxonomy (`SessionStart`→`session.start`,
`PreToolUse`/`PostToolUse`→`task.update` with `files`, `Notification`→`approval.request`,
`Stop`→`task.end`, `SessionEnd`→`session.end`) **and** onto deliberate MCP tool calls — so the same
events feed from either mechanism. `attention`/`status` stay as the coarse, backward-compatible
floor.

## 4. Work breakdown — change / add / remove

### 4.1 Add

- **Domain types + bus ops** in `src/ipc/protocol.ts` (§3). The single highest-leverage change;
  everything else hangs off it.
- **`src/stores/sessions.ts`** — the new entity store (Agents/Sessions/Tasks/Approvals), fed by
  `lib/paneControl.ts` handling the new bus ops. Supersedes the *ephemeral-only* role of
  `stores/activity.ts` (activity.ts can remain for the coarse busy/idle floor, or fold in).
- **SQLite persistence** (new Rust dep, e.g. `rusqlite`) for the **session/task/event log** — the
  durable history a "what did my 12 agents do in the last hour" view needs. This is the long-flagged
  SQLite trigger condition finally arriving (PLAN.md "Out of scope" → now in scope). Raw scrollback
  stays out of SQLite (or opt-in + tail-bounded) so flood throughput is unaffected.
- **Cross-session log search** — the #1 feature ASSESSMENT wanted, now trivial on the event store.
- **Fleet board** — promote overview mode (`LayoutNode.tsx` tiles) into a real dashboard backed by
  `Session`/`Task`: who's running what, who's blocked longest, files touched, idle time. Replaces
  the per-pane ephemeral dots with durable entities.
- **Approvals triage** — the needs-input loop ([IDEAS.md #1](docs/IDEAS.md)) upgraded from a binary
  amber border to real `Approval` objects (shows the actual prompt, kind, lets you answer the
  right pane). The fan-out path (`loom broadcast`) stays.
- **Lifecycle CLI/MCP surface** — extend `cli.rs`/`mcp.rs`: `loom task begin/end`, `loom approve`,
  richer MCP tools. Same relay, two faces (unchanged pattern).
- **Richer hook profile** — `loom hooks` emits the full `SessionStart`/`PreToolUse`/`PostToolUse`/
  `SessionEnd` wiring, not just the three coarse hooks.

### 4.2 Change

- **`src/lib/agents.ts`** — from detection-only to a **persisted, user-extensible agent registry**
  (custom agents, per-agent default command/env/hook profile). `detectAgent` stays as the
  launch-string resolver.
- **`src-tauri/src/git.rs`** — promote read-only → **interactive**: add `git_stage` / `git_unstage`
  / `git_commit` (still thin shell-out; parsing/UX stays in TS `gitClient.ts`/`GitPanel.tsx`). Tie
  the panel to sessions: "Faye's session touched these files → review → stage → commit." Commits are
  **user-confirmed** actions (we stay a host — Loom never auto-commits).
- **`src/components/GitPanel.tsx`** — review → stage → commit workflow; entry point from a session's
  `files`.
- **Onboarding / wizard** (`NewWorkspaceWizard.tsx`) — lead with agents: the "Agents" step becomes
  primary; presets become *agent fleets*; default new-workspace flow is "pick a folder → pick a
  fleet."
- **`src/stores/workspace.ts`** persistence — sessions are time-series; route them to SQLite, keep
  layout/intent in JSON.

### 4.3 Remove / retire

- Nothing structural is deleted. The **ephemeral-only** treatment of agent state in `activity.ts` is
  *superseded* by the durable session store, not ripped out (keep the coarse busy/idle floor).
- The "generic multiplexer, agents are incidental" *framing* in README/CLAUDE.md/PLAN.md recedes
  (Phase 5) — but the generic engine underneath is untouched and still the foundation.

### 4.4 Explicitly NOT doing (scope fences)

- **No built-in code editor.** Terminal-centric stays. (`vim`/`hx`/`$EDITOR` run in a pane.)
- **No built-in orchestrator/brain.** Loom represents agents; it doesn't plan or dispatch.
- **No output scraping.** The engine never parses the byte stream (§1.1).
- **No regression of the PTY core** — `pty.rs` coalescing/back-pressure is sacred (ADR-0003/0006).

## 5. ADRs to write (Phase 0 gate)

The pivot is mostly a *documented-decision* change before it's a code change. Three ADRs:

1. **ADR-0008 — Agents are first-class; awareness via structured self-report, not output scraping.**
   *Supersedes ADR-0001.* States §1.1 precisely: new `Agent`/`Session`/`Task` entities, fed by
   pushed lifecycle events; the PTY engine stays byte-opaque; output parsing remains rejected. This
   is the keystone ADR — it preserves what ADR-0001 got *right* (a brittle-scraping ban) while
   reversing what it got *conservative* (no entities).
2. **ADR-0009 — SQLite for the session/task/event log.** Supersedes the "JSON only until a logging
   need appears" stance (PLAN.md). Defines what goes to SQLite (structured events, optional bounded
   scrollback) vs. JSON (layout intent), and why floods stay unaffected.
3. **ADR-0010 — Interactive git (stage/commit), still user-confirmed.** Supersedes M8's read-only
   decision and the ADR-0001 live-cwd amendment's "read-only" note. Commits remain explicit user
   actions tied to agent sessions; Loom is a host, not an autocommitter.

Use the **domain-modeling** and **grill-with-docs** skills here — they exist to pin terminology
(`Agent`/`Session`/`Task`/`Approval`) into CONTEXT.md and stress-test this plan against the existing
documented decisions before any code lands.

## 6. Sequencing (each phase ships value and de-risks the next)

| Phase | Goal | De-risks |
| --- | --- | --- |
| **0 — Decide** | Write ADR-0008/0009/0010; lock the domain model (§3) via domain-modeling/grill-with-docs. | Terminology drift; reversing ADR-0001 by accident vs. on purpose. |
| **1 — Model + ingest** | Add the types + bus ops (§3); `stores/sessions.ts`; extend `loom hooks` to the full taxonomy. Sessions/Tasks appear in-memory, no new UI yet. | **The biggest risk:** can we get rich-enough signal *without* scraping, across heterogeneous CLIs? Prove it on Claude Code; confirm the coarse floor covers the rest. |
| **2 — Persist + search** | SQLite event log (ADR-0009); cross-session log search. | SQLite write volume; flood safety. |
| **3 — Fleet board + approvals** | Real dashboard + approvals triage over durable entities. | UX of the agent-first surface. |
| **4 — Interactive git** | Stage/commit tied to session `files` (ADR-0010). | Git write-path safety; host-not-autocommitter boundary. |
| **5 — Reorient** | Onboarding leads with agents; reframe README/CLAUDE.md/PLAN.md; agent registry. | Product identity; not breaking existing users (engine unchanged). |

**Recommendation:** Phase 1 is the make-or-break — it's the agent-awareness equivalent of M0. Build
the ingestion + session store against Claude Code first and *validate the signal is real and
non-brittle* before investing in persistence and UI. If the structured signal proves too thin for
non-Claude agents, the coarse OS floor (§1.1) is the fallback, and we scope "rich awareness" to
hook/MCP-capable agents explicitly rather than scraping to fill the gap.

## 7. Risks & open questions

- **[HIGHEST] Heterogeneous agent signal.** Claude Code has a rich hook taxonomy; Codex/Gemini/Aider
  vary. Rich awareness may be Claude-first. *Mitigation:* graceful degradation — every agent gets a
  `Session` from the coarse OS floor; rich `Task`/`Approval` detail is best-effort per agent. Be
  honest in docs about which agents light up fully.
- **SQLite under floods.** Don't route raw PTY bytes through SQLite on the hot path. Structured
  events are low-volume; scrollback persistence (if any) stays bounded/opt-in. Don't regress `pty.rs`.
- **Scope creep toward an IDE.** The "interactive git" greenlight is a *specific* door, not a general
  one. Hold the editor/orchestrator fences (§4.4) hard.
- **Reversing ADR-0001 cleanly.** The new ADR must keep the byte-opacity ban intact while adding
  entities — easy to blur. The §1.1 distinction (model agents / push signals / never scrape) is the
  line.
- **Backward compatibility.** Existing `attention`/`status` ops and `workspace.json` keep working;
  the new model is additive. Old presets without agent metadata still launch.

**Open questions for the next session:**
1. Should `Session` survive a pane respawn (continuity across restarts), or is it pane-lifetime only?
2. Where does the fleet board live — promote the existing overview (`Ctrl+Shift+O`), or a new rail
   surface? (Leaning: promote overview, it's already the "glance at the fleet" gesture.)
3. Custom/user-defined agents in the registry now, or after the core model proves out?
4. Interactive git: per-hunk staging (matches the existing diff-region gesture) or file-level first?
