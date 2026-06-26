// Docs panel (IDEAS #4): open a markdown file (README, a spec, an ADR), read it, drag-select a
// passage, and send the raw selection into the focused pane — exactly the gesture the Source
// Control panel gives for diff lines, only the content source is a file instead of a `git diff`.
// The send target is the last active (focused) pane. Opened from the title bar's 📖 button or
// Ctrl+Shift+R.
//
// Plain-text + drag-select rendering (matches GitPanel's line gesture 1:1); we send the *raw*
// markdown of the selection — the agent wants the source, not rendered prose. Strictly read-only.

import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { open } from "@tauri-apps/plugin-dialog";
import { activeWorkspace, setPanelCwd } from "../stores/workspace";
import { countLive, paneCwd, writeToPanes } from "../lib/paneRegistry";
import { listDocs, readDoc, type DocEntry } from "../lib/docsClient";
import { parseMarkdownBlocks } from "../lib/markdown";
import { fuzzyScore } from "../lib/matching";
import { settings, setSetting } from "../stores/settings";

/** A synthetic entry for a file picked via the native dialog (outside the scanned folder). Its
 *  `rel` is the full path — a real locator for the agent, since it's outside the workspace root. */
function entryForPath(path: string): DocEntry {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return { path, rel: path, name: base };
}

