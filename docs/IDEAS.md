# Termhaus — improvement & feature ideas

A running, unprioritised-then-prioritised list of things we *could* build next. The core
(M0–M11) is done and solid: PTY engine, split-tree layout, workspace rail, single-page
launcher, broadcast, presets, copy/paste/search, themes, git panel, overview mode,
notifications, the inter-pane `th` control bus, region capture, and the command palette.

So this list is **not** about re-paving basics. The guiding question is: *what sharpens the one
thing Termhaus is uniquely for — driving a fleet of CLI agents from one window?*

Everything here is **ADR-0001-safe**: Termhaus never parses pane *output*. Agent-driven signals
come in through the `th` control bus (ADR-0007), which is an inbound, agent-pushed channel —
the agent flags itself; we never infer state from what scrolls by.

> Status legend: 🟢 mostly wiring existing primitives · 🟡 moderate · 🔴 larger bet.

---

## Tier 1 — lean into the fleet thesis (highest leverage)

> **Shipped:** #1, #2, and #3 are now built (the fleet-console increment). See the per-item
> ✅ notes below. The `th` CLI gained a `status` subcommand and `ControlRequest` gained a
> `status` op; the broadcast bar gained a **⚑ Reply to flagged** button and a saved-groups menu.

### 1. "Needs-input" triage loop  🟢 ✅ shipped
**The flow:** several agents pause on a `y/n` (or "continue?"). Each self-flags with
`th attention`, raising its amber border. You type the answer **once** and it goes only to the
flagged panes, then clears their flags.

**Why it's strong:** this is *the* fleet workflow, and both halves already exist —
- agents can raise/clear the flag: `ControlRequest { op: "attention" }` (`protocol.ts`,
  handled in `paneControl.ts`).
- broadcast can target a subset: `broadcast: PaneId[]` on the workspace + `broadcastTargets(ws)`
  (`stores/workspace.ts`), driven by `BroadcastBar.tsx`.

**What's missing:** a "flagged" target mode. Add a `broadcastTargetMode: "all" | "subset" | "flagged"`
(or a one-click **"⚑ Reply to flagged"** button on the broadcast bar) that resolves targets to the
panes currently raising attention, sends, then drops their flags.

**Build notes:** attention state lives in `stores/activity.ts` (`anyNeedsAttention`); the bar
already shows a live-reach badge — extend it to show "→ N flagged". Clearing on send means
calling the existing attention-clear path for each target after the write.

**✅ Built as:** `flaggedTargets(ws)` (`stores/workspace.ts`) resolves the flagged set from the
activity store; `BroadcastBar.tsx` shows a pulsing amber **⚑ Reply to flagged (N)** button that
appears only when panes are flagged, sends the typed text to exactly those panes (honouring the
stagger), then drops their flags via `clearAttention`. Ignores the picked subset by design.

### 2. Saved broadcast groups  🟢 ✅ shipped
**The flow:** name a set of panes ("claudes", "frontend", "reviewers") and flip the broadcast
scope to it in one click, instead of re-selecting panes every time.

**Why:** `setBroadcastByPattern` already matches panes by name glob, but the selection is
ephemeral. Persisting named groups makes recurring fan-outs a single click and pairs naturally
with agent badges (a group can just be "every Claude pane").

**Build notes:** persist `broadcastGroups: { name: string; pattern: string }[]` in `settings.ts`
(next to `broadcastSnippets`/`broadcastHistory`, which already follow this shape). UI: a small
dropdown on `BroadcastBar.tsx`. Resolution reuses `lib/matching.ts`.

**✅ Built as:** `broadcastGroups` in `settings.ts` with `addBroadcastGroup`/`removeBroadcastGroup`;
a `⚐ ▾` groups dropdown in `BroadcastBar.tsx` (mirrors the snippets menu) — save the current
Targets pattern under a name, then one click flips the bar into select-mode and applies the glob
through the existing `setBroadcastByPattern` → `matchesPattern` path.

### 3. Agent-controlled status label  🟡 ✅ shipped
**The flow:** an agent sets its own short status — `th status "running tests"` — shown in its
title bar and (more importantly) on its overview tile. Glance at overview → see who's building /
blocked / idle across the whole fleet.

**Why it's opacity-safe:** identical category to `attention` — the agent *pushes* the label; we
never read it from output. It turns overview mode into a real fleet dashboard.

**Build notes:** add `{ op: "status"; target: string; text?: string }` to `ControlRequest`
(`protocol.ts`), handle it in `paneControl.ts` (write into a per-pane `status` field on the store),
render it in `Terminal.tsx`'s title bar and on the overview tiles (`LayoutNode.tsx`). Extend the
`th` CLI (`src-tauri/src/bin/th.rs`). Clears on respawn.

**✅ Built as:** `status: string` on `PaneActivity` (`stores/activity.ts`, with `setStatus`/
`clearStatus`) — note it is *not* cleared by `seePane` (looking at a pane keeps its status), only
by the agent or a respawn. The `status` op is handled in `paneControl.ts`; a `.pane-statuslabel`
pill renders in `Terminal.tsx`'s title bar (and so in overview tiles for free, since overview just
repositions the full panes). `th status [pane] <text…> | --clear` added to the CLI:
`th status "running tests"` labels the calling pane; `th status Cleo --clear` clears another's.

