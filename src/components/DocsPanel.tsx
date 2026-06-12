// Docs panel (IDEAS #4): open a markdown file (README, a spec, an ADR), read it, drag-select a
// passage, optionally add an instruction, and send the raw selection into a pane — exactly the
// gesture the Source Control panel gives for diff lines, only the content source is a file instead
// of a `git diff`. The send target is the focused pane or, toggled, the broadcast targets ("all of
// you read this"). Opened from the title bar's 📖 button or Ctrl+Shift+R.
//
// Plain-text + drag-select rendering (matches GitPanel's line gesture 1:1); we send the *raw*
// markdown of the selection — the agent wants the source, not rendered prose. Strictly read-only.

import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { open } from "@tauri-apps/plugin-dialog";
import { activeWorkspace, broadcastTargets } from "../stores/workspace";
import { countLive, paneCwd, writeToPanes } from "../lib/paneRegistry";
import { listDocs, readDoc, type DocEntry } from "../lib/docsClient";

/** Split a relative path into a dimmed directory + a bold basename (VSCode-style, like GitPanel). */
function splitPath(path: string): { dir: string; base: string } {
  const i = path.lastIndexOf("/");
  return i < 0 ? { dir: "", base: path } : { dir: path.slice(0, i), base: path.slice(i + 1) };
}

/** A synthetic entry for a file picked via the native dialog (outside the scanned folder). Its
 *  `rel` is the full path — a real locator for the agent, since it's outside the workspace root. */
function entryForPath(path: string): DocEntry {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return { path, rel: path, name: base };
}

