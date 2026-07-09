// Normalized app store: a list of workspaces (the rail) + which one is active. Each
// workspace owns its layout tree, panes, focus, and zoom. Switching only flips `activeId`
// — every workspace's panes stay mounted (PTYs survive hiding); closing a workspace removes
// it (its panes unmount → PTYs die). Components import this singleton and call its ops.
//
// Focus/zoom are ephemeral UI state and live alongside the persisted Workspace fields here;
// persistence (M3 Stage D) serializes only id/name/cwd/tree/panes.

import { batch, createEffect, onCleanup } from "solid-js";
import { createStore } from "solid-js/store";
import type { LayoutNode, PaneId, PaneSpec, Workspace } from "../ipc/protocol";
import { allocName, buildBalancedTree } from "../lib/grid";
import { firstLeaf, leafIds, neighbor, removeLeaf, replaceLeaf, swapLeaves, type Dir, type Path } from "../lib/layout";
import { loadState, saveState } from "../lib/persist";
import { countLive } from "../lib/paneRegistry";
import { forgetBoard } from "./blackboard";
import { forgetClaims, releaseClaimsBy } from "./claims";
import { settings } from "./settings";

/** The mutually-exclusive right-side docked panels (one slot, one open at a time). */
export type DockedPanelKind = "git" | "docs" | "fleet" | "board";

/**
 * Per-workspace state for the docked side panel. Lets each workspace carry its own Source
 * Control / Docs: opening one in workspace A leaves workspace B untouched, and the
 * source folder is captured from the active terminal *at open time* (so it stays pinned to
 * the folder you opened against, even if you later cd or focus elsewhere). Ephemeral.
 */
export interface DockedPanelState {
  /** Which panel is open in this workspace, or null for none. */
  open: DockedPanelKind | null;
  /** Source folder captured when Source Control was opened ("" until first opened). */
  gitCwd: string;
  /** Source folder captured when the Docs reader was opened ("" until first opened). */
  docsCwd: string;
}

const freshPanel = (): DockedPanelState => ({ open: null, gitCwd: "", docsCwd: "" });

/**
 * A workspace plus its ephemeral UI state (focus/zoom/panel — not persisted).
 * `panel` is this workspace's docked side-panel (Source Control / Docs) state.
 */
export interface WorkspaceUI extends Workspace {
  focused: PaneId | null;
  zoomed: PaneId | null;
  panel: DockedPanelState;
}

/** A recently-used working folder + its remembered terminal count (for the wizard). */
export interface RecentFolder {
  cwd: string;
  count: number;
}

/** A saved workspace template the wizard can relaunch in one click. */
export interface Preset {
  id: string;
  name: string;
  cwd: string;
  paneCount: number;
  /** Per-pane launch commands in row-major order (empty/omitted = plain shell). */
  commands?: (string | undefined)[];
  /** The captured split tree + per-pane specs, so relaunch rebuilds the hand-tuned layout
   *  (shape, gutter ratios, per-pane cwd) faithfully. Absent on older presets → balanced grid. */
  tree?: LayoutNode;
  panes?: Record<PaneId, PaneSpec>;
}

/**
 * A pane or workspace the user *explicitly* closed, retained so it can be reopened (the
 * `reopen-closed` shortcut, the command palette, or the History panel). Only explicit closes
 * are recorded — a normal app shutdown persists the live workspaces instead, so quitting doesn't
 * flood this list. A reopened Claude pane resumes its conversation, because the captured spec
 * keeps the managed `sessionId` (see lib/agents.ts). Persisted to disk, newest-first, capped.
 */
export interface ClosedItem {
  id: string;
  kind: "pane" | "workspace";
  /** Pane title or workspace name, shown in the picker. */
  title: string;
  /** Working folder (pane cwd or workspace cwd) — display + restore context. */
  cwd: string;
  /** When it was closed (epoch ms). */
  closedAt: number;
  /** kind === "pane": the captured spec (command/cwd/shell/env/title/sessionId). */
  spec?: PaneSpec;
  /** kind === "workspace": the captured layout, rebuilt faithfully on reopen. */
  tree?: LayoutNode;
  panes?: Record<PaneId, PaneSpec>;
}

interface AppState {
  workspaces: WorkspaceUI[];
  activeId: string;
  recents: RecentFolder[];
  presets: Preset[];
  /** Recently closed panes/workspaces, newest-first (reopen history). */
  closed: ClosedItem[];
  /** Overview ("fleet glance") mode: the active workspace's panes reflow to a uniform tile grid
      (a view transform only — the split tree and PTYs are untouched). Active-workspace scoped. */
  overview: boolean;
}

