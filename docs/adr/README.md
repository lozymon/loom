# Architecture decision records

Numbering restarts for v2. Where a v1 decision carries forward, the ADR says so and links the v1 file in `../loom/docs/adr/`.

| # | Decision | Status |
|---|---|---|
| [0001](0001-hub-and-thin-clients.md) | A hub per machine owns all sessions; clients are views | Accepted |
| [0002](0002-typescript-hub-rust-sidecars.md) | Hub in TypeScript on Node; Rust only for sidecars | Accepted |
| [0003](0003-event-log-source-of-truth.md) | Append-only SQLite event log is the source of truth | Accepted |
| [0004](0004-session-adapters-normalized-events.md) | Session adapters emit normalized events; the core never names a CLI | Accepted |
| [0005](0005-claude-via-agent-sdk-and-tui.md) | Claude runs through the Agent SDK, with its TUI in a PTY beside it | Accepted |
| [0006](0006-approval-pipeline-and-levels.md) | Approvals go rules, then Steward, then human; four permission levels | Accepted |
| [0007](0007-cockpit-is-a-session.md) | The Cockpit is an ordinary session with hub tools, not a swarm engine | Accepted |
| [0008](0008-transport-auth-remote.md) | WebSocket JSON frames, token auth, SSH and Tailscale before a relay | Accepted |
| [0009](0009-voice.md) | Voice is captured on the client; local engines first, cloud fallback | Accepted |
| [0010](0010-platforms.md) | Linux and native Windows are first-class; WSL supported; macOS parked | Accepted |
| [0011](0011-carried-forward-from-v1.md) | v1 decisions that still hold | Accepted |
| [0012](0012-configuration-layers.md) | Hub config plus per-project `.loom/`, project overrides hub | Accepted |
| [0013](0013-worktrees-and-boards.md) | Worktrees and boards belong to the main repository | Accepted |
| [0014](0014-relay-tls-passthrough.md) | The relay forwards TLS it cannot open | Accepted |
