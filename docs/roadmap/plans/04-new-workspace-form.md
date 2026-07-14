# Plan 04 — New-workspace launcher: full-stage inline view, not a popup

**Status:** ✅ shipped (2026-07-14) · **Effort:** ~1–2 days (incl. design pass) · **Rust:** none · **ADR:** not needed
**Built as:** `src/components/NewWorkspaceLauncher.tsx` (renamed from `NewWorkspaceWizard`). Full-stage
render-swap gated by an app-level `launcherOpen` signal in `App.tsx` (mirrors `zoomed`); docked panels +
`FleetApprovals` suppressed while open. Calm centered column + `Customize each pane` disclosure; fleet
one-liner; `savePreset()` (new store fn) wires up "Save as preset". Covered by `workspace.test.ts`.
**Decisions locked (grilled 2026-07-11):**
- Stop using a popup/modal — the launcher **takes over the stage** (where the grid normally is),
  **not the whole window**: the left rail and title bar stay visible (truest mirror of `zoomed`).
- It's currently **too dense** — go to a **calm centered column** with the per-pane grid behind a
  **"Customize panes" disclosure** (progressive disclosure), and give the **visual design** a pass.
- Gating is a **transient app-level signal** (render-swap of the stage), **not** per-workspace store.
- **No pre-launch reorder** — per-pane click-to-configure + Plan 01's post-launch drag cover it.
- **Add "Save as preset"**; **defer per-pane env vars** (would break Rust:none).

## Goal

Turn the new-workspace launcher from a floating modal into a **full-stage view** that replaces the
grid (rail + title bar persist), and de-clutter + restyle it so first-run doesn't feel overwhelming
or templated.

## Naming: "wizard" → "launcher"

The component is still `NewWorkspaceWizard`, but "wizard" encodes a **multi-step** flow that no
longer exists (the three Start→Layout→Agents steps collapsed to one panel — see the file header at
`src/components/NewWorkspaceWizard.tsx:1-6`). This plan widens that gap (full-stage + a disclosure),
so standardize on **"launcher"** throughout. **Recommended cleanup (optional, do last):** rename the
file/symbol to `NewWorkspaceLauncher` and update the 5 import/entry sites (see *Entry/exit wiring*).
Not domain language, so no `CONTEXT.md` entry.

## Current state (important — it was already refactored once)

`src/components/NewWorkspaceWizard.tsx:1-6` documents that the old **three-step** Start→Layout→Agents
wizard was **already collapsed into a single panel**: left = where (folder + Recents + presets +
launch options), right = what (layout picker + fleet row + interactive grid preview). This plan is a
**second pass** on that single-panel version — not undoing the collapse, but (a) moving it out of a
popup onto the stage and (b) fixing density + looks.

## Approach

### A. Full-stage instead of modal — gate it like `zoomed`, render like `zoomed`

**How `zoomed` works (the pattern to mirror):** `zoomed` is **per-workspace** state
(`ws.zoomed: PaneId | null`, `stores/workspace.ts:46`); `LayoutNode.tsx:55-57` reads it and, when
set, renders the one pane full-bleed (`inset:0`) while hiding its siblings — i.e. a **mode flag that
the stage's render switch reads to swap what fills the stage**. Crucially, `zoomed` fills **only the
stage** — the rail and title bar are untouched. That "swap the stage's contents" shape is what we
mirror; the launcher is **not** literally added to per-workspace store, because:

- **No workspace owns it.** The launcher *creates* a workspace; it can't be a field on one.
- **It must never persist.** `zoomed` is force-reset to `null` on load (`stores/workspace.ts:859`);
  a launcher-open flag has the same requirement, and a plain signal gets that for free.
- **No layout op needs to re-point it.** `zoomed` lives in the store because move/close must carry or
  clear it (Plan 01); the launcher flag has no such coupling.

**Decision — gating:** keep an **app-level transient signal** (the existing `wizardOpen` in
`App.tsx:47`, renamed `launcherOpen`). Not persisted, not in `appState`. The *only* structural change
is **where it renders**: today it's a sibling overlay at the end of the tree (`App.tsx:314-316`);
move it **inside `.stage`, in place of `.stage-grid`**, so the stage swaps to the launcher exactly as
it would swap to a zoomed pane.

- [ ] Rename `wizardOpen`/`setWizardOpen` → `launcherOpen`/`setLauncherOpen` (App-local signal).
- [ ] In `.stage`, render `<Show when={launcherOpen()} fallback={<stage-grid…/>}>` → the launcher
      fills the stage; otherwise the normal workspace layers render. Rail (`WorkspaceRail`) and
      `TitleBar` are **outside** `.stage`, so they stay visible for free.
- [ ] Remove the `.wizard-backdrop` / `.wizard` modal + backdrop chrome and the `wizard-wide` shell;
      the view is now a plain full-stage container.
- [ ] While the launcher owns the stage, **suppress the stage's workspace-context UI**: gate
      `FleetApprovals` (inside `.stage`) and the four docked panels (git/docs/fleet/board, siblings of
      `.stage`) with `&& !launcherOpen()` — they belong to a backgrounded workspace and shouldn't
      bleed over the create flow.

**Entry/exit wiring (all just call `setLauncherOpen(true/false)` — no logic moves):**
- Entry points (unchanged behavior): rail `+` (`App.tsx:281` `onNew`), `loom:new-workspace` event
  (`:103`), `GLOBAL_ACTIONS["new-workspace"]` (`:178`), CommandPalette `onNewWorkspace` (`:335`).