let idSeq = 0;
let wsSeq = 0;
let presetSeq = 0;
let closedSeq = 0;
const nextPaneId = (): PaneId => ++idSeq;
const nextWsId = (): string => `ws${++wsSeq}`;
const nextPresetId = (): string => `ps${++presetSeq}`;
const nextClosedId = (): string => `cl${++closedSeq}`;

/** How many recently-closed items to retain. */
const CLOSED_MAX = 30;

/** Deep-copy a captured spec/tree off the reactive store, so the history holds a frozen snapshot
 *  that survives the original pane/workspace being removed (and round-trips cleanly to disk). */
const snapshotValue = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export interface NewWorkspaceOpts {
  name: string;
  cwd: string;
  paneCount: number;
  /** Per-pane launch commands in row-major order; entry omitted/empty = plain shell. */
  commands?: (string | undefined)[];
  /** Per-pane working-folder overrides (row-major); entry omitted/empty = workspace `cwd`. */
  cwds?: (string | undefined)[];
  /** Per-pane shell overrides (row-major), e.g. `wsl.exe -d Ubuntu`; omitted/empty = global default. */
  shells?: (string | undefined)[];
  /** A saved layout to rebuild verbatim (preset relaunch / duplicate) instead of a balanced grid.
   *  When set with `panes`, the tree shape + gutter ratios are preserved and each leaf is remapped
   *  to a fresh PaneId; `paneCount`/`commands`/`cwds` are then ignored. */
  tree?: LayoutNode;
  panes?: Record<PaneId, PaneSpec>;
  /** Keep each pane's Claude `sessionId` when rebuilding `tree`/`panes` so reopening a closed
   *  workspace *resumes* its conversations. Off for duplicate/preset (they start fresh). */
  keepSession?: boolean;
}

/**
 * Deep-clone a split tree with fresh PaneIds, copying each leaf's spec (command/cwd/env/title)
 * from `srcPanes`. Returns the new tree + its panes map. Shared by duplicate-workspace and faithful
 * preset relaunch — both need the exact shape/ratios with brand-new PaneIds (→ brand-new PTYs).
 */
function cloneTreeWithFreshPanes(
  srcTree: LayoutNode,
  srcPanes: Record<PaneId, PaneSpec>,
  keepSession = false,
): { tree: LayoutNode; panes: Record<PaneId, PaneSpec> } {
  const panes: Record<PaneId, PaneSpec> = {};
  const usedTitles: string[] = [];
  const clone = (node: LayoutNode): LayoutNode => {
    if (node.kind === "leaf") {
      const paneId = nextPaneId();
      const srcSpec = srcPanes[node.paneId];
      const spec: PaneSpec = srcSpec ? { ...srcSpec } : { title: allocName(usedTitles) };
      if (spec.env) spec.env = { ...spec.env }; // don't share env with the source
      // A clone (duplicate workspace / preset relaunch) starts its own Claude conversation — the
      // managed session id is per-pane, so copying it would make the clone hijack the original's.
      // Reopening a *closed* workspace is the exception (keepSession): there we want it to resume.
      if (!keepSession) delete spec.sessionId;
      if (!spec.title) spec.title = allocName(usedTitles);
      usedTitles.push(spec.title);
      panes[paneId] = spec;
      return { kind: "leaf", paneId };
    }
    return { kind: "split", dir: node.dir, ratio: node.ratio, a: clone(node.a), b: clone(node.b) };
  };
  return { tree: clone(srcTree), panes };
}

function buildWorkspace(opts: NewWorkspaceOpts): WorkspaceUI {
  // Faithful path: rebuild a saved tree verbatim (preset relaunch / duplicate / reopen), fresh PaneIds.
  if (opts.tree && opts.panes) {
    const { tree, panes } = cloneTreeWithFreshPanes(opts.tree, opts.panes, opts.keepSession);
    return { id: nextWsId(), name: opts.name, cwd: opts.cwd, tree, panes, focused: firstLeaf(tree), zoomed: null, panel: freshPanel() };
  }
  const panes: Record<PaneId, PaneSpec> = {};
  let i = 0;
  const makeLeaf = (): LayoutNode => {
    const paneId = nextPaneId();
    const title = allocName(Object.values(panes).map((p) => p.title));
    const command = opts.commands?.[i]?.trim();
    const cwd = opts.cwds?.[i]?.trim();
    const shell = opts.shells?.[i]?.trim();
    const spec: PaneSpec = { title };
    if (command) spec.command = command;
    if (cwd) spec.cwd = cwd;
    if (shell) spec.shell = shell;
    panes[paneId] = spec;
    i++;
    return { kind: "leaf", paneId };
  };
  const tree = buildBalancedTree(Math.max(1, opts.paneCount), makeLeaf);
  return { id: nextWsId(), name: opts.name, cwd: opts.cwd, tree, panes, focused: firstLeaf(tree), zoomed: null, panel: freshPanel() };
}

