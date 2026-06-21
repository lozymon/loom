// Source Control panel (a git diff viewer), opened from the rail's ⎇ button or Ctrl+Shift+G.
// Docks as a floating card to the right of the stage, scoped to the active workspace's working
// folder: a changes list (Staged / Changes) above a unified diff. Drag its left edge to widen.
// Strictly read-only — no stage/commit (yet).

import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { activeWorkspace } from "../stores/workspace";
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

/** A single-letter badge for a file row, given which group it's shown under. */
function badge(file: GitFile, stagedView: boolean): string {
  if (file.untracked) return "U";
  const c = stagedView ? file.status[0] : file.status[1];
  return c === " " ? "" : c.toUpperCase();
}

export default function GitPanel(props: { onClose: () => void }) {
  const ws = activeWorkspace();

  // The folder git runs in: prefer the focused terminal's *live* cwd (where you've cd'd to),
  // falling back to the workspace's launch folder. Resolved on open/refresh into this signal.
  const [cwd, setCwd] = createSignal("");

  async function resolveCwd(): Promise<string> {
    const focused = ws?.focused ?? null;
    if (focused != null) {
      const live = (await paneCwd(focused))?.trim();
      if (live) return live;
    }
    return ws?.cwd?.trim() || "";
  }

  const [status, setStatus] = createSignal<GitStatus | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [selected, setSelected] = createSignal<Selection | null>(null);
  const [rows, setRows] = createSignal<DiffRow[]>([]);
  const [diffError, setDiffError] = createSignal<string | null>(null);

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

  /** Send the selected diff lines into the focused pane's PTY (as one bracketed paste + submit). */
  function sendToTerminal() {
    const id = focusedId();
    const sel = selMeta();
    if (id == null || !sel) return;
    const path = selected()?.path ?? "";
    const body = `${path}:${rangeStr(sel)}\n\`\`\`diff\n${sel.text}\n\`\`\``;
    // Bracketed paste so the multi-line block lands as one paste (not line-by-line Enters);
    // the trailing CR submits it so the agent acts on it immediately.
    const payload = `\x1b[200~${body}\x1b[201~\r`;
    const n = writeToPanes([id], payload);
    if (n > 0) {
      // Sent — close the panel so the focused terminal (and the agent acting on it) is visible.
      clearSelection();
      props.onClose();
    } else {
      showFlash("no live terminal focused");
    }
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
    setDiffError(null);
    clearSelection();
    try {
      const text = await gitDiff(cwd(), file.path, stagedView, file.untracked && !stagedView);
      setRows(parseUnifiedDiff(text));
    } catch (e) {
      setDiffError(String(e));
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
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") props.onClose();
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
                    <div class="git-hunk">{row.header}</div>
                  ) : (
                    diffLine(row, i())
                  )
                }
              </For>
            </Show>
          </section>

          <footer class="git-foot">
            <Show
              when={selMeta()}
              fallback={
                <span class="git-hint">
                  <span class="git-hint-mark">⌖</span> drag to select lines → send to terminal
                </span>
              }
            >
              <div class="git-send">
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
                <button
                  class="git-send-btn"
                  disabled={!targetLive()}
                  title={targetLive() ? "Send to the focused terminal" : "No live terminal is focused"}
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
