// Source Control panel (a git diff *review* tool), opened from the rail's ⎇ button or Ctrl+Shift+G.
// Docks as a floating card to the right of the stage, scoped to the active workspace's working
// folder: a changes list (Staged / Changes) above a unified diff. Drag its left edge to widen.
//
// Review flow (the reason this is in-app and not just `lazygit` in a pane): select a diff region —
// drag lines, or click a hunk header to grab the whole hunk — optionally attach a note, then either
// Send it to the focused agent pane now or ＋ queue it. Queued comments accumulate in a review bar
// and go out together as one numbered "Code review — N comments" message. The panel stays open
// across sends (review is iterative). Strictly read-only — staging/commit stays with the agent.

import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { activeWorkspace, setPanelCwd } from "../stores/workspace";
import { countLive, paneCwd, writeToPanes } from "../lib/paneRegistry";
import { settings, setSetting } from "../stores/settings";
import {
  formatDiffSelection,
  gitDiff,
  gitStatus,
  parseUnifiedDiff,
  type DiffRow,
  type GitFile,
  type GitStatus,
} from "../lib/gitClient";

/** Which file + which side (staged vs working tree) is open in the diff pane. */
interface Selection {
  path: string;
  staged: boolean;
  untracked: boolean;
}

/** One queued review comment: a diff slice (or whole file), its location, and an optional note. */
interface ReviewItem {
  /** Repo-relative file path. */
  path: string;
  /** 1-based line range string (e.g. "12-18"), or "" for a whole-file comment. */
  range: string;
  /** The diff text to send (unified `+`/`-`/` ` lines, or the raw file diff). */
  text: string;
  /** The reviewer's note for this comment (may be empty). */
  note: string;
}

/** Basename of a repo-relative path (for compact chip labels; the full path goes in the title). */
const baseName = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

/** A single-letter badge for a file row, given which group it's shown under. */
function badge(file: GitFile, stagedView: boolean): string {
  if (file.untracked) return "U";
  const c = stagedView ? file.status[0] : file.status[1];
  return c === " " ? "" : c.toUpperCase();
}