// Starts empty; `init()` (called once at startup) hydrates from disk or seeds a default
// workspace. Rendering is gated on init completing so panes spawn exactly once.
const [app, setApp] = createStore<AppState>({ workspaces: [], activeId: "", recents: [], presets: [], closed: [], overview: false });

/** Reactive read-only view for components. */
export const appState = app;
export const recents = (): RecentFolder[] => app.recents;
export const presets = (): Preset[] => app.presets;
export const activeWorkspace = (): WorkspaceUI | undefined => app.workspaces.find((w) => w.id === app.activeId);
export const paneCount = (ws: Workspace): number => Object.keys(ws.panes).length;

const wsIdxById = (id: string) => app.workspaces.findIndex((w) => w.id === id);
const wsIdxByPane = (paneId: PaneId) => app.workspaces.findIndex((w) => paneId in w.panes);

// ---- Pane operations (resolve their owning workspace by paneId) ----------------------
// The pure tree transforms these build on (replaceLeaf/removeLeaf/firstLeaf/leafIds) live in
// lib/layout.ts; each op below wraps one in a `setApp` mutation.

export function focusPane(paneId: PaneId) {
  const i = wsIdxByPane(paneId);
  if (i >= 0) setApp("workspaces", i, "focused", paneId);
}

export function toggleZoom(paneId: PaneId) {
  const i = wsIdxByPane(paneId);
  if (i >= 0) setApp("workspaces", i, "zoomed", (z) => (z === paneId ? null : paneId));
}

/** Move focus to the pane spatially adjacent to `from` in `dir` (Ctrl+Shift+arrows). */
export function focusDir(from: PaneId, dir: Dir): boolean {
  const i = wsIdxByPane(from);
  if (i < 0) return false;
  const next = neighbor(app.workspaces[i].tree, from, dir);
  if (next === null) return false;
  setApp("workspaces", i, "focused", next);
  return true;
}

export function renamePane(paneId: PaneId, title: string) {
  const i = wsIdxByPane(paneId);
  const name = title.trim();
  if (i >= 0 && name) setApp("workspaces", i, "panes", paneId, "title", name);
}

/** Drop a pane's launch command so it (re)spawns as a plain login shell. The "Open shell
 *  instead" escape hatch on a Dead pane whose agent command wasn't installed (exited 127).
 *  Persisted, so a later restart/reload is a shell too — not the missing command again. */
export function clearPaneCommand(paneId: PaneId) {
  const i = wsIdxByPane(paneId);
  if (i >= 0) setApp("workspaces", i, "panes", paneId, "command", undefined);
}

/** Record the managed Claude session id pinned on a pane's first launch, so a later restart
 *  resumes its conversation (persisted with the spec; see lib/agents.ts `resumeClaudeCommand`). */
export function setPaneSessionId(paneId: PaneId, sessionId: string) {
  const i = wsIdxByPane(paneId);
  if (i >= 0) setApp("workspaces", i, "panes", paneId, "sessionId", sessionId);
}

/** Adopt an agent started *by hand* in a pane as that pane's launch command, so it persists and
 *  respawns on restart instead of coming back as a plain shell. `command` is the live foreground
 *  command line; `sessionId`, when given, is the captured Claude session so a restart resumes that
 *  exact conversation (see Terminal.tsx `adopt`). Idempotent-ish: a blank command is ignored. */
export function adoptPaneCommand(paneId: PaneId, command: string, sessionId?: string) {
  const cmd = command.trim();
  if (!cmd) return;
  const i = wsIdxByPane(paneId);
  if (i < 0) return;
  batch(() => {
    setApp("workspaces", i, "panes", paneId, "command", cmd);
    if (sessionId) setApp("workspaces", i, "panes", paneId, "sessionId", sessionId);
  });
}

/** Rename a workspace (rail double-click). Blank input is ignored — keeps the old name. */
export function renameWorkspace(id: string, name: string) {
  const i = wsIdxById(id);
  const next = name.trim();
  if (i >= 0 && next) setApp("workspaces", i, "name", next);
}

