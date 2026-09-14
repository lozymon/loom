import type { HistoryHit } from "@loom/protocol";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { useHubList } from "../hub/hubList.ts";
import type { Hub } from "../hub/store.ts";
import { snippetParts } from "../lib/snippet.ts";

interface Result extends HistoryHit {
  hub: Hub;
  hubName: string;
}

const TYPE_LABEL: Record<string, string> = {
  "user.message": "message",
  "assistant.text": "reply",
  "tool.use": "tool",
  "approval.requested": "approval",
  speech: "said",
  error: "error",
  "session.renamed": "renamed",
};

/** History search across every connected hub (M12). Enter opens the first result. */
export function SearchDialog(props: { onClose(): void }) {
  const hubList = useHubList();
  const [query, setQuery] = createSignal("");
  const [results, setResults] = createSignal<Result[]>([]);
  const [busy, setBusy] = createSignal(false);
  const [problem, setProblem] = createSignal<string>();
  let input!: HTMLInputElement;
  let generation = 0;

  createEffect(() => {
    const q = query().trim();
    const gen = ++generation;
    if (!q) {
      setResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      setBusy(true);
      const open = hubList.hubs().filter((h) => h.hub.state.status.kind === "open");
      const settled = await Promise.allSettled(
        open.map(async (h) => (await h.hub.actions.searchHistory(q)).map((hit) => ({ ...hit, hub: h.hub, hubName: h.hub.state.hub?.name ?? "hub" }))),
      );
      if (gen !== generation) return;
      setBusy(false);
      const failed = settled.filter((s) => s.status === "rejected");
      setProblem(failed.length ? `${failed.length} hub${failed.length > 1 ? "s" : ""} could not search` : undefined);
      setResults(settled.flatMap((s) => (s.status === "fulfilled" ? s.value : [])).sort((a, b) => b.at - a.at).slice(0, 100));
    }, 250);
    onCleanup(() => clearTimeout(timer));
  });

  const openResult = (r: Result) => {
    props.onClose();
    void r.hub.actions.openAt(r.sessionId, r.seq);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") props.onClose();
  };
  window.addEventListener("keydown", onKey);
  onCleanup(() => window.removeEventListener("keydown", onKey));
  queueMicrotask(() => input.focus());

  const multipleHubs = () => hubList.hubs().length > 1;

  return (
    <div class="overlay" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <section class="dialog search-dialog" aria-label="Search history">
        <form
          class="search-form"
          onSubmit={(e) => {
            e.preventDefault();
            const first = results()[0];
            if (first) openResult(first);
          }}
        >
          <input ref={input} type="search" placeholder="Search what sessions said and did" value={query()} onInput={(e) => setQuery(e.currentTarget.value)} aria-label="Search history" />
          <button type="button" onClick={() => props.onClose()}>
            Close
          </button>
        </form>
        <Show when={problem()}>
          <p class="error-text small">{problem()}</p>
        </Show>
        <Show when={query().trim() && !busy() && results().length === 0}>
          <p class="muted">Nothing found.</p>
        </Show>
        <ul class="search-results">
          <For each={results()}>
            {(r) => (
              <li>
                <button class="search-result" onClick={() => openResult(r)}>
                  <span class="search-meta">
                    <strong>{r.sessionName}</strong>
                    <Show when={multipleHubs()}>
                      <span class="muted"> · {r.hubName}</span>
                    </Show>
                    <span class="badge">{TYPE_LABEL[r.type] ?? r.type}</span>
                    <span class="muted small">{new Date(r.at).toLocaleString()}</span>
                  </span>
                  <span class="search-snippet">
                    <For each={snippetParts(r.snippet)}>{(p) => (p.hit ? <mark>{p.text}</mark> : <span>{p.text}</span>)}</For>
                  </span>
                </button>
              </li>
            )}
          </For>
        </ul>
      </section>
    </div>
  );
}