export default function GitPanel(props: { onClose: () => void }) {
  const ws = activeWorkspace();

  // The folder git runs in. Captured from the active terminal *when the panel is opened* and then
  // pinned to this workspace (panel.gitCwd), so it stays put if you later cd or focus elsewhere —
  // and so each workspace keeps its own Source Control source. Refresh re-runs git on the pinned
  // folder; close and reopen to re-point it at the current terminal.
  const [cwd, setCwd] = createSignal("");

  async function resolveCwd(): Promise<string> {
    const focused = ws?.focused ?? null;
    if (focused != null) {
      const live = (await paneCwd(focused))?.trim();
      if (live) return live;
    }
    return ws?.cwd?.trim() || "";
  }

  /** The pinned source folder: restore it if this workspace already opened SC, else capture it
   *  now from the active terminal and pin it. */
  async function ensureCwd(): Promise<string> {
    const stored = ws?.panel.gitCwd?.trim() ?? "";
    const dir = stored || (await resolveCwd());
    if (dir && !stored) setPanelCwd("git", dir);
    setCwd(dir);
    return dir;
  }

  const [status, setStatus] = createSignal<GitStatus | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [selected, setSelected] = createSignal<Selection | null>(null);
  const [rows, setRows] = createSignal<DiffRow[]>([]);
  const [rawDiff, setRawDiff] = createSignal(""); // the open file's full diff text (for whole-file sends)
  const [diffError, setDiffError] = createSignal<string | null>(null);
  // A note annotates the current selection; the review queue accumulates comments to send together.
  const [note, setNote] = createSignal("");
  const [review, setReview] = createSignal<ReviewItem[]>([]);

  // ---- line selection → send-to-terminal ----
  // Selection is a contiguous row range [anchor, head]; drag or shift-click extends it.
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
  const selectedIndices = createMemo<number[]>(() => {
    const r = selRange();
    if (!r) return [];
    const rs = rows();
    const out: number[] = [];
    for (let i = r.lo; i <= r.hi; i++) if (rs[i]?.kind === "line") out.push(i);
    return out;
  });
  /** The reconstructed diff slice for the current selection (null when nothing selected). */
  const selMeta = createMemo(() => {
    const idx = selectedIndices();
    return idx.length ? formatDiffSelection(rows(), idx) : null;
  });
  const rangeStr = (s: { start: number; end: number }) =>
    s.start === s.end ? `${s.start}` : `${s.start}-${s.end}`;

  const focusedId = () => ws?.focused ?? null;
  const targetLive = () => {
    const id = focusedId();
    return id != null && countLive([id]) > 0;
  };

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

  // Drag the left edge to resize; clamp + persist (mirrors the rail/preview resizer).
  const WIDTH_MIN = 360;
  const WIDTH_MAX = 960;
  function onResizeDown(e: PointerEvent) {
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = settings.gitWidth;
    const move = (ev: PointerEvent) => {
      // Dragging left (smaller clientX) widens the right-docked panel.
      const w = Math.max(WIDTH_MIN, Math.min(WIDTH_MAX, startW + (startX - ev.clientX)));
      setSetting("gitWidth", w);
    };
    const up = (ev: PointerEvent) => {
      handle.releasePointerCapture(ev.pointerId);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  // Drag the divider below the changes list to re-split list vs. diff height; clamp + persist.
  const LIST_MIN = 72;
  const LIST_MAX = 640;
  function onListResizeDown(e: PointerEvent) {
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startH = settings.gitListHeight;
    const move = (ev: PointerEvent) => {
      // Dragging down (larger clientY) grows the list, shrinking the diff below it.
      const h = Math.max(LIST_MIN, Math.min(LIST_MAX, startH + (ev.clientY - startY)));
      setSetting("gitListHeight", h);
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

  /** Select every line row belonging to the hunk whose header is at row `h` (one-click hunk pick). */
  function selectHunk(h: number) {
    const rs = rows();
    let first = -1;
    let last = -1;
    for (let j = h + 1; j < rs.length && rs[j].kind === "line"; j++) {
      if (first === -1) first = j;
      last = j;
    }
    if (first !== -1) { setAnchor(first); setHead(last); }
  }

  /** The current selection as a review item (note included), or null when nothing is selected. */
  const currentItem = (): ReviewItem | null => {
    const sel = selMeta();
    if (!sel) return null;
    return { path: selected()?.path ?? "", range: rangeStr(sel), text: sel.text, note: note().trim() };
  };

  /** Render one comment to the text we paste into the pane (note line + located diff fence). */
  function formatItem(it: ReviewItem): string {
    const loc = it.range ? `${it.path}:${it.range}` : it.path;
    const head = it.note ? `${it.note}\n${loc}` : loc;
    return `${head}\n\`\`\`diff\n${it.text}\n\`\`\``;
  }

  /** Paste `body` into the focused pane as one bracketed paste + submit. Returns true on success. */
  function sendBody(body: string): boolean {
    const id = focusedId();
    if (id == null) return false;
    // Bracketed paste so the multi-line block lands as one paste (not line-by-line Enters); the
    // trailing CR submits it so the agent acts on it immediately.
    const n = writeToPanes([id], `\x1b[200~${body}\x1b[201~\r`);
    if (n === 0) { showFlash("no live terminal focused"); return false; }
    return true;
  }

  function resetSelection() {
    clearSelection();
    setNote("");
  }

  /** Send just the current selection now (stay open — review is iterative). */
  function sendOne() {
    const it = currentItem();
    if (it && sendBody(formatItem(it))) { showFlash("sent ✓"); resetSelection(); }
  }

  /** Queue the current selection as a review comment (stay open). */
  function addToReview() {
    const it = currentItem();
    if (!it) return;
    setReview((r) => [...r, it]);
    resetSelection();
    showFlash("added to review");
  }

  /** The whole open file as a review item (its full diff, no specific range). */
  const fileItem = (): ReviewItem | null => {
    const text = rawDiff().replace(/\n+$/, "");
    const path = selected()?.path;
    if (!text || !path) return null;
    return { path, range: "", text, note: note().trim() };
  };

  function sendFile() {
    const it = fileItem();
    if (it && sendBody(formatItem(it))) { showFlash("sent file ✓"); resetSelection(); }
  }
  function addFileToReview() {
    const it = fileItem();
    if (!it) return;
    setReview((r) => [...r, it]);
    resetSelection();
    showFlash("added file to review");
  }

  function removeReview(i: number) {
    setReview((r) => r.filter((_, k) => k !== i));
  }
  function clearReview() {
    setReview([]);
  }

  /** Send the whole queued review as one numbered message (stay open), then clear the queue. */
  function sendReview() {
    const items = review();
    if (items.length === 0) return;
    const header = `Code review — ${items.length} comment${items.length === 1 ? "" : "s"}:`;
    const body = [header, ...items.map((it, k) => `${k + 1}. ${formatItem(it)}`)].join("\n\n");
    if (sendBody(body)) { showFlash(`sent review (${items.length}) ✓`); clearReview(); }
  }

  const staged = createMemo(() => status()?.files.filter((f) => f.staged) ?? []);
  const changes = createMemo(() => status()?.files.filter((f) => f.unstaged || f.untracked) ?? []);

  const isSelected = (path: string, stagedView: boolean) => {
    const s = selected();
    return !!s && s.path === path && s.staged === stagedView;
  };

  async function openFile(file: GitFile, stagedView: boolean) {
    const sel: Selection = { path: file.path, staged: stagedView, untracked: file.untracked };
    setSelected(sel);
    setRows([]);
    setRawDiff("");
    setDiffError(null);
    resetSelection();
    try {
      const text = await gitDiff(cwd(), file.path, stagedView, file.untracked && !stagedView);
      setRawDiff(text);
      setRows(parseUnifiedDiff(text));
    } catch (e) {
      setDiffError(String(e));
    }
  }

  async function refresh() {
    setLoading(true);
    setError(null);
    const dir = await ensureCwd();
    if (!dir) {
      setError("No working folder — focus a terminal or give this workspace a folder.");
      setLoading(false);
      return;
    }
    try {
      const st = await gitStatus(dir);
      setStatus(st);
      // Keep the open file selected if it still has changes; otherwise pick the first one.
      const all = st.files;
      const keep = selected();
      const stillThere = keep && all.some((f) => f.path === keep.path);
      if (!stillThere) {
        const first = all.find((f) => f.unstaged || f.untracked) ?? all.find((f) => f.staged);
        if (first) await openFile(first, !(first.unstaged || first.untracked));
        else setSelected(null);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  onMount(refresh);

  // Capture phase: while a terminal has focus, xterm stops propagation of Escape (it sends
  // \x1b to the PTY), so a bubble-phase window listener never fires until you click off the
  // pane. Capturing intercepts Escape before xterm can swallow it.
  // Escape peels back state in the order you'd expect: a draft selection/note first. With comments
  // queued, Escape won't close (closing unmounts the panel and would drop the un-sent review) — it
  // nudges you to send or clear the queue first; the header ✕ still closes deliberately.
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    if (selRange() || note()) resetSelection();
    else if (review().length > 0) showFlash("queued review pending — Send review or clear it");
    else props.onClose();
  };
  onMount(() => window.addEventListener("keydown", onKey, true));
  onCleanup(() => window.removeEventListener("keydown", onKey, true));

  const fileRow = (file: GitFile, stagedView: boolean) => {
    const b = badge(file, stagedView);
    return (
      <button
        class="git-file"
        classList={{ on: isSelected(file.path, stagedView) }}
        onClick={() => openFile(file, stagedView)}
        title={file.path}
      >
        <span class="git-file-badge" data-s={b}>{b}</span>
        <span class="git-file-path">{file.path}</span>
      </button>
    );
  };

  /** The unified-diff line column for one row index (line-number gutter omitted, per the design). */
  const diffLine = (row: Extract<DiffRow, { kind: "line" }>, i: number) => {
    const cls = row.sign === "+" ? "add" : row.sign === "-" ? "del" : "ctx";
    return (
      <div
        class="git-line"
        classList={{ [cls]: true, sel: isRowSel(i) }}
        onMouseDown={(e) => rowDown(i, e)}
        onMouseEnter={() => rowEnter(i)}
      >
        <span class="git-line-sign">{row.sign === " " ? "" : row.sign}</span>
        <span class="git-line-text">{row.text}</span>
      </div>
    );
  };

  return (
    <aside
      class="side-panel git-panel git-scm"
      style={{ "flex-basis": `${settings.gitWidth}px`, width: `${settings.gitWidth}px` }}
    >
        <div class="git-resizer" title="Drag to resize" onPointerDown={onResizeDown} />
        <header class="git-head">
          <span class="git-title">Source Control</span>
          <Show when={status()?.isRepo && status()!.root}>
            <span class="git-project" title={status()!.root}>
              {status()!.root.split("/").filter(Boolean).pop()}
            </span>
          </Show>
          <Show when={status()?.isRepo && status()!.branch}>
            <span class="git-branch" title={cwd()}>⎇ {status()!.branch}</span>
          </Show>
          <span class="git-head-actions">
            <button class="git-icon-btn" title="Refresh" onClick={() => void refresh()}>↻</button>
            <button class="git-icon-btn" title="Close (Esc)" onClick={() => props.onClose()}>✕</button>
          </span>
        </header>

        <Show
          when={!loading() && !error() && status()?.isRepo}
          fallback={
            <div class="git-empty git-empty-fill">
              <Show when={loading()}>Loading…</Show>
              <Show when={!loading() && error()}>{error()}</Show>
              <Show when={!loading() && !error() && !status()?.isRepo}>
                Not a git repository.
                <div class="git-empty-sub">{cwd() || "(no working folder)"}</div>
              </Show>
            </div>
          }
        >
          <div class="git-list" style={{ height: `${settings.gitListHeight}px` }}>
            <Show when={staged().length === 0 && changes().length === 0}>
              <div class="git-empty">No changes.</div>
            </Show>
            <Show when={staged().length > 0}>
              <div class="git-group-head">STAGED · {staged().length}</div>
              <For each={staged()}>{(f) => fileRow(f, true)}</For>
            </Show>
            <Show when={changes().length > 0}>
              <div class="git-group-head">CHANGES · {changes().length}</div>
              <For each={changes()}>{(f) => fileRow(f, false)}</For>
            </Show>
          </div>

          <div class="git-list-resizer" title="Drag to resize" onPointerDown={onListResizeDown} />

          <section class="git-diff">
            <Show
              when={selected()}
              fallback={<div class="git-empty">Select a file to view its diff.</div>}
            >
              <Show when={diffError()}>
                <div class="git-empty">{diffError()}</div>
              </Show>
              <Show when={!diffError() && rows().length === 0}>
                <div class="git-empty">No textual changes (binary or whitespace-only).</div>
              </Show>
              <For each={rows()}>
                {(row, i) =>
                  row.kind === "hunk" ? (
                    <div
                      class="git-hunk git-hunk-pick"
                      title="Click to select this whole hunk"
                      onClick={() => selectHunk(i())}
                    >{row.header}</div>
                  ) : (
                    diffLine(row, i())
                  )
                }
              </For>
            </Show>
          </section>

          {/* Queued review comments — sent together as one numbered message. */}
          <Show when={review().length > 0}>
            <div class="git-review">
              <div class="git-review-head">
                <span class="git-review-title">REVIEW · {review().length}</span>
                <span class="git-review-actions">
                  <button class="git-send-clear" title="Clear the review queue" onClick={clearReview}>Clear</button>
                  <button
                    class="git-send-btn"
                    disabled={!targetLive()}
                    title={targetLive() ? "Send all queued comments as one message" : "No live terminal is focused"}
                    onClick={sendReview}
                  >
                    Send review ▸
                  </button>
                </span>
              </div>
              <div class="git-review-items">
                <For each={review()}>
                  {(it, i) => (
                    <div class="git-review-chip" title={`${it.range ? `${it.path}:${it.range}` : it.path}${it.note ? ` — ${it.note}` : ""}`}>
                      <span class="git-review-loc">
                        {baseName(it.path)}<Show when={it.range}><span class="git-review-range">:{it.range}</span></Show>
                      </span>
                      <Show when={it.note} fallback={<span class="git-review-note git-review-note-empty">no note</span>}>
                        <span class="git-review-note">{it.note}</span>
                      </Show>
                      <button class="git-review-x" title="Remove" onClick={() => removeReview(i())}>✕</button>
                    </div>
                  )}
                </For>
              </div>
            </div>
          </Show>

          <footer class="git-foot">
            <Show
              when={selMeta()}
              fallback={
                <div class="git-hint-row">
                  <span class="git-hint">
                    <span class="git-hint-mark">⌖</span> drag, or click a hunk, to select
                  </span>
                  <Show when={selected() && rows().length > 0}>
                    <span class="git-hint-actions">
                      <Show when={flash()}><span class="git-send-flash">{flash()}</span></Show>
                      <button class="git-send-add" title="Add the whole file to the review" onClick={addFileToReview}>＋ file</button>
                      <button
                        class="git-send-add"
                        disabled={!targetLive()}
                        title={targetLive() ? "Send the whole file diff now" : "No live terminal is focused"}
                        onClick={sendFile}
                      >
                        Send file ▸
                      </button>
                    </span>
                  </Show>
                </div>
              }
            >
              <div class="git-send">
                <input
                  class="git-note-input"
                  type="text"
                  placeholder="Add a note (optional) — e.g. “is this off-by-one?”"
                  value={note()}
                  onInput={(e) => setNote(e.currentTarget.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); sendOne(); } }}
                />
                <div class="git-send-row">
                  <span class="git-send-info">
                    <Show when={flash()} fallback={
                      <>
                        {selMeta()!.count} line{selMeta()!.count === 1 ? "" : "s"}
                        <span class="git-send-loc"> · {selected()!.path}:{rangeStr(selMeta()!)}</span>
                      </>
                    }>
                      <span class="git-send-flash">{flash()}</span>
                    </Show>
                  </span>
                  <button class="git-send-add" title="Add this comment to the review queue" onClick={addToReview}>＋</button>
                  <button
                    class="git-send-btn"
                    disabled={!targetLive()}
                    title={targetLive() ? "Send this comment now" : "No live terminal is focused"}
                    onClick={sendOne}
                  >
                    Send ▸
                  </button>
                  <button class="git-send-clear" title="Clear selection (Esc)" onClick={resetSelection}>✕</button>
                </div>
              </div>
            </Show>
          </footer>
        </Show>
    </aside>
  );
}
