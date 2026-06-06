// Source Control panel (a VSCode-style git diff viewer), opened from the rail's ⎇ button or
// Ctrl+Shift+G. A full-screen modal over the stage scoped to the active workspace's working
// folder: the left list groups changed files into Staged / Changes; clicking one renders its
// unified diff side-by-side in the main pane. Strictly read-only — no stage/commit (yet).

import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { activeWorkspace } from "../stores/workspace";
import { paneCwd } from "../lib/paneRegistry";
import {
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
              <div class="git-diff-path">{selected()!.path}</div>
              <Show when={diffError()}>
                <div class="git-empty">{diffError()}</div>
              </Show>
              <Show when={!diffError() && rows().length === 0}>
                <div class="git-empty">No textual changes (binary or whitespace-only).</div>
              </Show>
              <div class="git-diff-grid">
                <For each={rows()}>
                  {(row) =>
                    row.kind === "hunk" ? (
                      <div class="git-hunk">{row.header}</div>
                    ) : (
                      <>
                        <div class="git-ln" classList={{ [row.left.kind]: true }}>{row.left.no ?? ""}</div>
                        <div class="git-code" classList={{ [row.left.kind]: true }}>{row.left.text}</div>
                        <div class="git-ln" classList={{ [row.right.kind]: true }}>{row.right.no ?? ""}</div>
                        <div class="git-code" classList={{ [row.right.kind]: true }}>{row.right.text}</div>
                      </>
                    )
                  }
                </For>
              </div>
            </Show>
          </section>
        </div>
      </div>
    </div>
  );
}
