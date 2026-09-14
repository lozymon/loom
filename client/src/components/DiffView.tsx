import type { DiffFile, DiffHunk, SessionDiff } from "@loom/protocol";
import { createEffect, createSignal, For, on, Show } from "solid-js";
import { useHub } from "../hub/store.ts";

/**
 * What a session changed (M12): files and hunks from git, with two-step reverts. The screen never
 * reverts on its own; the hub checks the hunk id so a stale view cannot undo the wrong lines.
 */
export function DiffView(props: { sessionId: string }) {
  const { state, actions } = useHub();
  const session = () => state.sessions[props.sessionId];
  const [mode, setMode] = createSignal<"uncommitted" | "branch">("uncommitted");
  const [diff, setDiff] = createSignal<SessionDiff>();
  const [loading, setLoading] = createSignal(false);
  const [problem, setProblem] = createSignal<string>();
  const [confirm, setConfirm] = createSignal<string>();

  const load = async () => {
    setLoading(true);
    setProblem(undefined);
    try {
      setDiff(await actions.sessionDiff(props.sessionId, mode()));
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };
  // Load on open, when the mode changes, and whenever the session records new changes.
  createEffect(on([mode, () => session()?.changedFiles, () => props.sessionId], () => void load()));

  const working = () => session()?.state === "working" || session()?.state === "starting";
  const canRevert = () => mode() === "uncommitted" && !working();

  const revert = async (file: DiffFile, hunk?: DiffHunk) => {
    setConfirm(undefined);
    setProblem(undefined);
    try {
      setDiff(await actions.revertChange(props.sessionId, file.path, hunk?.id));
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
      void load();
    }
  };

  const totals = () => (diff()?.files ?? []).reduce((t, f) => ({ added: t.added + f.added, removed: t.removed + f.removed }), { added: 0, removed: 0 });
  const statusLabel: Record<DiffFile["status"], string> = { modified: "M", added: "A", deleted: "D", renamed: "R", untracked: "new" };

  return (
    <div class="diff-view">
      <div class="diff-toolbar">
        <Show when={session()?.worktree}>
          <select value={mode()} onChange={(e) => setMode(e.currentTarget.value as "uncommitted" | "branch")} aria-label="Compare">
            <option value="uncommitted">Uncommitted</option>
            <option value="branch">Whole branch</option>
          </select>
        </Show>
        <span class="muted small">
          <Show when={diff()?.git} fallback={loading() ? "Loading…" : ""}>
            {diff()!.files.length} file{diff()!.files.length === 1 ? "" : "s"} · <span class="diff-add">+{totals().added}</span> <span class="diff-del">−{totals().removed}</span> · against{" "}
            <span class="mono">{diff()!.base}</span>
          </Show>
        </span>
        <button onClick={() => void load()} disabled={loading()}>
          Refresh
        </button>
      </div>
      <Show when={working()}>
        <p class="muted small diff-note">{session()?.name} is working; reverts wait until it is idle.</p>
      </Show>
      <Show when={mode() === "branch"}>
        <p class="muted small diff-note">Whole-branch view includes commits; revert from the Uncommitted view.</p>
      </Show>
      <Show when={problem()}>
        <p class="error-text small diff-note">{problem()}</p>
      </Show>
      <Show when={diff() && !diff()!.git}>
        <p class="muted diff-note">This session's folder is not in a git repository.</p>
      </Show>
      <Show when={diff()?.git && diff()!.files.length === 0}>
        <p class="muted diff-note">No changes.</p>
      </Show>
      <div class="diff-files">
        <For each={diff()?.files ?? []}>
          {(file) => (
            <details class="diff-file" open={(diff()?.files.length ?? 0) <= 8}>
              <summary>
                <span class={`badge diff-status ${file.status}`}>{statusLabel[file.status]}</span>
                <span class="mono diff-path">{file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}</span>
                <span class="small">
                  <span class="diff-add">+{file.added}</span> <span class="diff-del">−{file.removed}</span>
                </span>
                <Show when={canRevert()}>
                  <Show
                    when={confirm() === `file:${file.path}`}
                    fallback={
                      <button
                        class="link"
                        onClick={(e) => {
                          e.preventDefault();
                          setConfirm(`file:${file.path}`);
                        }}
                      >
                        Revert file…
                      </button>
                    }
                  >
                    <button
                      class="danger"
                      onClick={(e) => {
                        e.preventDefault();
                        void revert(file);
                      }}
                    >
                      {file.status === "untracked" || file.status === "added" ? "Delete this file" : "Revert all changes"}
                    </button>
                  </Show>
                </Show>
              </summary>
              <Show when={file.binary}>
                <p class="muted small diff-note">Binary file.</p>
              </Show>
              <For each={file.hunks}>
                {(hunk) => (
                  <div class="diff-hunk">
                    <div class="diff-hunk-head">
                      <span class="mono small muted">{hunk.header}</span>
                      <Show when={canRevert() && file.status === "modified"}>
                        <Show
                          when={confirm() === hunk.id}
                          fallback={
                            <button class="link" onClick={() => setConfirm(hunk.id)}>
                              Revert…
                            </button>
                          }
                        >
                          <button class="danger" onClick={() => void revert(file, hunk)}>
                            Revert this change
                          </button>
                        </Show>
                      </Show>
                    </div>
                    <pre class="diff-lines">
                      <For each={hunk.lines}>
                        {(line) => <span class={line.startsWith("+") ? "diff-line add" : line.startsWith("-") ? "diff-line del" : "diff-line"}>{line}</span>}
                      </For>
                    </pre>
                  </div>
                )}
              </For>
              <Show when={file.truncated}>
                <p class="muted small diff-note">Too large to show in full.</p>
              </Show>
            </details>
          )}
        </For>
        <Show when={diff()?.truncated}>
          <p class="muted small diff-note">More files changed than are shown.</p>
        </Show>
      </div>
    </div>
  );
}
