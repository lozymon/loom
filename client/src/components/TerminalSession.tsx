import { createMemo, For, Show } from "solid-js";
import { useHub } from "../hub/store.ts";
import { ApprovalCard } from "./ApprovalCard.tsx";
import { TerminalView } from "./TerminalView.tsx";

/** A terminal session: the terminal, its approvals when it runs an agent, and restart after exit. */
export function TerminalSession(props: { sessionId: string }) {
  const { state, actions } = useHub();
  const session = () => state.sessions[props.sessionId];
  const pending = createMemo(() =>
    Object.values(state.approvals)
      .filter((a) => a.sessionId === props.sessionId)
      .sort((a, b) => a.requestedAt - b.requestedAt),
  );
  const ended = () => {
    const s = session();
    return s !== undefined && !s.live && (s.state === "done" || s.state === "error");
  };

  return (
    <>
      <Show when={ended()}>
        <div class="banner" classList={{ error: session()?.state === "error" }}>
          <span>
            {session()?.exitCode !== undefined ? `Exited with code ${session()!.exitCode}.` : "Not running."}
            {session()?.agent ? " Restart resumes the conversation." : ""}
          </span>
          <button class="primary" onClick={() => void actions.restart(props.sessionId)}>
            Restart
          </button>
        </div>
      </Show>
      <Show when={pending().length > 0}>
        <div class="approvals docked">
          <For each={pending()}>{(request) => <ApprovalCard request={request} />}</For>
        </div>
      </Show>
      <TerminalView sessionId={props.sessionId} />
    </>
  );
}
