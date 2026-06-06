// Source Control panel (a VSCode-style git diff viewer), opened from the rail's ⎇ button or
// Ctrl+Shift+G. A full-screen modal over the stage scoped to the active workspace's working
// folder: the left list groups changed files into Staged / Changes; clicking one renders its
// unified diff side-by-side in the main pane. Strictly read-only — no stage/commit (yet).

import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { activeWorkspace } from "../stores/workspace";
import { countLive, paneCwd, writeToPanes } from "../lib/paneRegistry";
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

/** Split a repo-relative path into a dimmed directory + a bold basename (VSCode-style). */
function splitPath(path: string): { dir: string; base: string } {
  const i = path.lastIndexOf("/");
  return i < 0 ? { dir: "", base: path } : { dir: path.slice(0, i), base: path.slice(i + 1) };
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
  const [instruction, setInstruction] = createSignal("");
  const [submitOnSend, setSubmitOnSend] = createSignal(true);
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
    for (let i = r.lo; i <= r.hi; i++) if (rs[i]?.kind === "pair") out.push(i);
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

  function showFlash(msg: string) {
    clearTimeout(flashTimer);
    setFlash(msg);
    flashTimer = setTimeout(() => setFlash(null), 2200);
  }

  /** Send the selected diff lines (+ optional instruction) into the focused pane's PTY. */
  function sendToTerminal() {
    const id = focusedId();
    const sel = selMeta();
    if (id == null || !sel) return;
    const path = selected()?.path ?? "";
    const instr = instruction().trim();
    let body = `${path}:${rangeStr(sel)}\n\`\`\`diff\n${sel.text}\n\`\`\``;
    if (instr) body += `\n${instr}`;
    // Bracketed paste so the multi-line block lands as one paste (not line-by-line Enters);
    // an optional trailing CR submits it so the agent acts on it immediately.
    const payload = `\x1b[200~${body}\x1b[201~` + (submitOnSend() ? "\r" : "");
    const n = writeToPanes([id], payload);
    if (n > 0) {
      // Sent — close the panel so the focused terminal (and the agent acting on it) is visible.
      clearSelection();
      setInstruction("");
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

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") props.onClose();
  };
  onMount(() => window.addEventListener("keydown", onKey));
  onCleanup(() => window.removeEventListener("keydown", onKey));

  const fileRow = (file: GitFile, stagedView: boolean) => {
    const { dir, base } = splitPath(file.path);
    return (
      <button
        class="git-file"
        classList={{ on: isSelected(file.path, stagedView) }}
        onClick={() => openFile(file, stagedView)}
        title={file.path}
      >
        <span class="git-file-name">
          <span class="git-file-base">{base}</span>
          <Show when={dir}>
            <span class="git-file-dir">{dir}</span>
          </Show>
        </span>
        <span class="git-file-badge" data-s={badge(file, stagedView)}>{badge(file, stagedView)}</span>
      </button>
    );
  };

  return (
    <div class="settings-backdrop" onClick={() => props.onClose()}>
      <div class="git-panel" onClick={(e) => e.stopPropagation()}>
        <header class="settings-head">
          <span class="settings-title">
            ⎇ Source Control
            <Show when={status()?.isRepo && status()!.branch}>
              <span class="git-branch">{status()!.branch}</span>
            </Show>
            <Show when={cwd()}>
              <span class="git-cwd" title={cwd()}>{cwd()}</span>
            </Show>
          </span>
          <span class="git-head-actions">
            <button class="settings-btn" title="Refresh" onClick={() => void refresh()}>
              ⟳ Refresh
            </button>
            <button class="settings-x" title="Close (Esc)" onClick={() => props.onClose()}>✕</button>
          </span>
        </header>

        <div class="git-body">
          <aside class="git-files">
            <Show
              when={!loading() && !error() && status()?.isRepo}
              fallback={
                <div class="git-empty">
                  <Show when={loading()}>Loading…</Show>
                  <Show when={!loading() && error()}>{error()}</Show>
                  <Show when={!loading() && !error() && !status()?.isRepo}>
                    Not a git repository.
                    <div class="git-empty-sub">{cwd() || "(no working folder)"}</div>
                  </Show>
                </div>
              }
            >
              <Show when={staged().length === 0 && changes().length === 0}>
                <div class="git-empty">No changes.</div>
              </Show>
              <Show when={staged().length > 0}>
                <div class="git-group-head">Staged Changes <span class="git-count">{staged().length}</span></div>
                <For each={staged()}>{(f) => fileRow(f, true)}</For>
              </Show>
              <Show when={changes().length > 0}>
                <div class="git-group-head">Changes <span class="git-count">{changes().length}</span></div>
                <For each={changes()}>{(f) => fileRow(f, false)}</For>
              </Show>
            </Show>
          </aside>

          <section class="git-diff">
            <Show
              when={selected()}
              fallback={<div class="git-empty">{status()?.isRepo ? "Select a file to view its diff." : ""}</div>}
            >
              <div class="git-diff-path">
                <span>{selected()!.path}</span>
                <span class="git-diff-hint">drag to select lines → send to terminal</span>
              </div>
              <Show when={diffError()}>
                <div class="git-empty">{diffError()}</div>
              </Show>
              <Show when={!diffError() && rows().length === 0}>
                <div class="git-empty">No textual changes (binary or whitespace-only).</div>
              </Show>
              <div class="git-diff-grid">
                <For each={rows()}>
                  {(row, i) =>
                    row.kind === "hunk" ? (
                      <div class="git-hunk">{row.header}</div>
                    ) : (
                      <>
                        <div
                          class="git-ln"
                          classList={{ [row.left.kind]: true, sel: isRowSel(i()) }}
                          onMouseDown={(e) => rowDown(i(), e)}
                          onMouseEnter={() => rowEnter(i())}
                        >{row.left.no ?? ""}</div>
                        <div
                          class="git-code"
                          classList={{ [row.left.kind]: true, sel: isRowSel(i()) }}
                          onMouseDown={(e) => rowDown(i(), e)}
                          onMouseEnter={() => rowEnter(i())}
                        >{row.left.text}</div>
                        <div
                          class="git-ln"
                          classList={{ [row.right.kind]: true, sel: isRowSel(i()) }}
                          onMouseDown={(e) => rowDown(i(), e)}
                          onMouseEnter={() => rowEnter(i())}
                        >{row.right.no ?? ""}</div>
                        <div
                          class="git-code"
                          classList={{ [row.right.kind]: true, sel: isRowSel(i()) }}
                          onMouseDown={(e) => rowDown(i(), e)}
                          onMouseEnter={() => rowEnter(i())}
                        >{row.right.text}</div>
                      </>
                    )
                  }
                </For>
              </div>

              <Show when={selMeta()}>
                <div class="git-send">
                  <span class="git-send-info">
                    {selMeta()!.count} line{selMeta()!.count === 1 ? "" : "s"}
                    <span class="git-send-loc"> · {selected()!.path}:{rangeStr(selMeta()!)}</span>
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
                  <label class="git-send-enter" title="Press Enter in the terminal after pasting (submit)">
                    <input
                      type="checkbox"
                      checked={submitOnSend()}
                      onChange={(e) => setSubmitOnSend(e.currentTarget.checked)}
                    />
                    submit
                  </label>
                  <button
                    class="git-send-btn primary"
                    disabled={!targetLive()}
                    title={targetLive() ? "Send to the focused terminal" : "No live terminal is focused"}
                    onClick={sendToTerminal}
                  >
                    Send to terminal ▸
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
