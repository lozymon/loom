# Panes are opaque; Termhaus is not agent-aware

The reference app (BridgeSpace) parses agent output to show per-pane status and token counts, and the project began life (pre-pivot) coupled to the Claude Agent SDK. For v1 we deliberately reject both: a Pane is an opaque PTY byte stream that Termhaus streams but never interprets, and an "agent" is nothing more than a Pane whose launch command is a CLI like `claude`. We chose this to keep the make-or-break PTY-throughput core simple, keep Rust thin, and avoid re-importing the bundled-CLI packaging risk we escaped by dropping the SDK.

## Consequences

- No token counters, no "busy/needs-approval" badges, no output parsing in v1 — the screenshot's agent overlays are out of scope.
- Agent-awareness, if ever wanted, must be a **separate layer that tails pane output**, never logic baked into the core PTY/pane model.
- No Claude Agent SDK dependency; the data model has no Agent/Session entity.
