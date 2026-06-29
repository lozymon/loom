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

export default function FleetApprovals() {
  // The blocked panes of the active workspace, with their live blocked Task. Reactive: reads the
  // sessions store (paneActiveTask) and the active workspace's tree/panes.
  const blocked = (): BlockedRow[] => {
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
        </div>
        <div class="fa-rows">
          <For each={blocked()}>{(b) => <ApprovalRow row={b} onAnswer={answer} />}</For>
        </div>
      </aside>
    </Show>
  );
}

function ApprovalRow(props: { row: BlockedRow; onAnswer: (id: PaneId, text: string) => void }) {
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
        <Show when={approval().kind === "permission"}>
          <button class="fa-yn fa-yes" title="Answer yes" onClick={() => send("y")}>y</button>
          <button class="fa-yn fa-no" title="Answer no" onClick={() => send("n")}>n</button>
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
      </div>
    </div>
  );
}
