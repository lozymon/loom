# SQLite for the session/task log

**Status:** Accepted (2026-06-29). Supersedes PLAN.md's "JSON only until a logging need appears" stance (line 97) for *agent history*; workspace/layout persistence stays JSON.

[ADR-0008](0008-agents-first-class-via-self-report.md) made agents first-class (`Agent`/`Session`/`Task`), fed by pushed lifecycle signals into an **in-memory** TS store ([stores/sessions.ts](../../src/stores/sessions.ts)). That store dies on restart and can't answer *"what did my 12 agents do in the last hour?"* or be searched across sessions — the cross-session search ASSESSMENT flagged as the #1 want. PLAN deferred SQLite until a logging need appeared; it has.

## Decision

**A SQLite database (`sessions.db`, via `rusqlite` with bundled SQLite — no system lib dependency) holds the durable Session/Task history. Everything else is unchanged.**

- **What goes in:** structured `sessions` and `tasks` rows (the ADR-0008 entities) — agent kind, cwd, timestamps, state, task titles, touched files, the last approval prompt/kind. **Low-volume:** one small upsert per lifecycle op (a turn or a tool-use), never per PTY byte.
- **What stays out:** raw scrollback / PTY output (the flood path). Keeping it out is what keeps SQLite off the hot path and the throughput core (ADR-0003/0006) untouched. The opt-in file-based session logging (`logs.rs`) is separate and unchanged. Layout intent stays in `workspaces.json` (human-inspectable; PLAN persistence model).
- **Write path — TS drives, Rust stores** (the `workspaces.json` pattern, per no-product-logic-in-Rust): as the TS sessions store applies each lifecycle op, it calls a Rust command to upsert the affected Session/Task row. Rust runs the SQL; it never parses the bus protocol or decides what a row *means*. Search / recent-history queries are Rust commands returning rows to TS.
- **Location:** `app_data_dir()/sessions.db` (data, not config — it's a database, not hand-edited settings).

## Why SQLite now (not a bigger JSON blob)

- **Durability + query:** history must survive restart and support "last hour" filtering and cross-session **search** — a growing JSON blob gives neither cheaply.
- **Bounded:** rows are prunable by age/count; a JSON snapshot of all history grows unbounded and is re-serialized whole on every change.
- **Still flood-safe:** only structured lifecycle events hit SQLite (low volume); the byte stream never does.

## Consequences

- New Rust dep **`rusqlite` (feature `bundled`)** → self-contained, adds no packaging dependency.
- New Rust module (`sessionlog.rs`) + commands; the TS sessions store gains a persistence side-effect (mirrors `startPersistence` for workspaces). The in-memory store stays the source of truth for the live UI; SQLite is the durable mirror and the search/history backend.
- On startup, recent history *can* be hydrated from the DB for the fleet/search views without respawning anything — restoring history, not live processes (ADR-0002 still holds: quitting kills PTYs).
- **Scrollback search** (searching terminal *output*) stays out of scope — this logs the agent's *structured* activity, not its bytes. If output search is ever wanted, it's a separate decision (likely an opt-in, bounded FTS over the file logs).
- Pruning policy (age / row cap) is configurable; the default keeps a bounded window.