export function splitPane(paneId: PaneId, dir: "row" | "col") {
  const i = wsIdxByPane(paneId);
  if (i < 0) return;
  const ws = app.workspaces[i];
  const newId = nextPaneId();
  const newTree = replaceLeaf(ws.tree, paneId, (leaf) => ({
    kind: "split", dir, ratio: 0.5, a: leaf, b: { kind: "leaf", paneId: newId },
  }));
  const title = allocName(Object.values(ws.panes).map((p) => p.title));
  batch(() => {
    setApp("workspaces", i, "panes", newId, { title });
    setApp("workspaces", i, "tree", newTree);
    setApp("workspaces", i, "focused", newId);
    setApp("workspaces", i, "zoomed", null);
  });
}

/** Push a reopen-history entry (newest-first, capped). Captured values are snapshotted off the
 *  store so they survive the pane/workspace being removed. */
function recordClosed(item: Omit<ClosedItem, "id" | "closedAt">) {
  const entry: ClosedItem = { ...item, id: nextClosedId(), closedAt: Date.now() };
  setApp("closed", [entry, ...app.closed].slice(0, CLOSED_MAX));
}

/** Does this pane still exist (live in some workspace)? Reactive — reads the workspace store. */
export const paneExists = (paneId: PaneId): boolean => app.workspaces.some((w) => paneId in w.panes);

export function closePane(paneId: PaneId, opts?: { skipConfirm?: boolean }) {
  const i = wsIdxByPane(paneId);
  if (i < 0) return;
  const ws = app.workspaces[i];
  const next = removeLeaf(ws.tree, paneId);
  if (next === null) return; // never leave a workspace with zero panes
  // Guard against closing a pane whose process is still alive (Settings → confirm close). The
  // caller can skip this when it has already confirmed (e.g. deleting a board card + its pane).
  if (!opts?.skipConfirm && settings.confirmClose && countLive([paneId]) > 0) {
    if (!window.confirm(`Close "${ws.panes[paneId]?.title}"? Its process is still running.`)) return;
  }
  // Capture the spec (incl. any Claude sessionId) so the pane — and its conversation — can be reopened.
  const spec = ws.panes[paneId];
  if (spec) recordClosed({ kind: "pane", title: spec.title, cwd: spec.cwd || ws.cwd, spec: snapshotValue(spec) });
  releasePaneClaims(paneId); // free any file claims (§2c) this pane held before it's gone

  batch(() => {
    setApp("workspaces", i, "tree", next);
    setApp("workspaces", i, "panes", paneId, undefined as unknown as PaneSpec);
    if (ws.focused === paneId) setApp("workspaces", i, "focused", firstLeaf(next));
    if (ws.zoomed === paneId) setApp("workspaces", i, "zoomed", null);
  });
}

/** Release any file claims (§2c) a pane holds — its holder is going away (process exit or close),
 *  so the lock shouldn't outlive it. Looks the pane up by its own workspace + display name (how
 *  claims are keyed). A no-op if the pane holds nothing. Notes are left alone (shared, not owned). */
export function releasePaneClaims(paneId: PaneId) {
  const i = wsIdxByPane(paneId);
  if (i < 0) return;
  const ws = app.workspaces[i];
  const name = ws.panes[paneId]?.title;
  if (name) releaseClaimsBy(ws.id, name);
}

/** Swap two panes' grid positions (drag-to-rearrange). Only swaps within one workspace. */
export function swapPanes(a: PaneId, b: PaneId) {
  if (a === b) return;
  const i = wsIdxByPane(a);
  if (i < 0 || !(b in app.workspaces[i].panes)) return;
  setApp("workspaces", i, "tree", (t) => swapLeaves(t, a, b));
}

export function setRatio(wsId: string, path: Path, ratio: number) {
  const i = wsIdxById(wsId);
  if (i < 0) return;
  const r = Math.max(0.05, Math.min(0.95, ratio));
  // Dynamic store path: `("workspaces", i, "tree", ...path, "ratio")`.
  (setApp as (...args: unknown[]) => void)("workspaces", i, "tree", ...path, "ratio", r);
}

// ---- Inter-pane control bus support (ADR-0007) --------------------------------------
// Name resolution + CLI-driven spawn live here, in TS, alongside the rest of the layout
// logic. The control relay (Rust) and the frontend handler (src/lib/paneControl.ts) call
// these; liveness itself is the pane registry's call at write time.

/** One pane for a `loom list`, in row-major order across all workspaces. */
export interface PaneListing {
  paneId: PaneId;
  name: string;
  workspace: string;
  focused: boolean;
}

export function listPanes(): PaneListing[] {
  const out: PaneListing[] = [];
  for (const w of app.workspaces) {
    for (const id of leafIds(w.tree)) {
      out.push({ paneId: id, name: w.panes[id]?.title ?? `Pane ${id}`, workspace: w.name, focused: w.focused === id });
    }
  }
  return out;
}

