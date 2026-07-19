// Approvals triage strip (Phase 3, ADR-0008): a bottom-docked bar that appears whenever agents in
// the active workspace are blocked on you. Each row shows the agent, the *actual* pushed Approval
// prompt + kind, and answers inline — written only to that blocked pane (the fan-out path, `loom
// broadcast`, stays separate). Answering optimistically resolves the Approval so the row clears;
// the agent's next signal refines its state. This is the rich form of the coarse amber border.

import { createSignal, For, Show } from "solid-js";
import { activeWorkspace, revealPane } from "../stores/workspace";
import { leafIds } from "../lib/layout";
import { paneActiveTask, approvalResolve } from "../stores/sessions";
import { clearAttention } from "../stores/activity";
import { writeToPanes, countLive } from "../lib/paneRegistry";
import { detectAgent, type AgentDef } from "../lib/agents";
import type { PaneId, Task } from "../ipc/protocol";

interface BlockedRow {
  paneId: PaneId;
  name: string;
  agent: AgentDef | null;
  task: Task;
}

/** Identity of one alert: its pane, task, and exact prompt. Dismissing keys on this so re-answering
 *  the *same* prompt stays hidden but a fresh/different approval re-surfaces the row. */
function rowKey(paneId: PaneId, task: Task): string {
  return `${paneId}:${task.id}:${task.approval?.prompt ?? ""}`;
}

export default function FleetApprovals() {
  // Alerts the operator dismissed without answering (UI-only): keyed by rowKey so a new approval on
  // the same pane reappears. The pane keeps its amber border — the agent is still genuinely blocked;
  // this only clears it out of the triage strip.
  const [dismissed, setDismissed] = createSignal(new Set<string>());
  const dismiss = (key: string) =>
    setDismissed((prev) => new Set(prev).add(key));
  const dismissAll = () => setDismissed((prev) => new Set([...prev, ...allKeys()]));

  // Every blocked row in the active workspace, before dismissal filtering (used to "clear all").
  const allRows = (): BlockedRow[] => {
    const ws = activeWorkspace();
    if (!ws) return [];
    const out: BlockedRow[] = [];
    for (const id of leafIds(ws.tree)) {
      const task = paneActiveTask(id);
      if (task?.state === "blocked" && task.approval) {
        out.push({
          paneId: id,
          name: ws.panes[id]?.title ?? `Pane ${id}`,
          agent: detectAgent(ws.panes[id]?.command),
          task,
        });
      }
    }
    return out;
  };
  const allKeys = () => allRows().map((r) => rowKey(r.paneId, r.task));

  // The blocked panes still worth showing (not dismissed). Reactive: reads the sessions store
  // (paneActiveTask), the active workspace's tree/panes, and the dismissed set.
  const blocked = (): BlockedRow[] => {
    const gone = dismissed();
    return allRows().filter((r) => !gone.has(rowKey(r.paneId, r.task)));
  };

  /** Write the answer to the blocked pane only, then resolve so the row clears. */
  function answer(paneId: PaneId, text: string) {
    const t = text.trim();
    if (!t || countLive([paneId]) === 0) return;
    writeToPanes([paneId], `${t}\r`);
    approvalResolve(paneId);
    clearAttention(paneId);
  }

  return (
    <Show when={blocked().length > 0}>
      <aside class="fleet-approvals" aria-label="Agents needing you">
        <div class="fa-head">
          <span class="fa-flag">⚑</span> NEEDS YOU · {blocked().length}
          <button
            class="fa-clear-all"
            title="Dismiss all alerts (panes stay flagged)"
            onClick={dismissAll}
          >
            clear all
          </button>
        </div>
        <div class="fa-rows">
          <For each={blocked()}>
            {(b) => (
              <ApprovalRow
                row={b}
                onAnswer={answer}
                onDismiss={() => dismiss(rowKey(b.paneId, b.task))}
              />
            )}
          </For>
        </div>
      </aside>
    </Show>
  );
}

function ApprovalRow(props: {
  row: BlockedRow;
  onAnswer: (id: PaneId, text: string) => void;
  onDismiss: () => void;
}) {
  const [draft, setDraft] = createSignal("");
  const approval = () => props.row.task.approval!;
  const send = (text: string) => {
    props.onAnswer(props.row.paneId, text);
    setDraft("");
  };

  return (
    <div class="fa-row" data-kind={approval().kind}>
      <button class="fa-pane" title="Reveal this pane" onClick={() => revealPane(props.row.paneId)}>
        <Show when={props.row.agent}>
          {(a) => (
            <span class="fa-agent" style={{ "--agent-color": a().color }}>{a().icon}</span>
          )}
        </Show>
        <span class="fa-name">{props.row.name}</span>
        <span class="fa-kind">{approval().kind}</span>
      </button>

      <span class="fa-prompt" title={approval().prompt}>{approval().prompt}</span>

      <div class="fa-actions">
        {/* When the agent pushed the real choices (e.g. AskUserQuestion), show them as buttons —
            selecting sends the option's 1-based ordinal, the menu's own number-key selection — instead
            of guessing y/n. y/n stays only for a genuine permission prompt with no options. */}
        <Show
          when={approval().options?.length}
          fallback={
            <Show when={approval().kind === "permission"}>
              <button class="fa-yn fa-yes" title="Answer yes" onClick={() => send("y")}>y</button>
              <button class="fa-yn fa-no" title="Answer no" onClick={() => send("n")}>n</button>
            </Show>
          }
        >
          <For each={approval().options}>
            {(opt, i) => (
              <button
                class="fa-opt"
                title={opt.description ?? opt.label}
                onClick={() => send(String(i() + 1))}
              >
                {i() + 1}. {opt.label}
              </button>
            )}
          </For>
        </Show>
        <input
          class="fa-input"
          type="text"
          placeholder="answer…"
          value={draft()}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && draft().trim()) {
              e.preventDefault();
              send(draft());
            }
          }}
        />
        <button class="fa-send" disabled={!draft().trim()} onClick={() => send(draft())}>
          Send ▸
        </button>
        <button
          class="fa-dismiss"
          title="Dismiss this alert (the pane stays flagged until the agent unblocks)"
          aria-label="Dismiss alert"
          onClick={() => props.onDismiss()}
        >
          ✕
        </button>
      </div>
    </div>
  );
}
