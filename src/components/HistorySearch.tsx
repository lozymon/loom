// Cross-session agent history search (Phase 2, ADR-0009). A centered overlay (reusing the command
// palette's shell) over the SQLite session/task log: type to search task titles + approval prompts
// across every session ever recorded, or see recent activity when the box is empty. Read-only — it
// answers "what did my agents do / when did I last touch X?" The live store stays the source of
// truth for the running fleet; this is the durable history behind it.

import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { recentTasks, searchTasks, type TaskHit } from "../lib/sessionLogClient";
import { AGENTS } from "../lib/agents";
import { ago } from "../lib/time";

const agentById = (id: string) => AGENTS.find((a) => a.id === id) ?? null;

export default function HistorySearch(props: { onClose: () => void }) {
  const [query, setQuery] = createSignal("");
  const [hits, setHits] = createSignal<TaskHit[]>([]);
  let input: HTMLInputElement | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function run(q: string) {
    try {
      setHits(q.trim() ? await searchTasks(q.trim(), 200) : await recentTasks(100));
    } catch {
      setHits([]); // history DB unavailable — show empty rather than disrupt
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      props.onClose();
    }
  }

  onMount(() => {
    queueMicrotask(() => input?.focus());
    void run("");
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => window.removeEventListener("keydown", onKey, true));
  });

  // Debounced re-query as you type.
  createEffect(() => {
    const q = query();
    clearTimeout(timer);
    timer = setTimeout(() => void run(q), 150);
  });
  onCleanup(() => clearTimeout(timer));

  return (
    <div class="palette-overlay" onPointerDown={() => props.onClose()}>
      <div class="palette history-palette" onPointerDown={(e) => e.stopPropagation()}>
        <div class="palette-head">
          <span class="palette-glyph">⏱</span>
          <input
            ref={input}
            class="palette-input"
            placeholder="Search agent history — task titles & prompts…"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
          <kbd class="palette-esc">esc</kbd>
        </div>
        <div class="palette-list">
          <div class="palette-section">
            {query().trim() ? "MATCHES" : "RECENT"} · {hits().length}
          </div>
          <Show
            when={hits().length > 0}
            fallback={<div class="palette-empty">No history{query().trim() ? " matches" : " yet"}.</div>}
          >
            <For each={hits()}>
              {(h) => {
                const a = agentById(h.agentId);
                return (
                  <div class="history-row">
                    <span class="history-agent" style={a ? { "--agent-color": a.color } : undefined}>
                      {a?.icon ?? "•"}
                    </span>
                    <span class="history-title" title={h.title}>{h.title}</span>
                    <span class="history-state" data-state={h.state}>{h.state}</span>
                    <Show when={h.files.length}>
                      <span class="history-files" title={h.files.join("\n")}>{h.files.length}f</span>
                    </Show>
                    <span class="history-time">{ago(h.startedAt)}</span>
                  </div>
                );
              }}
            </For>
          </Show>
        </div>
      </div>
    </div>
  );
}
