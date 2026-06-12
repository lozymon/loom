// Session-log viewer (IDEAS #10): an in-app reader for the opt-in per-pane logs that
// settings.sessionLogging records under <config>/logs/. Review what an agent did without
// re-running it. Left: the log files (newest first); right: the tail of the selected one, with
// ANSI escapes stripped to plain text. Read-only — the user explicitly opened a file they chose to
// record, so this doesn't violate ADR-0001 (we never parse live pane output for product logic).

import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { listLogs, readLogTail, type LogEntry } from "../lib/logsClient";
import { stripAnsi } from "../lib/ansi";

/** How much of a (possibly huge) log to pull from the tail. */
const TAIL_BYTES = 256 * 1024;

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function splitName(name: string): { dir: string; base: string } {
  const stem = name.replace(/\.log$/, "");
  const i = stem.lastIndexOf("-");
  return i < 0 ? { dir: "", base: stem } : { dir: stem.slice(0, i), base: stem.slice(i + 1) };
}

export default function SessionLogViewer(props: { onClose: () => void; preselectPath?: string | null }) {
  const [logs, setLogs] = createSignal<LogEntry[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [selected, setSelected] = createSignal<string | null>(null);
  const [tail, setTail] = createSignal("");
  const [truncated, setTruncated] = createSignal(false);
  const [readErr, setReadErr] = createSignal<string | null>(null);
  let view: HTMLPreElement | undefined;

  const selectedEntry = createMemo(() => logs().find((l) => l.path === selected()) ?? null);

  async function read(path: string) {
    setReadErr(null);
    setTail("");
    try {
      const t = await readLogTail(path, TAIL_BYTES);
      setTail(stripAnsi(t.text));
      setTruncated(t.truncated);
      // Jump to the end — the most recent output is what you want first.
      queueMicrotask(() => { if (view) view.scrollTop = view.scrollHeight; });
    } catch (e) {
      setReadErr(String(e));
    }
  }

  function open(path: string) {
    setSelected(path);
    void read(path);
  }

  async function refresh() {
    setLoading(true);
    try {
      const list = await listLogs();
      setLogs(list);
      const keep = selected();
      if (keep && list.some((l) => l.path === keep)) void read(keep);
      else if (props.preselectPath) open(props.preselectPath);
      else if (list.length > 0) open(list[0].path);
    } catch (e) {
      setReadErr(String(e));
    } finally {
      setLoading(false);
    }
  }

  onMount(refresh);

  // Capture phase so Escape closes even while a terminal holds focus (xterm swallows it otherwise).
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") props.onClose(); };
  onMount(() => window.addEventListener("keydown", onKey, true));
  onCleanup(() => window.removeEventListener("keydown", onKey, true));

  const fileRow = (log: LogEntry) => {
    const { dir, base } = splitName(log.name);
    return (
      <button
        class="git-file"
        classList={{ on: selected() === log.path }}
        onClick={() => open(log.path)}
        title={log.path}
      >
        <span class="git-file-name">
          <span class="git-file-base">{base}</span>
          <Show when={dir}>
            <span class="git-file-dir">{dir}</span>
          </Show>
        </span>
        <span class="git-file-badge" data-s="L">{fmtSize(log.size)}</span>
      </button>
    );
  };

  return (
    <div class="settings-backdrop" onClick={() => props.onClose()}>
      <div class="git-panel" onClick={(e) => e.stopPropagation()}>
        <header class="settings-head">
          <span class="settings-title">≣ Session logs</span>
          <span class="git-head-actions">
            <button class="settings-btn" title="Refresh" onClick={() => void refresh()}>⟳ Refresh</button>
            <button class="settings-x" title="Close (Esc)" onClick={() => props.onClose()}>✕</button>
          </span>
        </header>

        <div class="git-body">
          <aside class="git-files">
            <Show
              when={!loading()}
              fallback={<div class="git-empty">Loading…</div>}
            >
              <Show when={logs().length === 0}>
                <div class="git-empty">
                  No session logs yet.
                  <div class="git-empty-sub">Enable “Session logging” in Settings to record pane output.</div>
                </div>
              </Show>
              <Show when={logs().length > 0}>
                <div class="git-group-head">Logs <span class="git-count">{logs().length}</span></div>
                <For each={logs()}>{(l) => fileRow(l)}</For>
              </Show>
            </Show>
          </aside>

          <section class="git-diff">
            <Show
              when={selected()}
              fallback={<div class="git-empty">{logs().length > 0 ? "Select a log to read it." : ""}</div>}
            >
              <div class="git-diff-path">
                <span>{selectedEntry()?.name ?? selected()}</span>
                <span class="git-diff-hint">
                  {selectedEntry() ? fmtSize(selectedEntry()!.size) : ""}{truncated() ? " · showing the last 256 KB" : ""}
                </span>
              </div>
              <Show when={readErr()}>
                <div class="git-empty">{readErr()}</div>
              </Show>
              <Show when={!readErr()}>
                <pre class="log-view" ref={view}>{tail() || "(empty)"}</pre>
              </Show>
            </Show>
          </section>
        </div>
      </div>
    </div>
  );
}
