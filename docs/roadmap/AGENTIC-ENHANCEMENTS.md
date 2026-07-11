# Loom — agentic-dev-env enhancements

A backlog aimed at the thesis: *driving a fleet of CLI agents from one window.* Everything here
stays **ADR-0001-safe**: Loom never parses pane *output*. State comes in through the agent-pushed
`loom` control bus ([ADR-0007](../adr/0007-inter-pane-control-bus.md)) or through byte-*flow timing*
(when data moved, not what it said), never by scraping what scrolls by.

> All of this doc has **shipped** — the items now live in **[../FEATURES.md](../FEATURES.md)**
> (what · where · why). Build notes for shipped items are recoverable from git history.

---

## Shipped (→ [../FEATURES.md](../FEATURES.md))

- **1a.** Per-workspace "needs you" count pill.
- **1b.** Idle / stuck detection (byte-flow timing only — `lib/idle.ts`, `settings.idleStuckSeconds`).
- **1c.** Cost / token HUD (`lib/claudeUsage.ts`, on the Fleet panel).
- **2a.** Ask/reply RPC with correlation (long-poll mailbox). Open asks now list in the Fleet panel.
- **2b.** Shared blackboard / scratchpad (`loom note`).
- **2c.** File-level claims / locking (`loom claim`).
- **2d.** MCP parity for the coordination tools.
- **2e.** Fleet panel — coordination state made visible (blackboard, claims, input gates, open asks).
- **3a.** Workspace templates with roles + seed prompts (`prompt?` on `PaneSpec`).
- **3b.** Session replay / transcript export (⧉ Copy MD / ⭳ Export).
- **4b.** Git-aware guardrails — confirm gate on destructive `loom broadcast`.
- **4a.** Per-pane approval gating / dry-run — a standing per-pane input gate (`loom gate` /
  `gate_pane`): while a pane is gated, any bus-delivered input (`send`/`broadcast`) needs a human OK
  before it lands (honored per Settings → Safety). Plus `loom broadcast --dry-run` to preview which
  panes a fan-out would reach — flagging dead and gated ones — without sending. Gate state shows on
  the pane's title-bar chip (🔒) and in the Fleet panel's "Input gates" section.

---

## Design note kept for the record — coordination scope

The coordination primitives (blackboard, claims, ask/reply) are **per-workspace** by design (simple,
matches Loom's mental model). The alternative — global-but-namespaced — is more powerful, since real
fleets span repos across workspaces (the very reason the human broadcast bar was removed 2026-06-25).
We deliberately started per-workspace and can widen later; a `--workspace` flag already overrides the
default. This scope tension has no ADR — recorded here so a future widening knows what was chosen and
why.
