# Loom — orchestration & coordination ideas

A focused follow-on to [IDEAS.md](IDEAS.md) and [AGENTIC-ENHANCEMENTS.md](AGENTIC-ENHANCEMENTS.md),
scoped to the same guiding question: *what sharpens the one thing Loom is uniquely for — an
agent-first control room, driving a fleet of CLI agents from one window?* These six came out of a
scan of the adjacent-product landscape; each is re-cast here to fit Loom's own architecture, and
this pass **reconciles them against the coordination arc and domain model that have since shipped**
(ADR-0008/0009/0011, AGENTIC-ENHANCEMENTS §2). Several ideas below shrank once their groundwork
landed — that's noted per item.

The governing decision is now **[ADR-0008](adr/0008-agents-first-class-via-self-report.md)**: agents
are first-class (`Agent → Session → Task`, with `Approval` as a Task's blocked payload), and Loom
models only facts an agent **pushes** (hooks / `loom mcp`) or the **kernel** exposes (foreground
pgrp, cwd) — never facts scraped from a Pane's output. **[ADR-0011](adr/0011-heuristic-output-observer.md)**
adds one labeled exception: an opt-in, per-agent-kind *heuristic* tier below the floor, always
marked as a guess and always beaten by a pushed/kernel fact. The engine stays byte-opaque under
both. Idea #5 (command blocks) lives in that heuristic tier; idea #6 is recorded as a thing not to
build.

> Status legend: 🟢 mostly wiring existing primitives · 🟡 moderate · 🔴 larger bet.
> Fit legend: ✅ fits the model · ⚠️ conflicts with a core decision — record, don't build.

---

## Tier 1 — build on primitives we already have

### 1. Task board that dispatches into panes  🟡 ✅ *(anchor — open)*
**The flow:** a Kanban-style side panel where each card is a unit of work. Moving a card to
"in progress" (or hitting **Dispatch**) spawns a pane from a `PaneSpec` + a launch prompt; the
card's live state is then driven *back* by that pane's `Session`/`Task` signals. The board is the
"intent" layer that today lives only in an operator's head.

**Why it's strong:** every primitive now exists — `loom spawn` mutates the layout tree in TS,
`Session`/`Task`/`Approval` are first-class (ADR-0008) with a live store (`stores/sessions.ts`) and
a durable SQLite backing (`sessionlog.rs`, ADR-0009), and the Fleet panel (`FleetPanel.tsx`) already
renders coordination state. A board simply *composes* them: card → spawn → live `Task` state →
done. It's the live, operator-driven cousin of AGENTIC-ENHANCEMENTS §3a ("workspace templates with
roles").

**Build notes:** new side panel mirroring `FleetPanel.tsx`/`GitPanel.tsx`. **Split the persistence
by provenance** (the ADR-0009 rule): the *card definitions* are intent → live next to
`workspaces.json`; the *history of what a dispatched card did* already lands in `sessions.db` via
the ADR-0008 pipe — the board reads it, doesn't re-store it. A card holds
`{ title, paneSpec, prompt }` and, once dispatched, a `sessionId`; status subscribes to
`stores/sessions.ts` (not raw `activity.ts` — that's the pre-ADR-0008 floor). No Rust changes beyond
what ADR-0009 already added — pure TS/SolidJS, per no-product-logic-in-Rust.

**Highest-leverage item in this doc.** It's a new panel, not an architecture change, and it's the
piece that turns Loom's now-rich agent signals into a single operable surface.

### 2. Role as a resolvable bus target  🟢 ✅ *shipped*
**The flow:** tag a pane/agent with a role — `builder`, `reviewer`, `scout`, `coordinator` — so a
driving agent can address "the reviewer" instead of remembering pane names.

**What already exists (don't rebuild):** the "shared mailbox" half of this idea is **shipped**. The
blackboard (`loom note`, §2b) is the shared surface, and `loom ask`/`loom reply` (§2a) is literally
a long-poll mailbox with correlation ids — both over the bus (ADR-0007), both with `loom mcp`
parity (§2d), both visible in the Fleet panel (§2e). So the *only* open delta is **role vocabulary**:
a role as another way to *resolve a target*, the same way `broadcastByPattern` already resolves a
name glob to panes.

**Build notes:** a role is most naturally an attribute on the ADR-0008 **Agent registry** entry (or
a per-pane override), surfaced as a `role:` selector in `ControlRequest` target resolution
(`paneControl.ts`) and a `--role` target on the `loom` CLI + `loom mcp`. Show it as a title-bar
badge and a Fleet-panel filter. Pairs with #1 (a card can target a role instead of spawning fresh)
and gives AGENTIC-ENHANCEMENTS §3a ("templates with roles") its runtime vocabulary.

**✅ Built as:** a persisted `role?` field on `PaneSpec` (`protocol.ts`) — the per-pane override, so
a "reviewer" pane stays the reviewer across restart (`setPaneRole` in `stores/workspace.ts`, written
via a `role.set` bus op mirroring `status`). Targeting is a `role:<name>` prefix on any `target`:
`resolveTargets` in `paneControl.ts` fans a `send` out to **every** pane holding the role (a role is
a group), `focus` reveals the first, and `resolvePanesByRole` is the reverse lookup. Faces: `loom
role [pane] <name>` / `loom send role:reviewer …` (`cli.rs`, with a role column in `loom list`) and
the `set_role` MCP tool (`mcp.rs`). Surfaced as an accent title-bar badge (`.pane-role`,
`Terminal.tsx`). Not yet built: the Fleet-panel role roster/filter (a small follow-up).

### 3. Approval gate + bus-command audit view  🟡 ✅ *(audit backend already shipped — gate is the delta)*
**The flow:** an operator can put a claim (or a card from #1) into a **held** state an agent must
not proceed past until released — a lightweight approval gate — and can see every cross-pane command
on an auditable timeline.

**What already exists (don't rebuild):** the durable audit backend is **shipped** — ADR-0009's
SQLite session/task log (`sessionlog.rs`) already records structured agent activity across sessions
with search, and `Approval` is first-class (ADR-0008) with a triage surface (`FleetApprovals.tsx`).
So the open deltas are narrow: **(a)** a *bus-command* timeline (the control relay in `control.rs`
already forwards every request through TS, so recording those is a subscribe-and-append — a sibling
tab in `SessionLogViewer.tsx`), and **(b)** the *hold/gate* action itself, which reuses the claim
mechanism (`stores/claims.ts`, §2c): add a `held` status alongside `claimed` plus a release action.
This is the concrete, primitives-first take on the planned AGENTIC-ENHANCEMENTS §4a ("per-pane
approval gating / dry-run"). Keep Rust a pure relay — gate/hold logic stays in TS.

---

## Tier 2 — plausible but larger / against the grain

### 4. Durable, project-scoped blackboard (cross-session memory)  🟡 ✅ *(defer — but cheaper than before)*
**The flow:** a context store panes read and write *across* sessions, so a new agent inherits what
earlier ones learned instead of starting cold.

**Why it shrank:** the in-session version already exists — the blackboard (`loom note`, §2b) is
exactly a shared read/write surface; it's just **ephemeral** (per-workspace, dropped on close,
opacity-safe by design). And ADR-0009 already put a durable SQLite store (`sessions.db`) in the
tree. So this is no longer "a new store" — it's *persisting/scoping the existing blackboard* to a
project, a much smaller step. **Still defer** until #1–#3 prove the orchestration surface gets used,
and keep it explicit and agent-addressed — never an implicit scrape of pane output (ADR-0008/0011:
scraped facts are labeled guesses, never durable ground truth).

---

## Recorded as *not to build* / not a priority

### 5. Structured "command blocks" from pane output  🔴 ↩️ heuristic-tier candidate (ADR-0011)
Rendering a pane's scrollback as discrete command blocks (prompt / output / exit-code cards)
requires **reading pane output**. Under ADR-0001/0008 this was a flat "do not build."
**[ADR-0011](adr/0011-heuristic-output-observer.md) reopens it** as a *labeled, opt-in,
per-agent-kind, always-overridable* heuristic-tier feature: a **TS observer of the bytes xterm
already has** (never a parser in `pty.rs`, never Rust) could synthesize blocks, subject to ADR-0011's
four rules — engine stays byte-opaque, pushed always beats scraped, and the result is visibly marked
a guess. No longer banned, **but not a priority**: it's a real design fork with genuine ANSI/prompt
fragility, so it sits behind the higher-value heuristic consumers (a status/"needs-you" floor and a
cost estimate for hookless agents — AGENTIC-ENHANCEMENTS §1b/§1c). Loom's default answer to "where
did that output go" stays real scrollback + search.

### 6. Built-in code editor + embedded browser  ⚠️ out of scope
Folding a file editor and a web browser into the window turns an agent control room into an IDE and
dilutes the one thing Loom is for. Loom's deliberate shape is **real terminals + multi-window
tear-off** (`detach.ts`, `DetachedPane.tsx`, `pty_retarget`): run `$EDITOR` in a pane, pop a browser
into its own window. Bundling both balloons scope and surface area for no gain over the composition
we already have.

---

## Suggested order

The groundwork these ideas assumed has largely landed, so the remaining work is smaller and clearer:

1. **#1 board** — the anchor; the only Tier-1 item that's still a substantial build, and the one that
   makes Loom read as an *orchestrator*.
2. **#2 roles** — now a thin target-resolution layer (the mailbox shipped); do it alongside §3a.
3. **#3 gate** — the audit backend shipped; only the `held` action + a bus-command timeline remain.

Then reassess **#4** (durable blackboard — deferred, but cheap now). **#5** is a low-priority
heuristic-tier candidate under ADR-0011; **#6** stays closed.
