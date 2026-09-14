import { createEffect, createMemo, createResource, createSignal, For, lazy, on, Show } from "solid-js";
import { useHub } from "../hub/store.ts";
import { formatCost, shortPath, stateLabel } from "../lib/format.ts";
import { ApprovalCard } from "./ApprovalCard.tsx";
import { Composer } from "./Composer.tsx";
import { DiffView } from "./DiffView.tsx";
import { LevelSelect } from "./LevelSelect.tsx";
import { PolicyEditor } from "./PolicyEditor.tsx";
// xterm is large; load it only when a terminal session is opened.
const TerminalSession = lazy(() => import("./TerminalSession.tsx").then((m) => ({ default: m.TerminalSession })));
import { Timeline } from "./Timeline.tsx";

export function SessionView(props: { sessionId: string }) {
  const { state, actions } = useHub();
  const session = () => state.sessions[props.sessionId];
  const pending = createMemo(() =>
    Object.values(state.approvals)
      .filter((a) => a.sessionId === props.sessionId)
      .sort((a, b) => a.requestedAt - b.requestedAt),
  );
  const busy = () => session()?.state === "working" || session()?.state === "blocked";
  const isTerminal = () => session()?.adapter === "pty";
  const [editingPolicy, setEditingPolicy] = createSignal(false);
  const [showChanges, setShowChanges] = createSignal(false);
  // A different session starts on its conversation, and so does jumping to an event from search.
  createEffect(on(() => props.sessionId, () => setShowChanges(false), { defer: true }));
  createEffect(on(() => state.timelineFocus, (focus) => focus?.sessionId === props.sessionId && setShowChanges(false), { defer: true }));
  const [policy, { refetch: refetchPolicy }] = createResource(
    () => (session()?.cwd && !editingPolicy() ? session()!.cwd : undefined),
    (cwd) => actions.policyGet(cwd),
  );
  const untrusted = () => {
    const p = policy();
    return p !== undefined && !p.project.trusted ? p.project.policy.allow.length : 0;
  };
  const twin = createMemo(() =>
    Object.values(state.sessions).find((o) => o.linkedSessionId === props.sessionId && o.live),
  );
  const origin = () => {
    const id = session()?.linkedSessionId;
    return id ? state.sessions[id] : undefined;
  };
  const loaded = () => {
    const l = session()?.loaded;
    if (!l) return "";
    const parts = [];
    if (l.plugins.length) parts.push(`${l.plugins.length} plugin${l.plugins.length > 1 ? "s" : ""}`);
    if (l.mcpServers.length) parts.push(`${l.mcpServers.length} MCP server${l.mcpServers.length > 1 ? "s" : ""}`);
    return parts.join(", ");
  };
  const loadedTitle = () => {
    const l = session()?.loaded;
    if (!l) return "";
    return [...l.plugins.map((p) => `plugin: ${p}`), ...l.mcpServers.map((m) => `MCP: ${m.name} (${m.status})`)].join("\n");
  };

  return (
    <Show when={session()}>
      {(s) => (
        <section class="session">
          <header class="session-head">
            <div class="session-title">
              <span class={`dot state-${s().state}`} />
              <h1>{s().name}</h1>
              <span class="muted state-text">{stateLabel(s().state, s().blockedOn)}</span>
              <Show when={s().stateProvenance === "heuristic"}>
                <span class="chip" title="Read from the terminal screen by a manifest, not reported by the program">from screen</span>
              </Show>
              <Show when={!s().live}>
                <span class="chip" title="The engine is not running. Sending a message resumes it.">
                  paused
                </span>
              </Show>
            </div>
            <div class="session-meta">
              <Show when={isTerminal()}>
                <span class="chip">{s().agent ? `${s().agent} terminal` : "terminal"}</span>
              </Show>
              <Show when={s().branch}>
                <span class="branch" title={s().worktree?.path}>
                  {s().branch}
                  {s().worktree?.removed ? " (worktree removed)" : ""}
                </span>
              </Show>
              <span title={s().cwd}>{shortPath(s().cwd)}</span>
              <Show when={isTerminal() && s().command}>
                <span class="mono" title={s().command}>{s().command}</span>
              </Show>
              <Show when={s().model}>
                <span>{s().model}</span>
              </Show>
              <Show when={loaded()}>
                <span title={loadedTitle()}>{loaded()}</span>
              </Show>
              <Show when={!isTerminal()}>
                <span>{formatCost(s().costUsd)}</span>
              </Show>
              <Show when={origin()}>
                {(o) => (
                  <button class="link" onClick={() => void actions.open(o().id)}>
                    continues {o().name}
                  </button>
                )}
              </Show>
            </div>
            <div class="session-controls">
              <button onClick={() => setEditingPolicy(true)} title="Rules that approve, deny, or always ask" classList={{ attention: untrusted() > 0 }}>
                Policy
              </button>
              <Show when={!isTerminal() && s().engineSessionId}>
                <button
                  onClick={() => void actions.openTerminal(s().id)}
                  title="Continue this conversation in Claude's own terminal interface"
                >
                  Open in terminal
                </button>
              </Show>
              <label class="inline" classList={{ hidden: isTerminal() && !s().agent }}>
                <span class="muted">Level</span>
                <LevelSelect
                  stewardOn={state.hub?.stewardModel ?? false}
                  value={s().level}
                  max={state.hub?.maxLevel ?? "supervised"}
                  onChange={(level) => void actions.setLevel(s().id, level)}
                />
              </label>
              <Show when={s().live}>
                <button
                  onClick={() => void actions.stop(s().id)}
                  title={
                    isTerminal()
                      ? s().agent
                        ? "Stop the process. Restart resumes the conversation."
                        : "Stop the process."
                      : "Stop the engine. Sending a message resumes it."
                  }
                >
                  Stop
                </button>
              </Show>
            </div>
          </header>

          <Show when={untrusted() > 0}>
            <div class="banner warn">
              <span>
                This project's policy has {untrusted()} allow rule{untrusted() === 1 ? "" : "s"} that this hub has not trusted, so they do nothing yet.
              </span>
              <button onClick={() => setEditingPolicy(true)}>Review</button>
            </div>
          </Show>
          <Show when={editingPolicy()}>
            <PolicyEditor
              cwd={s().cwd}
              onClose={() => {
                setEditingPolicy(false);
                void refetchPolicy();
              }}
            />
          </Show>
          <nav class="session-tabs" aria-label="Session views">
            <button classList={{ active: !showChanges() }} onClick={() => setShowChanges(false)}>
              {isTerminal() ? "Terminal" : "Conversation"}
            </button>
            <button classList={{ active: showChanges() }} onClick={() => setShowChanges(true)}>
              Changes
              <Show when={s().changedFiles}>
                <span class="badge">{s().changedFiles}</span>
              </Show>
            </button>
          </nav>
          <Show when={showChanges()}>
            <DiffView sessionId={s().id} />
          </Show>
          <Show when={!showChanges()}>
          <Show when={!isTerminal()} fallback={<TerminalSession sessionId={s().id} />}>
            <Show when={twin()}>
              {(t) => (
                <div class="banner">
                  <span>This conversation is open in terminal session {t().name}. Stop it there to continue here.</span>
                  <button onClick={() => void actions.open(t().id)}>Go to {t().name}</button>
                </div>
              )}
            </Show>

            <Timeline
              events={state.timelines[props.sessionId] ?? []}
              working={s().state === "working"}
              focus={state.timelineFocus?.sessionId === props.sessionId ? state.timelineFocus : undefined}
            />

            <Show when={pending().length > 0}>
              <div class="approvals">
                <For each={pending()}>{(request) => <ApprovalCard request={request} />}</For>
              </div>
            </Show>

            <Composer
              disabled={s().state === "done" || twin() !== undefined}
              working={busy()}
              placeholder={s().live ? `Message ${s().name}` : `Message ${s().name} to resume`}
              draft={state.drafts[s().id] ?? ""}
              onDraft={(text) => actions.setDraft(s().id, text)}
              focusSignal={state.composerFocus?.sessionId === s().id ? state.composerFocus.n : undefined}
              onSend={(text) => actions.send(s().id, text)}
              onInterrupt={() => void actions.interrupt(s().id)}
            />
          </Show>
          </Show>
        </section>
      )}
    </Show>
  );
}