/**
 * Resolve a pane display name to its PaneId, preferring the active workspace, then a unique
 * match across all workspaces. A name shared by several panes is an error (the CLI surfaces
 * it) rather than a silent pick.
 */
export function resolvePaneByName(name: string): { paneId: PaneId } | { error: string } {
  const active = activeWorkspace();
  if (active) {
    for (const id of leafIds(active.tree)) if (active.panes[id]?.title === name) return { paneId: id };
  }
  const matches: PaneId[] = [];
  for (const w of app.workspaces) for (const id of leafIds(w.tree)) if (w.panes[id]?.title === name) matches.push(id);
  if (matches.length === 1) return { paneId: matches[0] };
  if (matches.length === 0) return { error: `no pane named "${name}"` };
  return { error: `"${name}" is ambiguous (${matches.length} panes share it)` };
}

/** A pane's launch spec by id (searches all workspaces). Used to derive its Agent kind (ADR-0008). */
export function paneSpecById(paneId: PaneId): PaneSpec | undefined {
  for (const w of app.workspaces) {
    const spec = w.panes[paneId];
    if (spec) return spec;
  }
  return undefined;
}

/** A workspace looked up by display name, preferring the active one (`loom broadcast --workspace`). */
export function workspaceByName(name: string): WorkspaceUI | undefined {
  const active = activeWorkspace();
  if (active && active.name === name) return active;
  return app.workspaces.find((w) => w.name === name);
}

/** The workspace containing a pane with this display name — scopes the blackboard to the caller's
 *  board (`loom note`, §2b). Prefers the active workspace, then a unique match; undefined if none
 *  or ambiguous across workspaces. */
export function workspaceByPaneName(name: string): WorkspaceUI | undefined {
  const active = activeWorkspace();
  if (active) for (const id of leafIds(active.tree)) if (active.panes[id]?.title === name) return active;
  let hit: WorkspaceUI | undefined;
  for (const w of app.workspaces) {
    for (const id of leafIds(w.tree)) {
      if (w.panes[id]?.title === name) {
        if (hit && hit.id !== w.id) return undefined; // ambiguous across workspaces
        hit = w;
      }
    }
  }
  return hit;
}

/** Switch to a pane's workspace and focus it (used by `loom focus` and the command palette). */
export function revealPane(paneId: PaneId) {
  const i = wsIdxByPane(paneId);
  if (i < 0) return;
  batch(() => {
    setApp("activeId", app.workspaces[i].id);
    setApp("workspaces", i, "focused", paneId);
    setApp("workspaces", i, "zoomed", null);
  });
}

/**
 * Reveal a pane by name: switch to its workspace and focus it (`loom focus`). Returns the pane's
 * name on success. Resolution reuses {@link resolvePaneByName} (active-workspace-preferring).
 */
export function revealPaneByName(name: string): { name: string } | { error: string } {
  const r = resolvePaneByName(name);
  if ("error" in r) return r;
  const i = wsIdxByPane(r.paneId);
  if (i < 0) return { error: `no pane named "${name}"` };
  revealPane(r.paneId);
  return { name: app.workspaces[i].panes[r.paneId]?.title ?? name };
}

/**
 * Spawn a new pane in the active workspace running `command`, by splitting the focused leaf
 * (same mutation the UI's split does, so the result is an ordinary persisted pane). Returns
 * the pane's final name — the requested one if free, else a freshly allocated pool name.
 */
export function spawnPane(opts: { title?: string; command: string; cwd?: string }): { name: string; paneId: PaneId } | { error: string } {
  const i = wsIdxById(app.activeId);
  if (i < 0) return { error: "no active workspace" };
  const ws = app.workspaces[i];
  const target = ws.focused ?? firstLeaf(ws.tree);
  const newId = nextPaneId();
  const taken = Object.values(ws.panes).map((p) => p.title);
  const requested = opts.title?.trim();
  const title = requested && !taken.includes(requested) ? requested : allocName(taken);
  const newTree = replaceLeaf(ws.tree, target, (leaf) => ({
    kind: "split", dir: "row", ratio: 0.5, a: leaf, b: { kind: "leaf", paneId: newId },
  }));
  const spec: PaneSpec = opts.cwd ? { title, command: opts.command, cwd: opts.cwd } : { title, command: opts.command };
  batch(() => {
    setApp("workspaces", i, "panes", newId, spec);
    setApp("workspaces", i, "tree", newTree);
    setApp("workspaces", i, "focused", newId);
    setApp("workspaces", i, "zoomed", null);
  });
  return { name: title, paneId: newId };
}

