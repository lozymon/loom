# Loom — agentic-dev-env enhancements

A backlog aimed at the thesis: *driving a fleet of CLI agents from one window.* Everything here
stays **ADR-0001-safe**: Loom never parses pane *output*. State comes in through the agent-pushed
`loom` control bus ([ADR-0007](../adr/0007-inter-pane-control-bus.md)) or through byte-*flow timing*
(when data moved, not what it said), never by scraping what scrolls by.

> Most of this doc has **shipped** — those items now live in **[../FEATURES.md](../FEATURES.md)**
> (what · where · why). Only the still-open item (§4a) keeps its full write-up below. Build notes
> for shipped items are recoverable from git history.

---

## Shipped (→ [../FEATURES.md](../FEATURES.md))

- **1a.** Per-workspace "needs you" count pill.
- **1b.** Idle / stuck detection (byte-flow timing only — `lib/idle.ts`, `settings.idleStuckSeconds`).
- **1c.** Cost / token HUD (`lib/claudeUsage.ts`, on the Fleet panel).
- **2a.** Ask/reply RPC with correlation (long-poll mailbox). *Follow-up: no UI list of open asks yet.*
- **2b.** Shared blackboard / scratchpad (`loom note`).
- **2c.** File-level claims / locking (`loom claim`).
- **2d.** MCP parity for the coordination tools.
- **2e.** Fleet panel — coordination state made visible. *Follow-up: open asks not shown yet.*
- **3a.** Workspace templates with roles + seed prompts (`prompt?` on `PaneSpec`).
- **3b.** Session replay / transcript export (⧉ Copy MD / ⭳ Export).
- **4b.** Git-aware guardrails — confirm gate on destructive `loom broadcast`.

## Open

### 4a. Per-pane approval gating / dry-run 🟡
Pause a pane's input and require a human OK before a broadcast lands, so one bad `loom broadcast`
can't nuke every repo at once.

*Note:* ORCHESTRATION-IDEAS §3 shipped the primitives-first slice of this (a `held` claim state +
the bus-command audit timeline). A dedicated **per-pane** gate — hold a pane's stdin until an
operator approves — is the remaining, larger piece.

---

## Design note kept for the record — coordination scope

The coordination primitives (blackboard, claims, ask/reply) are **per-workspace** by design (simple,
matches Loom's mental model). The alternative — global-but-namespaced — is more powerful, since real
fleets span repos across workspaces (the very reason the human broadcast bar was removed 2026-06-25).
We deliberately started per-workspace and can widen later; a `--workspace` flag already overrides the
default. This scope tension has no ADR — recorded here so a future widening knows what was chosen and
why.
