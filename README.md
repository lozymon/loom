# Loom v2

A hub and thin clients for running many AI coding sessions at once. Claude first, other CLIs through adapters.

**Status:** M12 (first slice). A hub runs many Claude chat sessions, Claude TUIs, and terminals, with rules and a Steward for approvals, project boards, and a Cockpit session that runs the others through `loom` tools. One client can show several hubs, reached over an SSH tunnel or Tailscale. Push-to-talk and read-back work in English and Portuguese. A desktop app bundles the hub (`npm run desktop:build`), and phones install the client as a PWA with push notifications for approvals. A relay on a VPS reaches hubs that can only dial out. History search, per-session change review with reverts, and screen manifests for CLIs without hooks. See [docs/dev.md](docs/dev.md) to develop and [docs/trying-loom.md](docs/trying-loom.md) to try it for real.

- [PLAN.md](PLAN.md) — scope, architecture, milestones, decisions
- [docs/adr/](docs/adr/) — architecture decisions
- [CONTEXT.md](CONTEXT.md) — vocabulary
- [docs/milestones/M1.md](docs/milestones/M1.md) — the next milestone's task list
- [tools/sdk-smoke/](tools/sdk-smoke/) — check that the Claude Agent SDK works on a machine
