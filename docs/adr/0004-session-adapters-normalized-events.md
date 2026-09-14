# Session adapters emit normalized events; the core never names a CLI

**Status:** Accepted (2026-09-12). Generalizes v1 ADR-0008 (agents first-class via self-report).

v2 must be 100 % Claude now and open to Codex, Gemini CLI, and others later. If the hub core branches on engine names, every new CLI is a core change.

## Decision

- A **session adapter** implements start, send, interrupt, stop, resume, set permission level, and an event stream.
- Adapters translate engine output into **`SessionEvent`** from `@loom/protocol`. Clients and the Cockpit only ever see these.
- Two adapters in v2.0:
  - `claude-sdk` — structured, via the Agent SDK (ADR-0005).
  - `pty` — any command in a real terminal, byte-opaque.
- **Semantic state** uses herdr's vocabulary: `starting`, `working`, `blocked` (with `approval`, `question`, or `input`), `idle`, `done`, `error`. Every state change carries its provenance: `pushed`, `kernel`, or `heuristic` (ADR-0011).
- Engine names appear only inside adapter modules and detection manifests. A lint rule or test enforces this for `hub/src/core`.

## Consequences

- A future `codex` adapter maps Codex's app-server protocol onto the same events; until then Codex runs under `pty`.
- Features that only one engine supports appear as optional capabilities on the adapter, never as `if (engine === "claude")` in the core.