/** Open a past Claude conversation in a new pane in the active workspace, resuming it via
 *  `claude --resume <id>` in its original folder. The pane persists that command, so later app
 *  restarts resume it too (the resume flag is user-explicit, so the session-id manager leaves it). */
export function openClaudeSession(id: string, cwd?: string): { name: string } | { error: string } {
  return spawnPane({ command: `claude --resume ${id}`, cwd });
}

// ---- Workspace operations -----------------------------------------------------------

function recordRecent(cwd: string, count: number) {
  if (!cwd.trim()) return;
  const others = app.recents.filter((r) => r.cwd !== cwd);
  setApp("recents", [{ cwd, count }, ...others].slice(0, 8));
}

export function createWorkspace(opts: NewWorkspaceOpts): string {
  const ws = buildWorkspace(opts);
  batch(() => {
    setApp("workspaces", app.workspaces.length, ws);
    setApp("activeId", ws.id);
    recordRecent(opts.cwd, opts.paneCount);
  });
  return ws.id;
}

export function switchWorkspace(id: string) {
  setApp("activeId", id);
}

/** Which docked side panel is open in the active workspace (null = none). */
export const activePanel = (): DockedPanelKind | null => activeWorkspace()?.panel.open ?? null;

/** Open `kind` (or null to close) as the active workspace's docked panel — mutually exclusive. */
export function setActivePanel(kind: DockedPanelKind | null) {
  const i = wsIdxById(app.activeId);
  if (i >= 0) setApp("workspaces", i, "panel", "open", kind);
}

/** Pin the source folder captured (from the active terminal) when Source Control / Docs opened. */
export function setPanelCwd(kind: "git" | "docs", cwd: string) {
  const i = wsIdxById(app.activeId);
  if (i >= 0) setApp("workspaces", i, "panel", kind === "git" ? "gitCwd" : "docsCwd", cwd);
}

/** Jump directly to the workspace at position `i` (0-based) — Ctrl+Shift+1…9. No-op out of range. */
export function switchWorkspaceIndex(i: number) {
  if (i >= 0 && i < app.workspaces.length) setApp("activeId", app.workspaces[i].id);
}

/**
 * Clone a workspace into a fresh one (fresh PaneIds → fresh PTYs) keeping the exact split tree,
 * gutter ratios, and each pane's spec (command/cwd/env/title). The new workspace is appended and
 * made active; its panes respawn their commands like any launch. Returns the new id.
 */
export function duplicateWorkspace(id: string): string | undefined {
  const src = app.workspaces.find((w) => w.id === id);
  if (!src) return;
  const { tree, panes } = cloneTreeWithFreshPanes(src.tree, src.panes);
  const ws: WorkspaceUI = {
    id: nextWsId(),
    name: `${src.name} copy`,
    cwd: src.cwd,
    tree,
    panes,
    focused: firstLeaf(tree),
    zoomed: null,
    panel: freshPanel(),
  };
  batch(() => {
    setApp("workspaces", app.workspaces.length, ws);
    setApp("activeId", ws.id);
  });
  return ws.id;
}

/** Switch to the next (+1) / previous (-1) workspace, wrapping (Ctrl+Shift+PageUp/Down). */
export function switchWorkspaceRelative(delta: number) {
  const n = app.workspaces.length;
  if (n <= 1) return;
  const cur = wsIdxById(app.activeId);
  const next = ((cur + delta) % n + n) % n;
  setApp("activeId", app.workspaces[next].id);
}

export function closeWorkspace(id: string) {
  const i = wsIdxById(id);
  if (i < 0 || app.workspaces.length === 1) return; // keep at least one workspace
  if (settings.confirmClose) {
    const live = countLive(leafIds(app.workspaces[i].tree));
    if (live > 0 && !window.confirm(
      `Close "${app.workspaces[i].name}"? ${live} running terminal${live === 1 ? "" : "s"} will be killed.`,
    )) return;
  }
  // Capture the layout (tree + specs, incl. Claude sessionIds) so the whole workspace can be reopened.
  const closing = app.workspaces[i];
  recordClosed({ kind: "workspace", title: closing.name, cwd: closing.cwd, tree: snapshotValue(closing.tree), panes: snapshotValue(closing.panes) });
  const remaining = app.workspaces.filter((w) => w.id !== id);
  forgetBoard(id); // drop the closed workspace's blackboard (§2b) — it's scoped to this ws
  forgetClaims(id); // and its file claims (§2c)
  batch(() => {
    setApp("workspaces", remaining);
    if (app.activeId === id) setApp("activeId", remaining[Math.min(i, remaining.length - 1)].id);
  });
}

