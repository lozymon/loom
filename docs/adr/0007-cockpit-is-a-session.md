# The Cockpit is an ordinary session with hub tools, not a swarm engine

**Status:** Accepted (2026-09-12).

BridgeMind ships a swarm with coordinators and roles; herdr's community builds "head agents" on its CLI. Both show the demand. A dedicated orchestration engine would be a second product inside the first.

## Decision

- The **Cockpit** is a `claude-sdk` session flagged `cockpit: true`, pinned at the top of the rail, at most one per hub.
- It gets an MCP server exposing hub commands as tools: list, read, wait until state, spawn (with optional worktree and level), send, interrupt, stop, pending approvals, answer approval or question, set level (under ADR-0006 limits), board and notes, speak, notify, and the same against a named remote hub.
- The tools are thin wrappers over `Command` in `@loom/protocol`. The `loom` CLI wraps the same commands. Every capability exists once.
- **Roles** are session specs with a system-prompt suffix. **Missions** are prompts to the Cockpit. Coordination uses `wait_until` and report files, not process state.
- Every session also has the `loom` CLI on its PATH, so siblings can coordinate without the Cockpit.

## As built (M6, 2026-09-12)

- **Authority is a token, not a place.** Humans use the hub token. Each engine launch gets a session token naming its session and role (`session` or `cockpit`), issued at start and revoked when the engine stops. One capability table (`hub/src/control/capabilities.ts`) says which commands each role may send; handlers add the checks that need hub state.
- **Sessions** may look around (list, read, wait, stats, boards), message other sessions, share notes, claim files, and add cards. **The Cockpit** may also start, stop, interrupt, restart, rename, and archive sessions (never itself, never removing worktrees), set levels (never `full`), work the board, and decide other sessions' approvals and questions only where `stewardModel` is on, never ask-rule matches or its own. **Neither** may touch policy, trust, overrides, terminal input, or event streams.
- **One tool definition** (`hub/src/loom/tools.ts`) is exposed three ways: in-process MCP for chat sessions (Agent SDK), a stdio MCP server for Claude terminals, and the `loom` CLI on PATH for any terminal. All three go through the same router and capability checks.
- **Loom tools skip permission prompts** (`mcp__loom__*` allowed) and are always loaded, never deferred behind tool search.
- **Messages between sessions are labeled** in the text the receiver sees: from another session ("not from the developer") or from the Cockpit ("acts for the developer").
- **Notes and claims** are in memory per project; a session's claims are released when its engine stops.

### Found during verification

- **One bad tool schema hides every tool.** `z.record` in one tool made MCP tool listing fail, so Claude saw a connected `loom` server with no tools. A test now lists every tool for both roles through a real MCP client.
- **Loom v1 hooks in the user's Claude settings** call `loom hook …`. Inside v2 sessions that reaches v2's `loom`, which used to exit 2 and so blocked every prompt. v2's CLI now treats `hook` as a no-op and never exits 2.
- **A v1 `loom-commands` skill** in the user's Claude config led the Cockpit to search for a CLI with Bash. The Cockpit's instructions now say to use the loom tools and ignore v1 material.

## Consequences

- No new subsystem to test; Cockpit behavior is prompt plus tools.
- Cockpit actions appear in the log with `from: "cockpit"`, so they are auditable and distinguishable from yours.
