# Heuristic output-observer: a labeled, lossy awareness tier below the floor

**Status:** Accepted (2026-07-05). **Partially supersedes [ADR-0008](0008-agents-first-class-via-self-report.md)** — it relaxes 0008's blanket "any awareness derived from Pane output stays rejected" into a *labeled, opt-in, always-overridable* tier. It does **not** touch 0008's entity model, its pushed/kernel provenance for ground-truth facts, or the byte-opaque engine.

## Context

ADR-0008 gave every agent two fidelities: a coarse **floor** (OS-derived — is a foreground process running) and a **rich** form (agent-*pushed* via hooks/MCP). That works beautifully for Claude Code, which has a rich hook taxonomy. It leaves a gap for the heterogeneous fleet Loom exists to drive: Codex, Aider, Gemini, Copilot CLI and friends push little or nothing, so today they get only the "a foreground process exists" floor — Loom can't tell *working* from *blocked-on-you* for any of them.

ADR-0001/0008 closed that gap by fiat: never read output. That ban was inherited from the reference app, whose ANSI-scraping-for-tokens approach we deliberately rejected — and it protects something real. But it conflates two things (0008 already named the split): **engine purity** (no parser in the PTY hot path) and **awareness provenance** (only ever model pushed/kernel facts). The first is non-negotiable; the second is what this ADR revisits.

## Decision

Add a **third fidelity tier below 0008's floor: a *heuristic* signal**, derived from a Pane's output by a **separate, opt-in observer**, and **always labeled as such**.

The tier is bounded by four rules:

1. **The engine stays byte-opaque.** `pty.rs` — the reader/coalescing/back-pressure path proven in M0 — never grows a parser. It ships bytes; it does not read them. This rule is untouched and remains **absolute**. It is the real thing "opacity" protects.
2. **The observer is a TypeScript consumer of bytes the frontend already has.** xterm already receives every pane's output in order to render it; a heuristic observer is just another TS reader of that same stream (or of xterm's own buffer). No new pipe, no Rust parsing — consistent with no-product-logic-in-Rust. Product logic, including this, stays in TS.
3. **Pushed always beats scraped.** A heuristic signal may only *raise a floor where nothing better exists*. The instant the agent pushes a real signal (bus/hook/MCP) or the kernel contradicts it, the pushed/kernel fact wins. A scraped fact never overrides a pushed one, never persists as ground truth, and is dropped the moment a truthier source speaks.
4. **It is labeled heuristic in the model and the UI.** A heuristic attention/status is structurally and visually distinct from a pushed one (e.g. a hollow/dashed border vs. the solid pushed border), so the operator always knows they are looking at a guess, not a report.

**Opt-in is per-agent-kind, via the Agent registry ([ADR-0008](0008-agents-first-class-via-self-report.md)).** The observer is **off by default**. An `Agent` kind's registry entry carries whether heuristics are enabled for it — on for hookless kinds where the floor is thin (Aider, Gemini, Codex), off for kinds that self-report richly (Claude Code). This targets the tier exactly where it adds value and never runs it against an agent already pushing ground truth.

**Scope of this ADR: authorize the tier, do not commit a build.** This records the boundary and the new provenance rung; it does not schedule a consumer. Specific consumers — a heuristic status/"needs-you" floor for hookless agents, a cost/token estimate (AGENTIC-ENHANCEMENTS §1c), structured command blocks (ORCHESTRATION-IDEAS #5) — are built when prioritized, each subject to the four rules. The ADR is a decision, not a plan.

## The provenance ladder (now three rungs)

| Rung | Source | Authority | Example |
| --- | --- | --- | --- |
| **Rich** | agent-pushed (hooks/MCP) | ground truth | `Approval` with prompt + kind |
| **Floor** | kernel (foreground pgrp, cwd) | ground truth (coarse) | "a command is running" |
| **Heuristic** *(new)* | TS observer of output bytes | lossy guess, overridable | "looks blocked — a prompt-shaped line, no output for N s" |

Byte-*flow timing* (idle/stuck detection by *when* bytes move, not *what* they say — AGENTIC-ENHANCEMENTS §1b) was already opacity-safe and is **not** part of this tier; it reads no output content. This ADR is specifically about reading output *content*.

## Consequences

- **Reopens what 0008/0001 closed by fiat.** Heterogeneous agents can get a status/attention floor; a cost/token estimate becomes possible without a usage-reporting convention; and **structured command blocks** (ORCHESTRATION-IDEAS #5, previously "do not build") are no longer categorically banned — they become a heuristic-tier candidate, subject to the four rules.
- **Provenance stays legible.** Because every scraped fact is labeled and overridable, the "pushed = truth, scraped = guess" distinction that makes the model trustworthy is preserved. We widened the model without muddying it.
- **No engine risk.** Nothing here touches `pty.rs` or the transport; the observer works on bytes already delivered to the webview.
- **Cost is fragility, owned honestly.** ANSI/prompt scraping is brittle across CLIs and versions. That brittleness is *why* it is a labeled, lowest-authority, opt-in tier and not the floor — a broken heuristic degrades to "no heuristic signal," never to a wrong ground-truth claim.
- **Still rejected:** a parser in the PTY hot path; any Rust output parsing; treating a scraped fact as ground truth; a bundled Agent SDK. ADR-0008's entity model and its pushed/kernel provenance are unchanged.
- **Docs reconciled:** [`CONTEXT.md`](../../CONTEXT.md) (Pane opacity clause), [`AGENT_FIRST_PLAN.md`](../../AGENT_FIRST_PLAN.md) (§1.1 load-bearing principle + the opacity row), and [ORCHESTRATION-IDEAS.md](../roadmap/ORCHESTRATION-IDEAS.md) #5 point here.