// ---- Reopen history (recently closed panes/workspaces) -------------------------------

/** Reactive view of the reopen history (newest-first). */
export const closedItems = (): ClosedItem[] => app.closed;

/** Reopen a closed pane into the active workspace by splitting the focused leaf — keeping its
 *  command/cwd/shell/env and its `sessionId`, so a Claude pane resumes its conversation. */
function reopenPaneItem(item: ClosedItem) {
  if (!item.spec) return;
  const i = wsIdxById(app.activeId);
  if (i < 0) return;
  const ws = app.workspaces[i];
  const target = ws.focused ?? firstLeaf(ws.tree);
  const newId = nextPaneId();
  const taken = Object.values(ws.panes).map((p) => p.title);
  const title = item.spec.title && !taken.includes(item.spec.title) ? item.spec.title : allocName(taken);
  const spec: PaneSpec = { ...snapshotValue(item.spec), title };
  const newTree = replaceLeaf(ws.tree, target, (leaf) => ({
    kind: "split", dir: "row", ratio: 0.5, a: leaf, b: { kind: "leaf", paneId: newId },
  }));
  batch(() => {
    setApp("workspaces", i, "panes", newId, spec);
    setApp("workspaces", i, "tree", newTree);
    setApp("workspaces", i, "focused", newId);
    setApp("workspaces", i, "zoomed", null);
  });
}

/** Reopen a closed workspace, rebuilding its layout faithfully and *resuming* its Claude panes
 *  (keepSession) — unlike duplicate/preset, which start fresh. Appended + made active. */
function reopenWorkspaceItem(item: ClosedItem) {
  if (!item.tree || !item.panes) return;
  createWorkspace({ name: item.title, cwd: item.cwd, paneCount: 0, tree: item.tree, panes: item.panes, keepSession: true });
}

/** Reopen the closed pane/workspace `id`, then drop it from the history (it's live again). */
export function reopenClosed(id: string) {
  const item = app.closed.find((c) => c.id === id);
  if (!item) return;
  if (item.kind === "pane") reopenPaneItem(item);
  else reopenWorkspaceItem(item);
  setApp("closed", app.closed.filter((c) => c.id !== id));
}

/** Reopen the most recently closed item (the `reopen-closed` shortcut). No-op when empty. */
export function reopenLastClosed() {
  const first = app.closed[0];
  if (first) reopenClosed(first.id);
}

/** Forget the whole reopen history. */
export function clearClosedHistory() {
  setApp("closed", []);
}

/** Set overview ("fleet glance") mode on/off. */
export function setOverview(on: boolean) {
  setApp("overview", on);
}

/** Toggle overview mode (Ctrl+Shift+O). */
export function toggleOverview() {
  setApp("overview", (v) => !v);
}

/**
 * The PaneIds a broadcast should reach in `ws`, in row-major order: every pane in the workspace.
 * This is the agent-facing fan-out target for the inter-pane control bus (`loom broadcast` and the
 * MCP `broadcast` tool, ADR-0007) — there is no human broadcast UI. Liveness is the registry's
 * call at send time, so dead panes are simply skipped there.
 */
export function broadcastTargets(ws: WorkspaceUI): PaneId[] {
  return leafIds(ws.tree);
}

// ---- Presets (saved workspace templates) --------------------------------------------

/** Snapshot the active workspace as a relaunchable preset: the full split tree + per-pane specs
 *  (so the hand-tuned layout, gutter ratios, and per-pane cwd round-trip), plus cwd + paneCount +
 *  commands for display and older-style fallback. The tree/panes are deep-copied so later edits to
 *  the live workspace don't mutate the saved preset. */
export function saveCurrentAsPreset(): Preset | undefined {
  const ws = activeWorkspace();
  if (!ws) return;
  const order = leafIds(ws.tree);
  const commands = order.map((id) => ws.panes[id]?.command);
  const preset: Preset = {
    id: nextPresetId(),
    name: ws.name,
    cwd: ws.cwd,
    paneCount: order.length,
    commands: commands.some(Boolean) ? commands : undefined,
    tree: JSON.parse(JSON.stringify(ws.tree)) as LayoutNode,
    panes: JSON.parse(JSON.stringify(ws.panes)) as Record<PaneId, PaneSpec>,
  };
  // Replace a same-name preset rather than piling up duplicates.
  const others = app.presets.filter((p) => p.name !== preset.name);
  setApp("presets", [preset, ...others].slice(0, 24));
  return preset;
}

/** Create + activate a fresh workspace from a saved preset — rebuilding the captured layout
 *  verbatim when present, else (older presets) a balanced grid from paneCount + commands. */