export default function DocsPanel(props: { onClose: () => void }) {
  const ws = activeWorkspace();

  // The folder we scan for markdown: prefer the focused terminal's *live* cwd, else the
  // workspace's launch folder (same resolution as the Source Control panel).
  const [cwd, setCwd] = createSignal("");
  async function resolveCwd(): Promise<string> {
    const focused = ws?.focused ?? null;
    if (focused != null) {
      const live = (await paneCwd(focused))?.trim();
      if (live) return live;
    }
    return ws?.cwd?.trim() || "";
  }

  const [files, setFiles] = createSignal<DocEntry[]>([]);
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [selected, setSelected] = createSignal<DocEntry | null>(null);
  const [lines, setLines] = createSignal<string[]>([]);
  const [readError, setReadError] = createSignal<string | null>(null);

  // ---- line selection → send-to-terminal (a contiguous row range; drag or shift-click) ----
  const [anchor, setAnchor] = createSignal<number | null>(null);
  const [head, setHead] = createSignal<number | null>(null);
  const [instruction, setInstruction] = createSignal("");
  const [submitOnSend, setSubmitOnSend] = createSignal(true);
  // Fan the passage out to the broadcast targets instead of just the focused pane.
  const [toTargets, setToTargets] = createSignal(false);
  const [flash, setFlash] = createSignal<string | null>(null);
  let dragging = false;
  let flashTimer: ReturnType<typeof setTimeout> | undefined;

  const selRange = createMemo(() => {
    const a = anchor();
    const h = head();
    if (a == null || h == null) return null;
    return { lo: Math.min(a, h), hi: Math.max(a, h) };
  });
  const isRowSel = (i: number) => {
    const r = selRange();
    return !!r && i >= r.lo && i <= r.hi;
  };
  /** The selected passage: its raw text + 1-based line range + line count (null when empty). */
  const selMeta = createMemo(() => {
    const r = selRange();
    if (!r) return null;
    const text = lines().slice(r.lo, r.hi + 1).join("\n");
    return { text, start: r.lo + 1, end: r.hi + 1, count: r.hi - r.lo + 1 };
  });
  const rangeStr = (s: { start: number; end: number }) =>
    s.start === s.end ? `${s.start}` : `${s.start}-${s.end}`;

  /** Live panes the send will reach: the broadcast targets, or just the focused pane. */
  const targetIds = (): number[] => {
    if (toTargets()) {
      const w = activeWorkspace();
      return w ? broadcastTargets(w) : [];
    }
    const id = activeWorkspace()?.focused ?? null;
    return id != null ? [id] : [];
  };
  const liveReach = () => countLive(targetIds());

  function clearSelection() {
    setAnchor(null);
    setHead(null);
  }
  function rowDown(i: number, e: MouseEvent) {
    e.preventDefault(); // suppress native text drag-select; we own the gesture
    if (e.shiftKey && anchor() != null) setHead(i);
    else { setAnchor(i); setHead(i); }
    dragging = true;
  }
  const rowEnter = (i: number) => { if (dragging) setHead(i); };
  const endDrag = () => { dragging = false; };
  onMount(() => window.addEventListener("mouseup", endDrag));
  onCleanup(() => window.removeEventListener("mouseup", endDrag));

  function showFlash(msg: string) {
    clearTimeout(flashTimer);
    setFlash(msg);
    flashTimer = setTimeout(() => setFlash(null), 2200);
  }

  /** Send the selected passage (+ optional instruction) into the target pane(s) as raw markdown. */
  function sendToTerminal() {
    const sel = selMeta();
    if (!sel) return;
    const ids = targetIds();
    const rel = selected()?.rel ?? "";
    const instr = instruction().trim();
    let body = `${rel}:${rangeStr(sel)}\n\`\`\`markdown\n${sel.text}\n\`\`\``;
    if (instr) body += `\n${instr}`;
    // Bracketed paste so the multi-line block lands as one paste (not line-by-line Enters); an
    // optional trailing CR submits it so the agent acts on it immediately.
    const payload = `\x1b[200~${body}\x1b[201~` + (submitOnSend() ? "\r" : "");
    const n = writeToPanes(ids, payload);
    if (n > 0) {
      clearSelection();
      setInstruction("");
      props.onClose();
    } else {
      showFlash(toTargets() ? "no live target panes" : "no live terminal focused");
    }
  }

  async function openEntry(entry: DocEntry) {
    setSelected(entry);
    setLines([]);
    setReadError(null);
    clearSelection();
    try {
      const text = await readDoc(entry.path);
      // Normalise CRLF and drop a single trailing newline so the last row isn't a blank line.
      setLines(text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n"));
    } catch (e) {
      setReadError(String(e));
    }
  }

  /** Pick any markdown file via the native dialog (for files outside the scanned folder). */
  async function pickFile() {
    try {
      const picked = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "Markdown", extensions: ["md", "markdown", "mdx"] }],
      });
      if (typeof picked === "string") await openEntry(entryForPath(picked));
    } catch (e) {
      showFlash(String(e));
    }
  }

  async function refresh() {
    setLoading(true);
    setError(null);
    const dir = await resolveCwd();
    setCwd(dir);
    if (!dir) {
      setError("No working folder — focus a terminal or give this workspace a folder.");
      setLoading(false);
      return;
    }
    try {
      const list = await listDocs(dir);
      setFiles(list);
      // Keep the open file if it's still listed; otherwise open the first (README floats first).
      const keep = selected();
      const stillThere = keep && list.some((f) => f.path === keep.path);
      if (!stillThere && list.length > 0) await openEntry(list[0]);
      else if (list.length === 0) setSelected(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  onMount(refresh);

  // Capture phase: while a terminal has focus xterm swallows Escape (sends \x1b to the PTY), so a
  // bubble-phase listener never fires. Capturing intercepts it first (same as GitPanel).
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") props.onClose();
  };
  onMount(() => window.addEventListener("keydown", onKey, true));
  onCleanup(() => window.removeEventListener("keydown", onKey, true));

  const fileRow = (file: DocEntry) => {
    const { dir, base } = splitPath(file.rel);
    return (
      <button
        class="git-file"
        classList={{ on: selected()?.path === file.path }}
        onClick={() => void openEntry(file)}
        title={file.path}
      >
        <span class="git-file-name">
          <span class="git-file-base">{base}</span>
          <Show when={dir}>
            <span class="git-file-dir">{dir}</span>
          </Show>
        </span>
      </button>
    );
  };

  return (
    <div class="settings-backdrop" onClick={() => props.onClose()}>
      <div class="git-panel" onClick={(e) => e.stopPropagation()}>
        <header class="settings-head">
          <span class="settings-title">
            📖 Docs
            <Show when={cwd()}>
              <span class="git-cwd" title={cwd()}>{cwd()}</span>
            </Show>
          </span>
          <span class="git-head-actions">
            <button class="settings-btn" title="Open a file…" onClick={() => void pickFile()}>
              ＋ Open file…
            </button>
            <button class="settings-btn" title="Refresh" onClick={() => void refresh()}>
              ⟳ Refresh
            </button>
            <button class="settings-x" title="Close (Esc)" onClick={() => props.onClose()}>✕</button>
          </span>
        </header>

        <div class="git-body">
          <aside class="git-files">
            <Show
              when={!loading() && !error()}
              fallback={
                <div class="git-empty">
                  <Show when={loading()}>Loading…</Show>
                  <Show when={!loading() && error()}>{error()}</Show>
                </div>
              }
            >
              <Show when={files().length === 0}>
                <div class="git-empty">
                  No markdown here.
                  <div class="git-empty-sub">Use “Open file…” to pick one anywhere.</div>
                </div>
              </Show>
              <Show when={files().length > 0}>
                <div class="git-group-head">Markdown <span class="git-count">{files().length}</span></div>
                <For each={files()}>{(f) => fileRow(f)}</For>
              </Show>
            </Show>
          </aside>

          <section class="git-diff">
            <Show
              when={selected()}
              fallback={<div class="git-empty">Select a file to read it.</div>}
            >
              <div class="git-diff-path">
                <span>{selected()!.rel}</span>
                <span class="git-diff-hint">drag to select lines → send to a pane</span>
              </div>
              <Show when={readError()}>
                <div class="git-empty">{readError()}</div>
              </Show>
              <Show when={!readError()}>
                <div class="docs-reader">
                  <For each={lines()}>
                    {(line, i) => (
                      <>
                        <div
                          class="git-ln"
                          classList={{ sel: isRowSel(i()) }}
                          onMouseDown={(e) => rowDown(i(), e)}
                          onMouseEnter={() => rowEnter(i())}
                        >{i() + 1}</div>
                        <div
                          class="docs-line"
                          classList={{ sel: isRowSel(i()) }}
                          onMouseDown={(e) => rowDown(i(), e)}
                          onMouseEnter={() => rowEnter(i())}
                        >{line || " "}</div>
                      </>
                    )}
                  </For>
                </div>
              </Show>

              <Show when={selMeta()}>
                <div class="git-send">
                  <span class="git-send-info">
                    {selMeta()!.count} line{selMeta()!.count === 1 ? "" : "s"}
                    <span class="git-send-loc"> · {selected()!.rel}:{rangeStr(selMeta()!)}</span>
                  </span>
                  <input
                    class="git-send-input"
                    placeholder="Add an instruction for the agent… (optional)"
                    value={instruction()}
                    onInput={(e) => setInstruction(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { e.preventDefault(); sendToTerminal(); }
                      else if (e.key === "Escape") { e.stopPropagation(); clearSelection(); }
                    }}
                  />
                  <label class="git-send-enter" title="Fan out to the broadcast targets instead of just the focused pane">
                    <input
                      type="checkbox"
                      checked={toTargets()}
                      onChange={(e) => setToTargets(e.currentTarget.checked)}
                    />
                    to targets
                  </label>
                  <label class="git-send-enter" title="Press Enter in the pane after pasting (submit)">
                    <input
                      type="checkbox"
                      checked={submitOnSend()}
                      onChange={(e) => setSubmitOnSend(e.currentTarget.checked)}
                    />
                    submit
                  </label>
                  <button
                    class="git-send-btn primary"
                    disabled={liveReach() === 0}
                    title={liveReach() === 0 ? "No live target pane" : `Send to ${liveReach()} pane${liveReach() === 1 ? "" : "s"}`}
                    onClick={sendToTerminal}
                  >
                    Send to {toTargets() ? `${liveReach()} pane${liveReach() === 1 ? "" : "s"}` : "terminal"} ▸
                  </button>
                  <button class="git-send-clear" title="Clear selection (Esc)" onClick={clearSelection}>✕</button>
                  <Show when={flash()}>
                    <span class="git-send-flash">{flash()}</span>
                  </Show>
                </div>
              </Show>
            </Show>
          </section>
        </div>
      </div>
    </div>
  );
}
