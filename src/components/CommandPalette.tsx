// Fuzzy command palette (Ctrl+Shift+P). One searchable list over every app action that makes
// sense globally — pane ops on the focused pane, workspace switching, and jump-to-pane-by-name
// (the fleet-navigation win: type a pane's name, land on it wherever it lives). Built fresh on
// open from the live store so the workspace/pane entries are current. Pure scoring lives in
// lib/matching (fuzzyScore), unit-tested separately.

import { createMemo, createSignal, For, onCleanup, onMount } from "solid-js";
import {
  activeWorkspace,
  appState,
  closePane,
  listPanes,
  revealPane,
  saveCurrentAsPreset,
  splitPane,
  switchWorkspace,
  switchWorkspaceRelative,
  toggleOverview,
  toggleZoom,
} from "../stores/workspace";
import { fuzzyScore } from "../lib/matching";
import { formatBinding, type ActionId } from "../lib/keybindings";
import { settings } from "../stores/settings";

interface Command {
  label: string;
  hint?: string;
  /** Formatted shortcut (e.g. "Ctrl+Shift+D") shown on the right, when the command has one. */
  key?: string;
  run: () => void;
}

/** The live shortcut for an action, formatted for display. */
const kb = (id: ActionId): string => formatBinding(settings.keybindings[id]);

export default function CommandPalette(props: {
  onClose: () => void;
  onNewWorkspace: () => void;
  onSettings: () => void;
  onGit: () => void;
  onDocs: () => void;
  onShortcuts: () => void;
}) {
  const [query, setQuery] = createSignal("");
  const [sel, setSel] = createSignal(0);
  let input: HTMLInputElement | undefined;

  /** The focused pane in the active workspace (target of pane-scoped commands), or null. */
  const focused = (): number | null => activeWorkspace()?.focused ?? null;

  // Built once per open (the component is mounted only while open), so the workspace/pane
  // lists reflect the moment the palette appeared — fresh enough without reactive churn.
  const commands = (): Command[] => {
    const list: Command[] = [
      { label: "New workspace", key: kb("new-workspace"), run: props.onNewWorkspace },
      { label: "Open settings", hint: "Preferences", run: props.onSettings },
      { label: "Open source control", key: kb("source-control"), run: props.onGit },
      { label: "Open docs reader", key: kb("docs"), run: props.onDocs },
      { label: "Keyboard shortcuts cheat-sheet", key: kb("shortcuts"), run: props.onShortcuts },
      { label: "Toggle overview (fleet glance)", key: kb("overview"), run: () => toggleOverview() },
      { label: "Save workspace as preset", run: () => saveCurrentAsPreset() },
      { label: "Next workspace", key: kb("next-workspace"), run: () => switchWorkspaceRelative(1) },
      { label: "Previous workspace", key: kb("prev-workspace"), run: () => switchWorkspaceRelative(-1) },
    ];
    const f = focused();
    if (f !== null) {
      list.push(
        { label: "Split focused pane right", key: kb("split-right"), run: () => splitPane(f, "row") },
        { label: "Split focused pane down", key: kb("split-down"), run: () => splitPane(f, "col") },
        { label: "Toggle zoom focused pane", key: kb("toggle-zoom"), run: () => toggleZoom(f) },
        { label: "Close focused pane", key: kb("close-pane"), run: () => closePane(f) },
      );
    }
    for (const w of appState.workspaces) {
      if (w.id === appState.activeId) continue;
      list.push({ label: `Switch to workspace: ${w.name}`, hint: "Workspace", run: () => switchWorkspace(w.id) });
    }
    for (const p of listPanes()) {
      // Workspace in front of the pane name so same-named panes across workspaces (Faye in
      // "Home" vs "code") are distinguishable — and searchable by workspace.
      list.push({ label: `Go to pane: ${p.workspace} / ${p.name}`, run: () => revealPane(p.paneId) });
    }
    return list;
  };

  const filtered = createMemo(() => {
    const q = query().trim();
    const scored = commands()
      .map((c) => ({ c, score: fuzzyScore(q, c.label) }))
      .filter((x): x is { c: Command; score: number } => x.score !== null);
    // Stable sort by score desc; an empty query keeps insertion order.
    if (q) scored.sort((a, b) => b.score - a.score);
    return scored.map((x) => x.c);
  });

  function run(cmd: Command | undefined) {
    if (!cmd) return;
    props.onClose();
    cmd.run();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") { e.preventDefault(); props.onClose(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, filtered().length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); run(filtered()[sel()]); }
  }

  onMount(() => {
    queueMicrotask(() => input?.focus());
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => window.removeEventListener("keydown", onKey, true));
  });

  return (
    <div class="palette-overlay" onPointerDown={() => props.onClose()}>
      <div class="palette" onPointerDown={(e) => e.stopPropagation()}>
        <input
          ref={input}
          class="palette-input"
          placeholder="Type a command or pane name…"
          value={query()}
          onInput={(e) => { setQuery(e.currentTarget.value); setSel(0); }}
        />
        <div class="palette-list">
          <For each={filtered()} fallback={<div class="palette-empty">No matches</div>}>
            {(cmd, i) => (
              <div
                class="palette-item"
                classList={{ sel: i() === sel() }}
                onPointerEnter={() => setSel(i())}
                onClick={() => run(cmd)}
              >
                <span class="palette-label">{cmd.label}</span>
                {cmd.key
                  ? <span class="palette-key">{cmd.key}</span>
                  : cmd.hint && <span class="palette-hint">{cmd.hint}</span>}
              </div>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}