- Exit: **launch** (creates the workspace, then closes) or **cancel/Esc** returns to the grid.
- [ ] **Enter/exit leaves no orphaned state.** The launcher's per-pane arrays
      (`commands/cwds/shells/prompts`) are component-local and die with unmount; ensure the
      component is genuinely unmounted on close (it is, under `<Show>`), so reopening starts fresh.
      Nothing to reset in the store.

### B. De-densify — calm centered column, per-pane grid on demand

Replace the two-column WHERE/WHAT split with a **single centered column** (max-width ~640–720px) that
reads top-to-bottom, with the noisy per-pane machinery hidden until asked for:

1. [ ] **Folder + name** (primary). Working-folder input + `Browse…` + Recents chips; name auto-fills
       from the folder basename until hand-edited (existing `applyCwd`/`nameDirty` logic — keep it).
2. [ ] **Layout picker** (prominent). Mini-grid preset tiles (reuse `MiniGrid` + `balancedBands`) +
       the 1–16 slider + the "{n} panes" readout. Reuse `PRESETS`/`MAX_PANES`.
3. [ ] **Fleet one-liner.** "Fill every pane with **[agent]**" (+ the Windows shell selector, see D).
       This is the **one-click "fill every pane with one agent"** shortcut — keep it front-and-center;
       most fleets never need per-pane config. Applies immediately (no separate "Apply to all" step
       needed in the calm view; keep an explicit apply only inside the disclosure if useful).
4. [ ] **`▸ Customize each pane` disclosure** (collapsed by default). Expanding it reveals the
       **interactive preview grid** (click a pane → set its agent/command/cwd/seed) — i.e. everything
       under `WHAT RUNS`'s preview + the per-pane editor moves in here. When expanded it may **widen
       past the centered column** (grid + editor side-by-side) since per-pane work wants the room;
       collapsed, the column stays narrow and calm.
5. [ ] **Footer**: `Cancel` · `Create workspace` (+ the `Mod+T` hint), plus **Save as preset** (see E).

Keep the existing **Presets** list (launch/delete saved presets) — place it under the folder zone or
in a secondary spot; it's a shortcut *past* this whole flow, so it shouldn't crowd the primary column.

### C. Visual pass

- [ ] Run the `frontend-design` skill for aesthetic direction (typography, spacing, the layout tiles,
      the grid preview, the disclosure affordance) so the full-stage view reads intentional, not a
      modal that merely grew. Now that it owns the stage, it can afford generous whitespace and a
      clear vertical rhythm rather than the cramped modal grid.

### D. Windows shell picker (`IS_WINDOWS`) placement

Two levels, each riding with its zone (unchanged semantics, relocated):
- [ ] **Global shell** stays on the **fleet one-liner**: "fill every pane with [agent] **in** [shell]"
      (`fillAllShells`). Zone 3 above.
- [ ] **Per-pane shell override** stays in the **per-pane editor**, now inside the *Customize panes*
      disclosure (Zone 4). `shellOptions()`/`listWslDistros()` logic is unchanged.
- On non-Windows, both simply don't render (`IS_WINDOWS` guard as today).

### E. Save as preset (in scope)

- [ ] Add a **"Save as preset"** action in the footer that captures the current
      folder/name/layout/fleet/per-pane config into the existing `presets` store, so it appears in the
      Presets list (which already supports launch + delete here). Reuse whatever `launchPreset`/preset
      shape already stores (`paneCount`, `commands`, `tree`, …); this closes the loop — presets are
      currently only *consumed* here, never *created* here.

## Explicitly out of scope (resolved open questions)

- **Pre-launch reorder — NO.** You can already click any pane in the preview to set its agent/command
  directly, so position never gates identity; and **Plan 01** (`movePaneBeside`/`swapPanes`) covers
  drag/swap/move once panes are live PaneIds. Adding drag to the launcher's local arrays would be a
  redundant second surface and pull drag machinery into a Rust:none plan. Keep the preview grid
  click-to-configure only.
- **Per-pane env vars — DEFER.** Needs new fields through `ipc/protocol.ts` + `createWorkspace` +
  Rust `PaneSpec` — breaks this plan's **Rust:none** constraint. Spin its own plan if wanted.

## Grounding

- `src/components/NewWorkspaceWizard.tsx` — the component to restructure (→ `NewWorkspaceLauncher`).
- `src/App.tsx` — `wizardOpen` signal (`:47`), overlay render (`:314-316`), `.stage`/`.stage-grid`
  (`:282-293`), the 4 entry points, docked-panel `<Show>`s (`:301-312`), `FleetApprovals` (`:295`).
- `src/components/LayoutNode.tsx:52-57` — the `zoomed` render-swap this mirrors.
- `src/stores/workspace.ts` — `createWorkspace`, `launchPreset`, `presets`, `recents`; `zoomed`
  gating (`:46`, `:859`) as the reference pattern (not extended).
- `src/lib/grid.ts` — `balancedBands`, `allocName`, `buildBalancedTree(n)`.
- `src/stores/settings.ts` — `defaultCwd`.

## Tests

- [ ] Launcher still produces the same `createWorkspace`/`launchPreset` calls (behavior parity) — the
      per-pane arrays (`commands/cwds/shells/prompts`) map through unchanged.
- [ ] Full-stage enter/exit doesn't leave orphaned state: opening → cancel → reopening starts from a
      clean folder/layout/fleet (component unmounts under `<Show>`); the rail and title bar remain
      interactive throughout; docked panels + `FleetApprovals` are hidden while it's open and return
      on close.
- [ ] "Fill every pane with [agent]" still fills every pane; the *Customize panes* disclosure reveals
      per-pane config and per-pane edits survive collapsing/expanding it.
- [ ] "Save as preset" writes a preset that then launches to the same layout/fleet it was saved from.