export function launchPreset(preset: Preset): string {
  return createWorkspace({
    name: preset.name,
    cwd: preset.cwd,
    paneCount: preset.paneCount,
    commands: preset.commands,
    tree: preset.tree,
    panes: preset.panes,
  });
}

export function deletePreset(id: string) {
  setApp("presets", (ps) => ps.filter((p) => p.id !== id));
}

// ---- Persistence (JSON, app config dir) ---------------------------------------------
// Persist intent (layout + per-pane spec), never live scrollback — on restart we rebuild
// the trees and respawn each pane's command in its cwd (PLAN "Persist intent, not scrollback").

/** The serialized shape: persisted Workspace fields only (focus/zoom are ephemeral). */
interface PersistedRoot {
  activeId: string;
  workspaces: Workspace[];
}

function snapshot(): PersistedRoot {
  return {
    activeId: app.activeId,
    workspaces: app.workspaces.map((w) => ({ id: w.id, name: w.name, cwd: w.cwd, tree: w.tree, panes: w.panes })),
  };
}

function allPaneIds(workspaces: Workspace[]): number[] {
  const ids: number[] = [];
  const walk = (n: LayoutNode) => {
    if (n.kind === "leaf") ids.push(n.paneId);
    else { walk(n.a); walk(n.b); }
  };
  workspaces.forEach((w) => walk(w.tree));
  return ids;
}

/** Load persisted workspaces/recents (or seed a default Home). Call once before rendering. */
export async function init() {
  let restored = false;
  try {
    const raw = await loadState("workspaces");
    if (raw) {
      const data = JSON.parse(raw) as PersistedRoot;
      if (data.workspaces?.length) {
        // Resume the id counters past anything persisted so new panes/workspaces don't collide.
        idSeq = Math.max(0, ...allPaneIds(data.workspaces));
        wsSeq = Math.max(0, ...data.workspaces.map((w) => parseInt(w.id.replace(/\D/g, ""), 10) || 0));
        const workspaces = data.workspaces.map((w) => ({ ...w, focused: firstLeaf(w.tree), zoomed: null, panel: freshPanel() }));
        const activeId = workspaces.some((w) => w.id === data.activeId) ? data.activeId : workspaces[0].id;
        setApp({ workspaces, activeId });
        restored = true;
      }
    }
    const recRaw = await loadState("recents");
    if (recRaw) setApp("recents", JSON.parse(recRaw) as RecentFolder[]);
    const psRaw = await loadState("presets");
    if (psRaw) {
      const ps = JSON.parse(psRaw) as Preset[];
      presetSeq = Math.max(0, ...ps.map((p) => parseInt(p.id.replace(/\D/g, ""), 10) || 0));
      setApp("presets", ps);
    }
    const clRaw = await loadState("closed");
    if (clRaw) {
      const cl = JSON.parse(clRaw) as ClosedItem[];
      closedSeq = Math.max(0, ...cl.map((c) => parseInt(c.id.replace(/\D/g, ""), 10) || 0));
      setApp("closed", cl);
    }
  } catch (e) {
    console.error("failed to load persisted state", e);
  }
  if (!restored) {
    const home = buildWorkspace({ name: "Home", cwd: "", paneCount: 4 });
    setApp({ workspaces: [home], activeId: home.id });
  }
}

// The most recent serialized state, kept current by the persistence effect so a flush (e.g.
// on app close) writes the latest values without waiting on the debounce.
let pendingTimer: ReturnType<typeof setTimeout> | undefined;
let latest = { ws: "", rec: "", ps: "", cl: "" };
let dirty = false;

/** Autosave workspaces + recents (debounced) on any change. Call once, inside a root owner. */
export function startPersistence() {
  createEffect(() => {
    // Stringify inside the effect so every nested change (ratio, split, rename…) is tracked.
    latest = {
      ws: JSON.stringify(snapshot()),
      rec: JSON.stringify(app.recents),
      ps: JSON.stringify(app.presets),
      cl: JSON.stringify(app.closed),
    };
    dirty = true;
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => { void flushPersistence(); }, 400);
  });
  onCleanup(() => clearTimeout(pendingTimer));
}

/** Write the latest snapshot immediately. Call before the window closes so no debounced change is lost. */
export async function flushPersistence(): Promise<void> {
  clearTimeout(pendingTimer);
  if (!dirty) return;
  dirty = false;
  await Promise.all([
    saveState("workspaces", latest.ws),
    saveState("recents", latest.rec),
    saveState("presets", latest.ps),
    saveState("closed", latest.cl),
  ]);
}
