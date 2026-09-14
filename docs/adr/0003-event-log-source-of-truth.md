# Append-only SQLite event log is the source of truth

**Status:** Accepted (2026-09-12). Extends v1 ADR-0009, which logged sessions and tasks as mutable rows.

A hub with many clients, reconnects, and an audit requirement on approvals needs one ordered record of what happened. T3 Code uses event sourcing for the same reasons.

## Decision

- Every normalized `SessionEvent` (ADR-0004) is appended to an `events` table with a hub-wide, strictly increasing `seq`, a timestamp, and a session id.
- **Current state is a projection** of the log: session summaries, pending approvals, cost totals. Projections are rebuilt on startup and updated in memory as events append.
- Clients subscribe with `since: seq` and receive a replay, then live events, over the same stream.
- **Terminal bytes are never logged.** They travel in `term` frames, outside the event stream, to clients that sent `terminal.attach`. The hub keeps the last 1 MB per terminal session in memory; attach returns that tail with its byte offset, and every frame carries its offset, so a reconnecting client has no gap and no duplicates. Only the exit code (`terminal.exit`) is logged. (Revised in M2; the original draft had a `terminal.output` event and a sidecar-side buffer.)
- Every `approval.resolved` records its resolver and detail, so the audit trail is the log itself.
- SQLite via Node's built-in `node:sqlite` at the hub's data directory, so release builds (ADR-0010) carry no native module. Verified on Node 24.16 without warnings, 2026-09-12. WAL journal mode.

- **Projection events set values rather than adjust them** (`cost.update` carries the session total, not a delta). Applying a suffix of the log twice in order therefore converges, which is what makes snapshot-then-subscribe safe. The shared reducer lives in `@loom/protocol` (`reduceSummary`, `applyEvent`) and is used by both hub and client.
- On startup the hub settles what the previous process left open: open approvals are resolved with resolver `hub`, and sessions that were running become `idle` and not live.

## Consequences

- The UI is a pure function of events; testing the hub means asserting on emitted events.
- Log growth needs a retention policy: text and tool previews are truncated, and old sessions can be compacted into their final summary.
- Schema changes to events need a migration or a protocol version bump (`PROTOCOL_VERSION`).

## Addendum (M12, 2026-09-13): the search index

History search uses an FTS5 table (`event_text`) in the same SQLite file, filled on append from the words of text-bearing events (messages, replies, tool names and key inputs, approval summaries, speech, errors; never tool output or thinking). It is a projection: when it is missing or `search_version` changes, the hub rebuilds it from the log at startup. Tokenizer `unicode61 remove_diacritics 2`, so Portuguese words match without accents.
