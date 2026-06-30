// "Reopen" panel — a centered overlay (reusing the command-palette/history shell) that brings back
// closed work. Two sources, one search box:
//   1. Recently closed panes/workspaces (Loom-tracked, persisted) → reopen, resuming Claude panes.
//   2. Any past Claude conversation on disk (~/.claude/projects) → open via `claude --resume <id>`.
// Read-only discovery; nothing here parses pane output (ADR-0001). See stores/workspace.ts and
// lib/claudeSessions.ts.

import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { closedItems, reopenClosed, openClaudeSession, type ClosedItem } from "../stores/workspace";
import { listClaudeSessions, type ClaudeSession } from "../lib/claudeSessions";
import { AGENTS, detectAgent } from "../lib/agents";
import { ago } from "../lib/time";

const claudeDef = AGENTS.find((a) => a.id === "claude") ?? null;

/** Icon + accent for a closed item: the agent badge for a pane, a grid glyph for a workspace. */
function closedIcon(item: ClosedItem): { icon: string; color?: string } {
  if (item.kind === "workspace") return { icon: "▦" };
  const a = detectAgent(item.spec?.command);
  return a ? { icon: a.icon, color: a.color } : { icon: "❯" };
}

export default function ReopenPanel(props: { onClose: () => void }) {
  const [query, setQuery] = createSignal("");
  const [sessions, setSessions] = createSignal<ClaudeSession[]>([]);
  let input: HTMLInputElement | undefined;

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") { e.preventDefault(); props.onClose(); }
  }

  onMount(() => {
    queueMicrotask(() => input?.focus());
    void listClaudeSessions().then(setSessions);
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => window.removeEventListener("keydown", onKey, true));
  });

  const match = (q: string, ...fields: (string | undefined)[]) =>
    !q || fields.some((f) => f?.toLowerCase().includes(q));

  const closed = createMemo(() => {
    const q = query().trim().toLowerCase();
    return closedItems().filter((c) => match(q, c.title, c.cwd, c.spec?.command));
  });
  const claude = createMemo(() => {
    const q = query().trim().toLowerCase();
    return sessions().filter((s) => match(q, s.title, s.cwd, s.id));
  });

  const reopen = (id: string) => { props.onClose(); reopenClosed(id); };
  const open = (s: ClaudeSession) => { props.onClose(); openClaudeSession(s.id, s.cwd); };

  return (
    <div class="palette-overlay" onPointerDown={() => props.onClose()}>
      <div class="palette history-palette" onPointerDown={(e) => e.stopPropagation()}>
        <div class="palette-head">
          <span class="palette-glyph">↺</span>
          <input
            ref={input}
            class="palette-input"
            placeholder="Reopen a closed pane/workspace, or resume any Claude session…"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
          <kbd class="palette-esc">esc</kbd>
        </div>
        <div class="palette-list">
          <div class="palette-section">RECENTLY CLOSED · {closed().length}</div>
          <Show
            when={closed().length > 0}
            fallback={<div class="palette-empty">Nothing closed{query().trim() ? " matches" : " recently"}.</div>}
          >
            <For each={closed()}>
              {(c) => {
                const ic = closedIcon(c);
                return (
                  <div class="history-row" onClick={() => reopen(c.id)}>
                    <span class="history-agent" style={ic.color ? { "--agent-color": ic.color } : undefined}>{ic.icon}</span>
                    <span class="history-title" title={c.cwd}>{c.title}</span>
                    <span class="history-state" data-state={c.kind === "workspace" ? "running" : "idle"}>{c.kind}</span>
                    <span class="history-time">{ago(c.closedAt)}</span>
                  </div>
                );
              }}
            </For>
          </Show>

          <div class="palette-section">CLAUDE SESSIONS · {claude().length}</div>
          <Show
            when={claude().length > 0}
            fallback={<div class="palette-empty">No Claude sessions{query().trim() ? " match" : " found"}.</div>}
          >
            <For each={claude()}>
              {(s) => (
                <div class="history-row" onClick={() => open(s)}>
                  <span class="history-agent" style={claudeDef ? { "--agent-color": claudeDef.color } : undefined}>{claudeDef?.icon ?? "✦"}</span>
                  <span class="history-title" title={`${s.title}\n${s.cwd}\n${s.id}`}>{s.title || s.id.slice(0, 8)}</span>
                  <span class="history-files" title={s.cwd}>{s.cwd.split("/").pop() || s.cwd}</span>
                  <span class="history-time">{s.modified ? ago(s.modified * 1000) : ""}</span>
                </div>
              )}
            </For>
          </Show>
        </div>
      </div>
    </div>
  );
}
