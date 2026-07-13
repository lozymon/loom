# Plan 01 — Move / reorder panes across and within workspaces

**Status:** ✅ shipped v1.11.0 (2026-07-13, #52) · **Effort:** ~1 day · **Rust:** none · **ADR:** not needed
**Decisions locked:** expose via **all three** surfaces — drag-and-drop, title-bar menu, and command palette.

## Goal

Let a pane leave its current workspace for another (existing or new) without killing its
process, and let two panes swap / reposition within a workspace ("move a panel between 2 panels").

## Why it's (mostly) cheap — and the one place it isn't

Rust owns PTYs in **one global `HashMap<u32, Pane>` keyed by the PaneId** (`u32`), not
per-workspace (`src-tauri/src/pty.rs:71`). Moving a pane therefore moves **no process** — the
PTY keeps running, and every operation here is a **pure frontend state edit** in
`src/stores/workspace.ts`. No `pty_*` command, no Rust change.

**But a cross-workspace move is not visually free.** `App.tsx:285` renders **every** workspace
(`<For each={appState.workspaces}>`), each in its own `ws-layer` (only the active one
`display:block`, the rest hidden-but-mounted). Each workspace owns a **separate**
`<For each={paneIds()}>` (`LayoutNode.tsx:93`) → its own `<TerminalPane>`. So when a pane's id
leaves workspace A's `<For>` and joins B's, Solid disposes the A row and creates a fresh one in
B: **the `<Terminal>` remounts and a new xterm instance is built.** The Rust PTY survives (keyed
by handle) and the new xterm rebinds to it via `Terminal.start`, but the **old xterm's visible
scrollback is lost.**

**Decision — accept the scrollback reset** (process/cwd/session/gates/role all survive; only the
on-screen backscroll clears on arrival, like re-attaching a running session). This matches the
project's "persist intent, not scrollback / terminals are ephemeral" stance and costs nothing.
(`detach.ts` has a stash-and-replay path we could reuse to preserve backscroll, and a full
one-flat-layer render refactor would avoid the remount entirely — both were considered and
rejected as out of scope for this plan.)

**Same-workspace** swap / reposition stays inside one workspace's `<For>`, so it does **not**
remount — exactly the guarantee `swapLeaves` and the existing overview drag-to-swap already rely
on.

## Grounding (verified against the code, 2026-07-11)

- `src/stores/workspace.ts`
  - `wsIdxByPane(paneId)` — resolve a pane's owning workspace (`:215`, exact).
    `wsIdxById(id)` sits right above it (`:214`).
  - `splitPane` (`:302`) and `closePane` (`:329`) are the reference mutations; both wrap the pure
    tree transforms in `lib/layout.ts` via `setTree`/`setApp`.
  - `closePane` (`:329`) is the model for the **cleanup dance** — but read it carefully, the two
    cleanups behave *oppositely* under a move (see below):
    - `releasePaneClaims(paneId)` (`:343`, defined `:357`) → `releaseClaimsBy(ws.id, name)`.
    - `forgetGate(paneId)` (`:344`).
    - focus/zoom re-point (`:349`–`:350`): if the closed pane was `focused` → `firstLeaf(next)`;
      if `zoomed` → `null`.
  - **`swapPanes(a, b)` already exists** (`:366`) and is already same-workspace-only (guards
    `a === b`, requires `b in app.workspaces[i].panes`). It wraps `swapLeaves`. **This plan does
    not build it** — only the drag gesture that calls it is new.
  - `spawnPane` (`:553`) and `reopenPaneItem` (`:710`) are the reference for **inserting** a pane
    into a workspace: split the focused leaf via `replaceLeaf`, and **rename on title collision**
    via `allocName(taken)`. Every entry-into-a-workspace path already does this — the move follows
    the same convention.
- `src/lib/layout.ts` (pure, tested)
  - `firstLeaf` (`:74`), `leafIds` (`:80`), `replaceLeaf` (`:90`), `removeLeaf` (`:100`),
    `swapLeaves` (`:119`). `removeLeaf` returns `null` when removing the last leaf — that `null`
    is our **empty-source signal**.
- `src/stores/claims.ts` — file claims keyed **`claims[workspaceId][path] = { by: paneTitle, at, held? }`**.
  `releaseClaimsBy(wsId, by)` (`:94`) drops every claim a pane holds. **Claims are
  workspace-keyed**, so they do *not* automatically follow a cross-workspace move.
- `src/stores/inputHolds.ts` — input gates keyed **`holds[paneId]`** (`:33`). **Gates are
  PaneId-keyed**, and a move preserves the PaneId, so a gate **travels for free**.
- `src/lib/detach.ts` — `isDetachedPlaceholder(id)` (`:30`) is the guard for a torn-off pane.
- `src/components/LayoutNode.tsx` — pane title bar + per-pane controls (menu button lives here);
  already has overview drag-to-swap wiring (`onDragStart` sets `paneId`; "drag onto another tile
  to swap → reuses swapPanes") to build the grid DnD on.
- `src/components/EmptyWorkspace.tsx` — already rendered by `LayoutNode` `when paneIds().length === 0`.
  Relevant only as a safety net; the auto-close decision means we never intentionally show it.
- `src/components/WorkspaceRail.tsx` — the left rail, drop target for cross-workspace moves.
- `src/components/CommandPalette.tsx` — add actions here.

### ADR-0007 / ADR-0008 check (both satisfied by construction)

- **ADR-0007 (control bus):** a move is a pure store mutation reusing the same layout ops as a UI
  split, so a moved pane stays `loom list` / `send` / `broadcast`-targetable. No Rust, no opacity
  concern. The one obligation: keep a workspace's pane **titles unique** (name→pane resolution
  prefers the active workspace, then a unique global match) — hence rename-on-collision on arrival.
- **ADR-0008 (agent entities):** the leaf keeps the **same `PaneId`** across a move, so the
  `Session` (and `role`/`sessionId` on `PaneSpec`) survives untouched — *provided we carry the
  spec object, not recreate it*. That is the core correctness invariant of every move op.

## Locked decisions (all resolved 2026-07-11)

1. **Empty source workspace → auto-close it**, as a lightweight removal: **no confirm dialog** (no
   process is killed — the pane left alive) and **no reopen-history entry** (it's empty). This can
   never strand you at zero workspaces: a move targets an existing workspace (≥2 exist) or creates
   a new one first (≥2), so the source auto-close always leaves ≥1. Do **not** route this through
   `closeWorkspace` (that adds a confirm + reopen-history + the `length === 1` guard); use a
   dedicated empty-workspace removal.
2. **The view stays in the source workspace** after a move (`activeId` unchanged); the target's
   `focused` is set to the arrival so it's ready when the user switches there. **Sole exception:**
   when the source *auto-closes* (you moved its last pane), the view can't stay — `activeId`
   **follows to the target** (your pane is there, and the source is gone).
3. **Moving a detached pane is blocked** while it's torn off (`isDetachedPlaceholder(id)` true):
   the Move actions are disabled/omitted. Re-dock first, then move.
4. **Swap is same-workspace-only.** `swapPanes` already enforces this; a cross-workspace "swap" is
   not a concept — dragging a pane onto a pane in another workspace is a **move-beside**, not a swap.
5. **Cross-workspace claims are released** (`releaseClaimsBy(sourceWs.id, name)` — the exact call
   `closePane` makes), not re-keyed. Claims are cooperative/advisory/ephemeral; the agent re-claims
   after it lands. **Gates need no action** (PaneId-keyed → travel free — and specifically we must
   **not** call `forgetGate` on a move; that is a close-only cleanup). Same-workspace moves keep
   claims automatically (workspace id + title both unchanged).
6. **Cross-workspace scrollback resets** on the unavoidable `<Terminal>` remount (see "Why it isn't
   cheap" above). Accepted; process state survives.
7. **Rename on title collision** on arrival, via `allocName` over the target's taken titles —
   following the existing `spawnPane`/`reopenPaneItem` convention (keeps bus resolution
   unambiguous). The claim-release in (5) uses the pane's **original** title (still valid in the
   source); the target insert uses the **final** (possibly renamed) title.

## Ordered task breakdown

### Phase 0 — shared internal helper (workspace.ts, private)

- [ ] `detachPaneFromSource(paneId): { spec: PaneSpec; sourceEmptied: boolean } | null` — the piece
      every cross-workspace op shares. Resolve `i = wsIdxByPane`; snapshot `spec = ws.panes[paneId]`;
      `releaseClaimsBy(ws.id, spec.title)`; `const without = removeLeaf(ws.tree, paneId)`.
      - If `without === null` (was the last pane): mark `sourceEmptied = true`, **remove workspace
        `i` from the list** (splice); if it was active, the caller re-points `activeId` to the
        target. No `setTree`, no reopen-history, no confirm.
      - Else: `setTree(i, without)`; delete `ws.panes[paneId]`; if `ws.focused === paneId` →
        `firstLeaf(without)`; if `ws.zoomed === paneId` → `null`.
      - **Do not** touch gates. Returns the spec so the caller inserts it into the target.
      - No-op guard when `isDetachedPlaceholder(paneId)`.

### Phase 1 — core store ops (workspace.ts)

- [ ] `movePaneToWorkspace(paneId, targetWsId)` — guard `A = wsIdxByPane(paneId) >= 0`,
      `B = wsIdxById(targetWsId) >= 0`, `A !== B`, not detached. Rename spec title on collision
      (`allocName` over B's titles). `detachPaneFromSource(paneId)` for the source side. Insert into
      B beside `B.focused ?? firstLeaf(B.tree)` via `replaceLeaf` (`dir:"row"`, like `spawnPane`).
      `batch`: `setTree(B)`, `B.panes[paneId] = spec` (renamed), `B.focused = paneId`,
      `B.zoomed = null`. If the source emptied and was active, `activeId = targetWsId`.
- [ ] `movePaneToNewWorkspace(paneId, name?)` — build the target **directly** with the pane as its
      root leaf (don't use `buildWorkspace`, which allocates fresh panes):
      `{ id: nextWsId(), name: name ?? spec.title, cwd: spec.cwd || sourceCwd, tree: {kind:"leaf",paneId},
      panes: {[paneId]: spec}, focused: paneId, zoomed: null, panel: freshPanel() }`. Append it,
      **then** `detachPaneFromSource(paneId)`. (Capture the spec before detaching.) If the source
      emptied and was active, `activeId = new ws id`.
- [ ] `movePaneBeside(paneId, targetPaneId, side)` where `side ∈ {"left","right","up","down"}`
      (→ `dir` = row for left/right, col for up/down; moved leaf goes in `a` for left/up, `b` for
      right/down). Guard `paneId !== targetPaneId`.
      - **Same workspace** (`wsIdxByPane(paneId) === wsIdxByPane(targetPaneId)`): **tree-only**, no
        `panes`/claims/focus-workspace change. `without = removeLeaf(tree, paneId)`, then
        `replaceLeaf(without, targetPaneId, make(side))`; optionally set `focused = paneId`. (Mirrors
        `swapPanes`' single-tree scope.)
      - **Cross workspace:** like `movePaneToWorkspace` but insert beside `targetPaneId` with `side`
        instead of beside the target's focused leaf.
- [ ] `swapPanes` — **already exists** (`:366`). No store work; only the drag gesture is new.
- [ ] `canMovePane(paneId): boolean` — `!isDetachedPlaceholder(paneId)`. Surfaces call this to
      disable/omit Move actions.

### Phase 2 — surfaces (cheapest first)

1. [ ] **Title-bar menu** — a `Move to ▸` submenu in `LayoutNode.tsx` pane controls: the other
       workspaces (by name) + `New workspace`. Disabled when `!canMovePane(id)`. Calls
       `movePaneToWorkspace` / `movePaneToNewWorkspace`.
2. [ ] **Command palette** — `Move pane to…` action in `CommandPalette.tsx` → workspace picker
       (+ New workspace). Keyboard-first; same guard.
3. [ ] **Drag & drop** — drag a pane by its title bar; build on the existing overview drag-to-swap
       wiring. Drop targets:
       - onto another pane, **same workspace** → `swapPanes` (or `movePaneBeside` if we expose a
         side from the drop quadrant),
       - onto another pane, **different workspace** → `movePaneBeside` (cross),
       - onto a rail entry → `movePaneToWorkspace`,
       - onto rail empty space / `+` → `movePaneToNewWorkspace`.
       The only fiddly part is hit-testing grid vs. rail and (optionally) the drop quadrant → `side`.
       Do this last.

### Phase 3 — tests (Vitest: `stores/workspace` + `lib/layout` suites)

- [ ] `movePaneToWorkspace`: A/B tree shape before/after; `panes` ownership transfers; **PaneId
      identity preserved** (Session survives); source focus re-point; `B.focused` = arrival,
      `B.zoomed` cleared; claims released under source (assert `releaseClaimsBy` effect); **gate
      preserved** (pane still gated after move — regression guard for the "gates travel free" claim);
      `activeId` unchanged when source survives.
- [ ] Auto-close empty source: source removed from `workspaces`; `activeId` follows to target when
      the source was active; ≥1-workspace invariant holds.
- [ ] `movePaneToNewWorkspace`: new workspace is a single leaf = the pane; source side handled.
- [ ] `movePaneBeside` same-workspace: tree-only, `side` ordering (left/right → row a/b,
      up/down → col a/b); `panes` map untouched.
- [ ] `movePaneBeside` cross-workspace: inserts beside target with correct side.
- [ ] Rename on collision: arriving into a workspace that already has the title → renamed via
      `allocName`; claim release keyed on the **original** title, insert keyed on the **final** title.
- [ ] Detached guard: `canMovePane` false when `isDetachedPlaceholder` true.

## Not doing (considered, rejected)

- **New ADR** — this is a pure frontend state edit reusing existing, documented ops; easy to
  reverse, not surprising, no real trade-off locked in. No ADR.
- **New CONTEXT.md term** — "move a pane" is a general operation, not new domain vocabulary; the
  durable identity it preserves (`Session`/`PaneId`) is already defined by ADR-0008.
- **Scrollback preservation** on cross-workspace move (replay via `detach.ts`) and the
  **one-flat-layer render refactor** that would avoid the remount — both out of scope (decision 6).
- **Cross-workspace swap** — expressed as a move-beside instead (decision 4).
- Moving a pane to another OS **window** — that's the existing tear-off (`detach.ts`), a different
  feature.
