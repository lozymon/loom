# Agents are first-class; awareness via structured self-report, not output scraping

**Status:** Accepted (2026-06-28). **Supersedes [ADR-0001](0001-opaque-panes-no-agent-awareness.md).**

> **Partially superseded by [ADR-0011](0011-heuristic-output-observer.md) (2026-07-05).** ADR-0011 relaxes this ADR's blanket "any awareness derived from Pane output stays rejected" into a *labeled, opt-in, per-agent-kind, always-overridable* heuristic tier **below** the floor. The entity model, the pushed/kernel provenance for ground-truth facts, and the byte-opaque engine described here are all unchanged — a scraped fact is never ground truth and never overrides a pushed one.

ADR-0001 bundled two bans together: **(a)** the data model has no `Agent`/`Session` entity, and **(b)** Loom never parses a Pane's output byte stream. Reorienting Loom into an agent-first developer environment ([AGENT_FIRST_PLAN.md](../../AGENT_FIRST_PLAN.md)) needs (a) gone — a real fleet view, a session log, and approvals triage all need durable agent entities — while (b) is exactly right and we keep it. This ADR **reverses (a) and reaffirms (b)**, drawing the line by the *provenance* of a fact rather than by whether Loom models it.

## The dividing line: provenance, not modelling

"Opaque" never meant "Loom knows nothing." Loom already reads kernel state — `pty_cwd` reads `/proc/<pid>/cwd` (ADR-0001's own live-cwd amendment), and `pty_busy`/`pty_foreground` read the foreground process group. It meant "Loom never interprets a Pane's *output*." We make that precise:

> Loom may model and persist any fact an agent **pushes to it deliberately** (structured lifecycle signals via Claude Code hooks or the `loom mcp` server) or that the **kernel exposes** (process state, cwd). It must never model a fact **derived from parsing a Pane's output bytes.**

The PTY engine (`pty.rs`) stays byte-opaque; its coalescing/back-pressure path never grows a parser. Output-scraping for awareness — reference-app-style token counts, status inferred from ANSI redraws — stays rejected, exactly as ADR-0001 intended. What changes is only that we now *have* entities to attach the pushed and kernel facts to.

## The domain model

Three first-class entities. Product state ⇒ TypeScript (no-product-logic-in-Rust); Rust relays the signals and later persists them (ADR-0009). Terms are pinned in [CONTEXT.md](../../CONTEXT.md).

- **Agent** — a *kind* of CLI agent (Claude Code, Codex, Aider, a user-defined one): a registry entry with a stable `AgentId`, resolved from a Pane's launch command. Promotes today's static `lib/agents.ts` badge table into a persisted, configurable registry. The kind, not the run.
- **Session** — one *run* of an Agent in a Pane, over time (`SessionId`); the durable unit the fleet view and session log key off. A Pane hosts many Sessions in sequence — each launch, **including a `--resume`, is a new Session** — with at most one Live per Pane. `SessionId` borrows the agent's own session id when it provides one (Claude Code's `SessionStart` carries one), synthesised otherwise. The record outlives its Pane.
- **Task** — a unit of work an Agent reports within a Session. **Granularity is the agent's to set:** one per turn by default (`UserPromptSubmit`→`Stop`), finer when it declares them (MCP `begin_task`/`complete_task`). Title and touched files are **always agent-pushed, never inferred from output**.

**Approval** is deliberately *not* a fourth entity — it is the structured payload a Task carries while it is `blocked` on the user (the agent's prompt + its kind: permission / question / choice). It lives and dies with the Task's blocked state, so the hierarchy stays a clean three levels: `Agent → Session → Task`.

## Two fidelities for every awareness concept

Each concept has a coarse, opacity-safe **floor** that ships today and a **rich** form that arrives only when the agent reports it. This is what keeps the model honest across heterogeneous CLIs:

| Concept | Coarse floor (today) | Rich form (this ADR) |
| --- | --- | --- |
| an agent is present / running | OS foreground-process detection (`pty_busy`/`pty_foreground`) | `Session` (pushed lifecycle) |
| it needs you | the `attention` flag | `Approval` (prompt + kind) |
| what it's doing | the `status` label | `Task` (title, files, state) |

Rich for hook/MCP-capable agents (Claude Code today); coarse-but-correct for everything else. **Resolution is signalled, never scraped:** an Approval clears when the agent reports it is unblocked (or when the user answers via "reply to flagged," which writes the answer into the Pane); for a hook-only agent that never sends a resolve signal, the `attention` floor clears on the agent's next signal / the OS floor showing it running again.

## Signal sources (enriched, not a new pipe)

Facts arrive over the existing channels — the inter-pane control bus (ADR-0007), relayed verbatim by Rust exactly like today's `attention`/`status`, which remain the backward-compatible floor:

- **Agent hooks** (`loom hooks`) — `SessionStart`→session start, `PostToolUse`→task update with files, `Notification`→approval, `Stop`→task end, `SessionEnd`→session end.
- **MCP server** (`loom mcp`) — the model pushes richer state as deliberate tool calls.
- **OS floor** — the foreground-process-group read gives every agent, hookless or not, a Live/idle Session.

## Consequences

- **CONTEXT.md is rewritten:** the old "Agent: not a first-class concept… do not reintroduce an Agent entity" entry is replaced by `Agent`/`Session`/`Task`/`Approval` (+ `Attention`/`Status` as the named floor).
- **Additive and backward-compatible:** `attention`/`status` and `workspace.json` keep working; old presets without agent metadata still launch.
- **Persistence of the session/task/event log is a separate decision** — ADR-0009 (SQLite). Out of scope here.
- **Highest risk is heterogeneous signal** (Claude Code has a rich hook taxonomy; Codex/Gemini/Aider vary). Mitigation is the floor — every agent gets a Session from the OS; rich detail is best-effort per agent, and the docs say plainly which agents light up fully. We do **not** close the gap by scraping.
- **Still rejected:** any awareness derived from Pane output, a bundled Agent SDK, and product logic in Rust.