### 4. Docs / README reader → mark & send to a Claude pane  🟡 ✅ shipped
**The flow:** open a markdown file (README, a spec, an ADR) in a side panel, read through it, mark
a passage, optionally add an instruction ("explain this", "implement this section"), and send the
selection into a Claude pane to discuss — exactly the gesture the Source Control panel already
gives you for diff lines.

**Why it fits:** feeding docs/specs into agents is core to driving them, and the whole interaction
already exists in `GitPanel.tsx` — only the *content source* changes (a markdown file instead of a
`git diff`). It also scales to the fleet: send a spec section to a **subset** of panes ("all of you
read this") via the same broadcast targeting, not just the focused pane.

**Reuse, almost verbatim:**
- selection → payload → PTY: `sendToTerminal()` in `GitPanel.tsx`, which calls
  `writeToPanes([focusedId], payload)` (`lib/paneRegistry.ts`) with an optional instruction line
  and an Enter-to-submit toggle. Swap the focused-pane target for `broadcastTargets(ws)` to fan a
  passage out to a group.
- the file/picker + live-cwd resolution: GitPanel already resolves the focused pane's live cwd
  (`paneCwd`) to know which folder to look in — a docs reader scans that folder for `*.md`
  (README first), or uses the native file dialog (`@tauri-apps/plugin-dialog`, already a dep).

**New bits:** a `DocsPanel.tsx` (mirror `GitPanel.tsx`), a rail/title-bar button + a keybinding
(register a `docs`/`open-readme` action in `lib/keybindings.ts`, dispatched like
`source-control`), and markdown rendering. Two rendering options:
- **plain text + drag-select** (cheapest, matches GitPanel's line-select gesture 1:1), or
- **rendered markdown** with selectable text (nicer to read; selection maps back to source lines —
  a bit more work). Could ship plain first, render later.

**Open question:** send the **raw markdown** of the selection (best for an agent to act on) vs. the
rendered text (nicer for humans). Lean raw — the agent wants the source.

**✅ Built as:** new Rust `docs.rs` (`list_docs` walks the focused pane's live cwd for markdown,
README-first, bounded depth/count; `read_doc` reads one file, capped at 2 MiB). `DocsPanel.tsx`
mirrors `GitPanel.tsx`: a file list + a plain-text reader with the same drag-select gesture and
selection tint; the selection is sent as **raw markdown** (`rel:lines` + a ```markdown fence` +
optional instruction) via bracketed paste. A **"to targets"** toggle fans the passage to
`broadcastTargets(ws)` instead of just the focused pane ("all of you read this"); **"Open file…"**
uses the native dialog for files outside the folder. Opened from the title bar's 📖 **Docs** button,
the command palette, or **Ctrl+Shift+R** (new `docs` keybinding action). Shipped the plain-text
renderer; rendered-markdown remains a later option.

---

## Tier 2 — workspace & layout polish

### 5. Presets capture the real layout  🟡
Today a `Preset` stores `cwd` + `paneCount` + `commands` (`stores/workspace.ts`) — **not** the
tree shape, gutter ratios, or per-pane cwd. So a relaunched preset rebuilds a *balanced* grid,
losing any hand-tuned splits. Make "Save as preset" snapshot the actual `LayoutNode` tree (and the
per-pane `cwd` we added to the launcher) so relaunch is faithful.

*(Known gap, noted when we added the launcher's per-pane cwd — that override currently can't round-trip through a preset.)*

### 6. Quick workspace switch (Ctrl+1…9)  🟢
You have prev/next (`switchWorkspaceRelative`, PageUp/PageDown). Add direct jumps to workspace N.
Register as keybinding actions (`lib/keybindings.ts`) so they show up in Settings and the global
fallback handler we just added.

### 7. Duplicate workspace  🟢
Clone the active workspace's tree + per-pane commands/cwd into a fresh workspace (fresh PaneIds,
fresh PTYs). One rail action; reuses `buildWorkspace`-style construction.

### 8. Drag-to-reorder panes in overview  🟡
`swapLeaves` already exists (`lib/layout.ts`) and powers programmatic swaps. Wire it to
drag-and-drop between tiles in overview mode (`overview-hit` overlay in `LayoutNode.tsx`).

---

## Tier 3 — observability & onboarding

### 9. Keybinding cheat-sheet overlay (`?`)  🟢
A visible shortcut map (read straight from `ACTIONS` in `lib/keybindings.ts`, so it stays in sync
and shows live rebinds). Complements the command palette and aids discovery — would have surfaced
the focus-vs-no-focus shortcut gap on its own.

### 10. Session-log viewer  🟡
`sessionLog.ts` already writes per-pane raw output to disk (opt-in, `settings.sessionLogging`).
Add a small in-app reader/tail to review what an agent did without re-running it. This is the
natural on-ramp to the deferred searchable-scrollback / SQLite idea (PLAN "Out of scope").

### 11. Per-agent border tint  🟢
Agent defs carry colors (`lib/agents.ts`). Tint each pane's focus ring / title bar by its detected
agent so a mixed fleet (Claude vs Codex vs Gemini) reads at a glance — and so overview tiles are
colour-coded by agent.

---

## Bigger bets (post-v1 — flagged out-of-scope in PLAN)

- **System tray + global hotkey** to summon/hide the window. 🔴
- **Multi-window / tear-off panes** — currently a pane lives in one workspace in one window. 🔴
- **Right-side browser / preview panel** — the dropped reference-app feature (localhost/docs
  preview); users currently alt-tab to a real browser. 🔴

---

## Agent integration — the north star

How should an AI CLI agent and Termhaus integrate more deeply? The seam already exists: the
ADR-0007 control bus. Each pane's child gets `TERMHAUS_SOCK` / `TERMHAUS_PANE` / `TERMHAUS_CLI`
injected and the `th` CLI on `PATH`; `th` → unix socket → Rust pure relay → TS routing
(`paneControl.ts`). So "middleware" isn't a new architecture — it's **bridging an agent's native
extension points to that bus**. Three shapes, worst → best:

### A. PTY output-scraping proxy 🔴 — don't
Launch `th-wrap claude` instead of `claude`; the wrapper owns the PTY, passes I/O through, and
*watches the stream* to translate "agent is waiting" → `th attention`. Technically real middleware,
but it means parsing ANSI/TUI redraws — fragile, agent-version-specific, and it re-introduces
exactly the brittleness ADR-0001 (opaque panes) exists to avoid. Only if an agent has no hooks/MCP.

### B. Adapter via the agent's own hooks 🟢 — cheap, robust
Most capable CLIs fire lifecycle events without any output parsing (Claude Code, e.g., has a
"needs attention/permission" notification event and a "finished" stop event). Ship a tiny config
that points those at `th`:
- needs-input event → `th attention` (raises the amber border)
- finished event → `th attention --clear` / `th status "done"`

The agent *pushes* its own state through the channel you already built. Per-agent, ~10 lines of
config each. This is the natural partner to #1 (needs-input broadcast) and #3 (agent status).

### C. A Termhaus MCP server 🟡 — the model-native one
Expose the `ControlRequest` set (`list/send/spawn/broadcast/read/focus/attention/status`) as an
**MCP server** the agent connects to. The agent gets first-class *tools* — "spawn a pane",
"broadcast to the reviewers group", "flag myself blocked" — instead of shelling out to `th`.
Mechanically a thin re-skin: the MCP tool handlers call the same relay the `th` CLI does, so the
`th` CLI and the MCP server become two front-ends to one bus.

### The decision: MCP-core, with a permanent sliver of hooks

**Ignoring effort, C (MCP) is the destination** — but the mature design is *MCP-core + a thin hook
layer that never goes away*. The reasoning:

- **Hooks signal; MCP acts.** Hooks are one-directional lifecycle pings. MCP is a bidirectional
  *action* surface. Orchestrating a fleet needs verbs, not just status — that's MCP.
- **MCP lives in the model's reasoning**, not bolted on outside it: the capabilities appear in the
  agent's tool list, so the model *plans with* Termhaus ("spawn a pane to run tests while I edit").
  Hooks are invisible to the model — external side-effects in a settings file.
- **MCP isn't gated by a vendor's hook taxonomy** and is cross-agent (one server serves every
  MCP-capable agent; hook formats are bespoke per CLI).
- **But MCP structurally can't see a *blocked* agent.** An agent waiting on stdin makes no tool
  calls — that state is the absence of activity, not an action. The "needs your input" / "finished"
  liminal moments live outside the tool-call loop. Hooks (notification/stop) capture exactly those,
  for free, no output parsing. So a minimal hook adapter stays forever to cover that gap.

**Sequencing toward it:** prove the *flows* (#1 needs-input broadcast, #3 agent status) over the
trivial hook adapter (B) first; then lift the whole capability set into the MCP server (C) once the
flows are validated — same handlers, richer face. Keep Rust a pure relay throughout (ADR-0007).

---

## Recommendation

Start with **#1 (needs-input broadcast)**: highest value per line, it's the workflow the whole app
is built around, and it's mostly connecting primitives that already shipped. **#2 (saved groups)**
and **#3 (agent status)** compound on it to make overview a genuine fleet console.

**#4 (docs reader → send to a pane)** is the strongest *standalone* next feature: it mirrors the
already-shipped Source Control send-to-terminal flow almost verbatim, so it's low-risk, and it
directly serves "drive an agent with context" — open a spec, mark a section, hand it to Claude.

Strategically, the **Agent integration north star** (above) is the bigger arc: ship the hook
adapter (B) to validate #1/#3, then grow it into the MCP server (C) as the deep, model-native
integration. The Tier-1 ideas are the concrete first steps along that path.
