// Session-log viewer (IDEAS #10): an in-app reader for the opt-in per-pane logs that
// settings.sessionLogging records under <config>/logs/. Review what an agent did without
// re-running it. Left: the log files (newest first); right: the tail of the selected one, with
// ANSI escapes stripped to plain text. Read-only — the user explicitly opened a file they chose to
// record, so this doesn't violate ADR-0001 (we never parse live pane output for product logic).

import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { listLogs, readLogTail, exportMarkdown, logToMarkdown, type LogEntry } from "../lib/logsClient";
import { stripAnsi } from "../lib/ansi";
import { audit, clearAudit } from "../stores/audit";
import { writeClipboard } from "../lib/clipboard";
import { save } from "@tauri-apps/plugin-dialog";

/** hh:mm:ss for the bus timeline (epoch-ms → local wall-clock). */
function fmtClock(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

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
  // Which tab: the durable per-pane logs, or the live bus-command audit timeline (§3).
  const [mode, setMode] = createSignal<"logs" | "bus">("logs");
  // Transient export confirmation ("Copied" / "Saved …"), auto-cleared.
  const [exportMsg, setExportMsg] = createSignal("");
  let view: HTMLPreElement | undefined;

  const selectedEntry = createMemo(() => logs().find((l) => l.path === selected()) ?? null);

  function flashExport(msg: string) {
    setExportMsg(msg);
    setTimeout(() => setExportMsg(""), 2600);
  }

  /** Copy the selected transcript to the clipboard as Markdown (a quick, paste-anywhere export). */
  async function copyMarkdown() {
    const e = selectedEntry();
    if (!e) return;
    await writeClipboard(logToMarkdown(e, tail()));
    flashExport("Copied");
  }

  /** Save the selected transcript to a Markdown file the user picks — the shareable artifact (§3b). */
  async function saveMarkdown() {
    const e = selectedEntry();
    if (!e) return;
    try {
      const path = await save({ defaultPath: `${e.name}.md`, filters: [{ name: "Markdown", extensions: ["md"] }] });
      if (!path) return; // cancelled
      await exportMarkdown(path, logToMarkdown(e, tail()));
      flashExport("Saved");
    } catch (err) {
      flashExport(`Export failed: ${String(err)}`);
    }
  }

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
      <div class="dialog log-dialog" onClick={(e) => e.stopPropagation()}>
        <header class="dialog-head">
          <span class="dialog-title">≣ {mode() === "logs" ? "Session logs" : "Bus activity"}</span>
          <span class="log-tabs">
            <button class="log-tab" classList={{ on: mode() === "logs" }} onClick={() => setMode("logs")}>Logs</button>
            <button class="log-tab" classList={{ on: mode() === "bus" }} onClick={() => setMode("bus")}>
              Bus activity<Show when={audit.entries.length > 0}><span class="git-count">{audit.entries.length}</span></Show>
            </button>
          </span>
          <span class="git-head-actions">
            <Show when={mode() === "logs"} fallback={<button class="settings-btn" title="Clear the timeline" onClick={() => clearAudit()}>⌫ Clear</button>}>
              <button class="settings-btn" title="Refresh" onClick={() => void refresh()}>⟳ Refresh</button>
            </Show>
            <button class="settings-x" title="Close (Esc)" onClick={() => props.onClose()}>✕</button>
          </span>
        </header>

        {/* Bus-command audit timeline (§3): every inter-pane control request, newest last. */}
        <Show when={mode() === "bus"}>
          <div class="bus-timeline">
            <Show when={audit.entries.length > 0} fallback={<div class="git-empty">No bus commands yet.<div class="git-empty-sub">Cross-pane commands (loom send / spawn / broadcast / role …) show here as they run.</div></div>}>
              <For each={[...audit.entries].reverse()}>
                {(e) => (
                  <div class="bus-row" classList={{ "bus-fail": !e.ok }}>
                    <span class="bus-time">{fmtClock(e.ts)}</span>
                    <span class="bus-op">{e.op}</span>
                    <span class="bus-target">{e.target ?? ""}</span>
                    <span class="bus-outcome" title={e.detail ?? ""}>{e.ok ? "✓" : `✗ ${e.detail ?? "failed"}`}</span>
                  </div>
                )}
              </For>
            </Show>
          </div>
        </Show>

        <Show when={mode() === "logs"}>
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
                {/* Export the transcript as a shareable markdown artifact (§3b). */}
                <span class="log-export">
                  <button class="settings-btn" title="Copy this transcript as Markdown" disabled={!!readErr()} onClick={() => void copyMarkdown()}>⧉ Copy MD</button>
                  <button class="settings-btn" title="Save this transcript as a Markdown file" disabled={!!readErr()} onClick={() => void saveMarkdown()}>⭳ Export…</button>
                  <Show when={exportMsg()}><span class="log-export-msg">{exportMsg()}</span></Show>
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
        </Show>
      </div>
    </div>
  );
}