export default function DocsPanel(props: { onClose: () => void }) {
  const ws = activeWorkspace();

  // The folder we scan for markdown. Captured from the active terminal *when Docs is opened* and
  // pinned to this workspace (panel.docsCwd), so each workspace keeps its own Docs source and it
  // stays put if you later cd or focus elsewhere (same model as the Source Control panel).
  const [cwd, setCwd] = createSignal("");
  async function resolveCwd(): Promise<string> {
    const focused = ws?.focused ?? null;
    if (focused != null) {
      const live = (await paneCwd(focused))?.trim();
      if (live) return live;
    }
    return ws?.cwd?.trim() || "";
  }

  /** Restore this workspace's pinned Docs folder, or capture+pin it from the active terminal now. */
  async function ensureCwd(): Promise<string> {
    const stored = ws?.panel.docsCwd?.trim() ?? "";
    const dir = stored || (await resolveCwd());
    if (dir && !stored) setPanelCwd("docs", dir);
    setCwd(dir);
    return dir;
  }

  const [files, setFiles] = createSignal<DocEntry[]>([]);
  // Filter box over the file list — fuzzy-match the display path so you can type a few letters of a
  // doc's name instead of scrolling a flat list. `hi` is the keyboard-highlighted row in the result.
  const [filter, setFilter] = createSignal("");
  const [hi, setHi] = createSignal(0);
  const filtered = createMemo(() => {
    const q = filter().trim();
    if (!q) return files();
    return files()
      .map((f) => ({ f, s: fuzzyScore(q, f.rel) }))
      .filter((x): x is { f: DocEntry; s: number } => x.s !== null)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.f);
  });
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [selected, setSelected] = createSignal<DocEntry | null>(null);
  const [content, setContent] = createSignal("");
  const lines = createMemo(() => (content() === "" ? [] : content().split("\n")));
  const blocks = createMemo(() => parseMarkdownBlocks(content()));
  const [readError, setReadError] = createSignal<string | null>(null);
  // Rendered preview vs. raw markdown text; persisted so the choice sticks across opens. Both
  // modes still *send* raw source — preview just selects whole blocks instead of single lines.
  const preview = () => settings.docsPreview;
  function setPreview(on: boolean) {
    if (on === preview()) return;
    clearSelection(); // row indices mean different things per mode (lines vs blocks)
    setSetting("docsPreview", on);
  }

  // ---- line selection → send-to-terminal (a contiguous row range; drag or shift-click) ----
  const [anchor, setAnchor] = createSignal<number | null>(null);
  const [head, setHead] = createSignal<number | null>(null);
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
  /** The selected row range expressed as 0-based *source* line indices: raw rows are lines
   *  directly; preview rows are blocks, so use each block's source span. Both modes send source. */
  const selLineRange = createMemo(() => {
    const r = selRange();
    if (!r) return null;
    if (!preview()) return { lo: r.lo, hi: r.hi };
    const bs = blocks();
    const a = bs[r.lo];
    const b = bs[r.hi];
    if (!a || !b) return null;
    return { lo: a.lo, hi: b.hi };
  });
  /** The selected passage: its raw text + 1-based line range + line count (null when empty). */
  const selMeta = createMemo(() => {
    const r = selLineRange();
    if (!r) return null;
    const text = lines().slice(r.lo, r.hi + 1).join("\n");
    return { text, start: r.lo + 1, end: r.hi + 1, count: r.hi - r.lo + 1 };
  });
  const rangeStr = (s: { start: number; end: number }) =>
    s.start === s.end ? `${s.start}` : `${s.start}-${s.end}`;

  /** The send goes to the last active (focused) pane, same as Source Control. */
  const targetIds = (): number[] => {
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

  // Drag the left edge to resize the panel width; clamp + persist (mirrors GitPanel).
  function onResizeDown(e: PointerEvent) {
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = settings.docsWidth;
    const move = (ev: PointerEvent) => {
      const w = Math.max(360, Math.min(1000, startW + (startX - ev.clientX)));
      setSetting("docsWidth", w);
    };
    const up = (ev: PointerEvent) => {
      handle.releasePointerCapture(ev.pointerId);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  // Drag the divider below the file list to re-split list vs. content height; clamp + persist.
  function onListResizeDown(e: PointerEvent) {
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startH = settings.docsListHeight;
    const move = (ev: PointerEvent) => {
      const h = Math.max(72, Math.min(640, startH + (ev.clientY - startY)));
      setSetting("docsListHeight", h);
    };
    const up = (ev: PointerEvent) => {
      handle.releasePointerCapture(ev.pointerId);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function showFlash(msg: string) {
    clearTimeout(flashTimer);
    setFlash(msg);
    flashTimer = setTimeout(() => setFlash(null), 2200);
  }

  /** Send the selected passage into the target pane(s) as raw markdown (one bracketed paste + submit). */
  function sendToTerminal() {
    const sel = selMeta();
    if (!sel) return;
    const ids = targetIds();
    const rel = selected()?.rel ?? "";
    const body = `${rel}:${rangeStr(sel)}\n\`\`\`markdown\n${sel.text}\n\`\`\``;
    // Bracketed paste so the multi-line block lands as one paste (not line-by-line Enters); the
    // trailing CR submits it so the agent acts on it immediately.
    const payload = `\x1b[200~${body}\x1b[201~\r`;
    const n = writeToPanes(ids, payload);
    if (n > 0) {
      // Stay open: this is an iterative workflow (read a doc, send passages as you discuss with the
      // agent). Just drop the selection and confirm the send so the next passage is one drag away.
      clearSelection();
      showFlash(`sent ${sel.count} line${sel.count === 1 ? "" : "s"} ▸`);
    } else {
      showFlash("no live terminal focused");
    }
  }

  async function openEntry(entry: DocEntry) {
    setSelected(entry);
    setContent("");
    setReadError(null);
    clearSelection();
    try {
      const text = await readDoc(entry.path);
      // Normalise CRLF and drop a single trailing newline so the last row isn't a blank line.
      setContent(text.replace(/\r\n/g, "\n").replace(/\n$/, ""));
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

  /** List the markdown under `dir` and show it; keep the open file if it survives, else open the first. */
  async function loadList(dir: string) {
    setLoading(true);
    setError(null);
    setHi(0);
    if (!dir) {
      setError("No working folder — focus a terminal or pick a folder.");
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

  /** Initial load: resolve+pin this workspace's Docs folder, then list it. */
  async function refresh() {
    await loadList(await ensureCwd());
  }

  /** Re-point the scanned folder via a native directory picker (re-pins this workspace's Docs cwd). */
  async function pickFolder() {
    try {
      const dir = await open({ multiple: false, directory: true });
      if (typeof dir === "string") {
        setPanelCwd("docs", dir);
        setCwd(dir);
        setFilter("");
        await loadList(dir);
      }
    } catch (e) {
      showFlash(String(e));
    }
  }

  onMount(refresh);

  // Capture phase: while a terminal has focus xterm swallows Escape (sends \x1b to the PTY), so a
  // bubble-phase listener never fires. Capturing intercepts it first (same as GitPanel). Escape
  // peels back state in the order you'd expect: an active filter, then a selection, then the panel.
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    if (filter()) { setFilter(""); setHi(0); }
    else if (selRange()) clearSelection();
    else props.onClose();
  };
  onMount(() => window.addEventListener("keydown", onKey, true));
  onCleanup(() => window.removeEventListener("keydown", onKey, true));

  // Arrow keys move the highlight through the (filtered) file list; Enter opens it — so you can
  // filter and open without leaving the keyboard.
  function onFilterKey(e: KeyboardEvent) {
    const list = filtered();
    if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(h + 1, Math.max(0, list.length - 1))); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); const f = list[hi()]; if (f) void openEntry(f); }
  }

  const fileRow = (file: DocEntry, idx: number) => (
    <button
      class="git-file"
      classList={{ on: selected()?.path === file.path, key: idx === hi() }}
      onClick={() => void openEntry(file)}
      title={file.path}
    >
      <span class="git-file-path">{file.rel}</span>
    </button>
  );

  return (
    <aside
      class="side-panel git-panel docs-panel git-scm"
      style={{ "flex-basis": `${settings.docsWidth}px`, width: `${settings.docsWidth}px` }}
    >
        <div class="git-resizer" title="Drag to resize" onPointerDown={onResizeDown} />
        <header class="git-head">
          <span class="git-title" title={cwd()}>Docs</span>
          <span class="docs-modes">
            <button classList={{ on: preview() }} onClick={() => setPreview(true)} title="Rendered markdown">Preview</button>
            <button classList={{ on: !preview() }} onClick={() => setPreview(false)} title="Raw markdown source (line-precise)">Raw</button>
          </span>
          <span class="git-head-actions">
            <button class="git-icon-btn" title="Scan a different folder…" onClick={() => void pickFolder()}>📂</button>
            <button class="git-icon-btn" title="Open a single file…" onClick={() => void pickFile()}>＋</button>
            <button class="git-icon-btn" title="Refresh" onClick={() => void refresh()}>↻</button>
            <button class="git-icon-btn" title="Close (Esc)" onClick={() => props.onClose()}>✕</button>
          </span>
        </header>

        <Show
          when={!loading() && !error()}
          fallback={
            <div class="git-empty git-empty-fill">
              <Show when={loading()}>Loading…</Show>
              <Show when={!loading() && error()}>{error()}</Show>
            </div>
          }
        >
          <Show when={files().length > 0}>
            <div class="docs-filter">
              <input
                class="docs-filter-input"
                type="text"
                placeholder="Filter files…"
                value={filter()}
                onInput={(e) => { setFilter(e.currentTarget.value); setHi(0); }}
                onKeyDown={onFilterKey}
              />
            </div>
          </Show>
          <div class="git-list" style={{ height: `${settings.docsListHeight}px` }}>
            <Show when={filtered().length === 0}>
              <div class="git-empty">
                <Show when={files().length === 0} fallback={<>No file matches “{filter()}”.</>}>
                  No markdown here.
                  <div class="git-empty-sub">Use the 📂 / ＋ buttons to scan a folder or open a file.</div>
                </Show>
              </div>
            </Show>
            <Show when={filtered().length > 0}>
              <div class="git-group-head">MARKDOWN · {filtered().length}</div>
              <For each={filtered()}>{(f, i) => fileRow(f, i())}</For>
            </Show>
          </div>

          <div class="git-list-resizer" title="Drag to resize" onPointerDown={onListResizeDown} />

          <section class="git-diff docs-content">
            <Show
              when={selected()}
              fallback={<div class="git-empty">Select a file to read it.</div>}
            >
              <Show when={readError()}>
                <div class="git-empty">{readError()}</div>
              </Show>
              <Show when={!readError()}>
                <Show
                  when={!preview()}
                  fallback={
                    <div class="docs-preview">
                      <For each={blocks()}>
                        {(b, i) => (
                          <div
                            class="docs-block"
                            classList={{ sel: isRowSel(i()) }}
                            innerHTML={b.html}
                            onMouseDown={(e) => rowDown(i(), e)}
                            onMouseEnter={() => rowEnter(i())}
                          />
                        )}
                      </For>
                    </div>
                  }
                >
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
              </Show>

            </Show>
          </section>

          <footer class="git-foot">
            <Show
              when={selMeta()}
              fallback={
                <span class="git-hint">
                  <span class="git-hint-mark">⌖</span> drag to select {preview() ? "blocks" : "lines"} → send to a pane
                </span>
              }
            >
              <div class="git-send">
                <span class="git-send-info">
                  <Show when={flash()} fallback={
                    <>
                      {selMeta()!.count} line{selMeta()!.count === 1 ? "" : "s"}
                      <span class="git-send-loc"> · {selected()!.rel}:{rangeStr(selMeta()!)}</span>
                    </>
                  }>
                    <span class="git-send-flash">{flash()}</span>
                  </Show>
                </span>
                <button
                  class="git-send-btn"
                  disabled={liveReach() === 0}
                  title={liveReach() === 0 ? "No live terminal is focused" : "Send to the focused terminal"}
                  onClick={sendToTerminal}
                >
                  Send ▸
                </button>
                <button class="git-send-clear" title="Clear selection (Esc)" onClick={clearSelection}>✕</button>
              </div>
            </Show>
          </footer>
        </Show>
    </aside>
  );
}
