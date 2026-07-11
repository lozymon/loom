# Loom — orchestration & coordination ideas

A follow-on to [IDEAS.md](IDEAS.md) and [AGENTIC-ENHANCEMENTS.md](AGENTIC-ENHANCEMENTS.md), scoped to
the same question: *what sharpens the one thing Loom is uniquely for — an agent-first control room?*

The governing decision is **[ADR-0008](../adr/0008-agents-first-class-via-self-report.md)**: agents
are first-class (`Agent → Session → Task`, with `Approval` as a Task's blocked payload), and Loom
models only facts an agent **pushes** (hooks / `loom mcp`) or the **kernel** exposes (foreground
pgrp, cwd) — never facts scraped from a Pane's output.
**[ADR-0011](../adr/0011-heuristic-output-observer.md)** adds one labeled exception: an opt-in,
per-agent-kind *heuristic* tier below the floor, always marked a guess and always beaten by a
pushed/kernel fact. The engine stays byte-opaque under both.

> Status legend: 🟢 wiring existing primitives · 🟡 moderate · 🔴 larger bet · ⚠️ conflicts with a
> core decision (record, don't build).

---

## Shipped (→ [../FEATURES.md](../FEATURES.md))

- **1. Task board that dispatches into panes** — the operator "intent" layer: a card → `loom spawn`
  → live `Session`/`Task` state → done (`stores/board.ts`, `BoardPanel.tsx`, `loom card`).
- **2. Role as a resolvable bus target** — `role:<name>` target resolution + `loom role` / `set_role`
  MCP tool. *Follow-up: the Fleet-panel role roster/filter isn't built.*
- **3. Approval gate + bus-command audit view** — a `held` claim state + a Bus-activity timeline
  (`stores/audit.ts`, `FleetApprovals.tsx`). *(The primitives-first slice of AGENTIC §4a; the
  dedicated per-pane input gate shipped too — `stores/inputHolds.ts`, `loom gate`.)*
- **4. Durable, project-scoped blackboard** — the blackboard re-keyed to the project folder and
  persisted to `<dir>/.loom/notes.json`, so a new session inherits what earlier ones learned.

---

## Recorded as *not to build* / not a priority *(kept: decisions + rationale)*

### 5. Structured "command blocks" from pane output  🔴 ↩️ heuristic-tier candidate (ADR-0011)
Rendering a pane's scrollback as discrete command blocks (prompt / output / exit-code cards)
requires **reading pane output**. Under ADR-0001/0008 this was a flat "do not build."
**[ADR-0011](../adr/0011-heuristic-output-observer.md) reopens it** as a *labeled, opt-in,
per-agent-kind, always-overridable* heuristic-tier feature: a **TS observer of the bytes xterm
already has** (never a parser in `pty.rs`, never Rust) could synthesize blocks, subject to ADR-0011's
four rules — engine stays byte-opaque, pushed always beats scraped, and the result is visibly marked
a guess. No longer banned, **but not a priority**: it's a real design fork with genuine ANSI/prompt
fragility, so it sits behind the higher-value heuristic consumers (a status/"needs-you" floor and a
cost estimate for hookless agents). Loom's default answer to "where did that output go" stays real
scrollback + search.

### 6. Built-in code editor + embedded browser  ⚠️ out of scope
Folding a file editor and a web browser into the window turns an agent control room into an IDE and
dilutes the one thing Loom is for. Loom's deliberate shape is **real terminals + multi-window
tear-off** (`detach.ts`, `DetachedPane.tsx`, `pty_retarget`): run `$EDITOR` in a pane, pop a browser
into its own window. Bundling both balloons scope and surface area for no gain over the composition
we already have.
