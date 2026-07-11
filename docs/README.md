# Loom docs

Start with **[`FEATURES.md`](FEATURES.md)** — the catalogue of every shipped capability (what it is,
where it lives, why). Then, four groups by purpose:

- **[`adr/`](adr/)** — Architecture Decision Records. The **source of truth for the *why*.**
  Treat these (with [`../PLAN.md`](../PLAN.md)) as canonical; update them if the design changes.

- **[`reference/`](reference/)** — Living user/developer reference, kept current with the shipping app:
  - [`cli.md`](reference/cli.md) — the `loom` inter-pane control CLI (list/send/spawn/broadcast/…).
  - [`agent-mcp.md`](reference/agent-mcp.md) — the `loom mcp` MCP server (the model-native tool face).
  - [`agent-hooks.md`](reference/agent-hooks.md) — wire a Claude Code agent's lifecycle into Loom.
  - [`troubleshooting.md`](reference/troubleshooting.md) — file locations, rendering, control-bus, build fixes.

- **[`roadmap/`](roadmap/)** — Feature backlogs and forward plans. Items carry status markers
  (✅ shipped / 🟡 open); shipped items are kept because the source code cites them by section as
  design provenance.
  - [`IDEAS.md`](roadmap/IDEAS.md) — the post-v1 feature log (fully shipped; each item has a "✅ Built as" note).
  - [`AGENTIC-ENHANCEMENTS.md`](roadmap/AGENTIC-ENHANCEMENTS.md) — fleet-orchestration backlog (mostly shipped; §4a approval-gating open).
  - [`ORCHESTRATION-IDEAS.md`](roadmap/ORCHESTRATION-IDEAS.md) — coordination-primitives backlog (Tier 1 shipped).
  - [`CROSS_PLATFORM_PARITY.md`](roadmap/CROSS_PLATFORM_PARITY.md) — Linux/macOS/Windows parity plan (**live** — Phases 3 & 5 open).
  - [`PRE_WINDOWS_CHECKLIST.md`](roadmap/PRE_WINDOWS_CHECKLIST.md) — pre-Windows ground-clearing (done except D10).
  - [`ASSESSMENT.md`](roadmap/ASSESSMENT.md) — an honest keep/remove review of the app.

- **[`design/`](design/)** — Visual/brand material.
  - [`loom-brand/`](design/loom-brand/) — brandmark, icons, favicons.
  - [`design_handoff_loom_frameless/`](design/design_handoff_loom_frameless/) — the Frameless chrome design source.
  - [`frameless-redesign-plan.md`](design/frameless-redesign-plan.md) — implementation plan for that redesign (shipped at the code level; a human QA sweep remains).
