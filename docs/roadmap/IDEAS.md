# Loom — improvement & feature ideas

> **Status: fully shipped.** Every idea below is built and now catalogued in
> **[../FEATURES.md](../FEATURES.md)** (what it is · where it lives · why). This file is kept for
> the one thing the catalogue can't hold — the **"Agent integration" design decision** at the
> bottom, which is un-ADR'd rationale. The per-item "✅ Built as" write-ups were retired once
> FEATURES.md covered them; recover them from git history if you need the build notes.

Everything here was **ADR-0001-safe**: Loom never parses pane *output*. Agent signals arrive over
the `loom` control bus ([ADR-0007](../adr/0007-inter-pane-control-bus.md)) — the agent flags
itself; we never infer state from what scrolls by.

---

## Shipped (→ [../FEATURES.md](../FEATURES.md))

**Tier 1 — fleet thesis:**
1. "Needs-input" triage loop — *(the human broadcast bar this rode on was removed 2026-06-25; fan-out is agent-driven only now)*
2. Saved broadcast groups — *(same removal)*
3. Agent-controlled status label (`loom status`)
4. Docs / README reader → mark & send to a Claude pane

**Tier 2 — workspace & layout polish:** 5. Presets capture the real layout · 6. Quick workspace
switch (Ctrl+Shift+1…9) · 7. Duplicate workspace · 8. Drag-to-reorder panes in overview.

**Tier 3 — observability & onboarding:** 9. Keybinding cheat-sheet overlay (`?`) · 10. Session-log
viewer · 11. Per-agent border tint.

**Bigger bets:** system tray + global hotkey · multi-window / tear-off panes · ~~right-side
browser/preview panel~~ (shipped then removed 2026-06-25 as scope creep).

---

## Agent integration — the north star *(kept: design rationale, no ADR)*

How should an AI CLI agent and Loom integrate more deeply? The seam already exists: the
ADR-0007 control bus. Each pane's child gets `LOOM_SOCK` / `LOOM_PANE` / `LOOM_BIN`
injected and the `loom` CLI on `PATH`; `loom` → unix socket → Rust pure relay → TS routing
(`paneControl.ts`). So "middleware" isn't a new architecture — it's **bridging an agent's native
extension points to that bus**. Three shapes, worst → best:

### A. PTY output-scraping proxy 🔴 — don't
Launch `loom-wrap claude` instead of `claude`; the wrapper owns the PTY, passes I/O through, and
*watches the stream* to translate "agent is waiting" → `loom attention`. Technically real middleware,
but it means parsing ANSI/TUI redraws — fragile, agent-version-specific, and it re-introduces
exactly the brittleness ADR-0001 (opaque panes) exists to avoid. Only if an agent has no hooks/MCP.

### B. Adapter via the agent's own hooks 🟢 — cheap, robust ✅ shipped (Claude Code)
Most capable CLIs fire lifecycle events without any output parsing (Claude Code, e.g., has a
"needs attention/permission" notification event and a "finished" stop event). Ship a tiny config
that points those at `loom`:
- needs-input event → `loom attention` (raises the amber border)
- finished event → `loom attention --clear` / `loom status "done"`

The agent *pushes* its own state through the channel you already built. Per-agent, ~10 lines of
config each. Shipped as `loom hooks` — see [../reference/agent-hooks.md](../reference/agent-hooks.md).

### C. A Loom MCP server 🟡 — the model-native one ✅ shipped
Expose the `ControlRequest` set as an **MCP server** the agent connects to. The agent gets
first-class *tools* — "spawn a pane", "broadcast to the reviewers group", "flag myself blocked" —
instead of shelling out to `loom`. The MCP tool handlers call the same relay the `loom` CLI does,
so the two become two front-ends to one bus. Shipped as `loom mcp` — see
[../reference/agent-mcp.md](../reference/agent-mcp.md).

### The decision: MCP-core, with a permanent sliver of hooks

**Ignoring effort, C (MCP) is the destination** — but the mature design is *MCP-core + a thin hook
layer that never goes away*. The reasoning:

- **Hooks signal; MCP acts.** Hooks are one-directional lifecycle pings. MCP is a bidirectional
  *action* surface. Orchestrating a fleet needs verbs, not just status — that's MCP.
- **MCP lives in the model's reasoning**, not bolted on outside it: the capabilities appear in the
  agent's tool list, so the model *plans with* Loom ("spawn a pane to run tests while I edit").
  Hooks are invisible to the model — external side-effects in a settings file.
- **MCP isn't gated by a vendor's hook taxonomy** and is cross-agent (one server serves every
  MCP-capable agent; hook formats are bespoke per CLI).
- **But MCP structurally can't see a *blocked* agent.** An agent waiting on stdin makes no tool
  calls — that state is the absence of activity, not an action. The "needs your input" / "finished"
  liminal moments live outside the tool-call loop. Hooks (notification/stop) capture exactly those,
  for free, no output parsing. So a minimal hook adapter stays forever to cover that gap.

Keep Rust a pure relay throughout (ADR-0007). *(This decision is a candidate to promote to a
dedicated ADR if it needs to be cited from code.)*
