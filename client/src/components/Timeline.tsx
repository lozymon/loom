import type { HubEvent } from "@loom/protocol";
import { createEffect, createMemo, createSignal, For, Match, on, Show, Switch } from "solid-js";
import { useHub } from "../hub/store.ts";
import { buildTimeline, describeResolution, type TimelineItem } from "../lib/timeline.ts";
import { Prose } from "./Prose.tsx";
import { ToolInput } from "./ToolInput.tsx";

/** The chat history of one session, kept scrolled to the bottom while you are at the bottom. */
export function Timeline(props: { events: HubEvent[]; working: boolean; focus?: { seq: number; n: number } | undefined }) {
  const items = createMemo(() => buildTimeline(props.events));
  let scroller!: HTMLDivElement;
  let pinned = true;

  // Scroll to an event from history search once it is loaded: the nearest item at or before it.
  createEffect(
    on([() => props.focus?.n, () => items().length], () => {
      const focus = props.focus;
      if (!focus || items().length === 0) return;
      const target = [...items()].reverse().find((i) => i.seq <= focus.seq);
      if (!target) return;
      queueMicrotask(() => {
        const el = scroller.querySelector<HTMLElement>(`[data-seq="${target.seq}"]`);
        if (!el) return;
        pinned = false;
        el.scrollIntoView({ block: "center" });
        el.classList.remove("flash");
        void el.offsetWidth;
        el.classList.add("flash");
      });
    }),
  );

  createEffect(
    on([() => props.events.length, () => props.working], () => {
      if (pinned) queueMicrotask(() => scroller.scrollTo({ top: scroller.scrollHeight }));
    }),
  );

  return (
    <div
      class="timeline"
      ref={scroller}
      onScroll={() => {
        pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
      }}
    >
      <For each={items()}>
        {(item) => (
          <div class="timeline-item" data-seq={item.seq}>
            <Item item={item} />
          </div>
        )}
      </For>
      <Show when={props.working}>
        <div class="working-indicator">
          <span class="pulse" /> working
        </div>
      </Show>
    </div>
  );
}

function Item(props: { item: TimelineItem }) {
  return (
    <Switch>
      <Match when={props.item.kind === "user" && props.item}>
        {(item) => (
          <div class="msg user" classList={{ peer: item().from === "session" || item().from === "cockpit" }}>
            <Show when={item().from !== "human"}>
              <span class="chip">{item().from === "session" ? "from another session" : item().from === "cockpit" ? "from the Cockpit" : item().from}</span>
            </Show>
            <div class="bubble">{item().text}</div>
          </div>
        )}
      </Match>
      <Match when={props.item.kind === "assistant" && props.item}>
        {(item) => (
          <div class="msg assistant" classList={{ nested: item().nested }}>
            <Prose text={item().text} />
          </div>
        )}
      </Match>
      <Match when={props.item.kind === "thinking" && props.item}>
        {(item) => (
          <details class="thinking">
            <summary>Thinking</summary>
            <Prose text={item().text} />
          </details>
        )}
      </Match>
      <Match when={props.item.kind === "tool" && props.item}>
        {(item) => (
          <details class="tool" classList={{ nested: item().nested, failed: item().result?.isError === true, pending: !item().result }}>
            <summary>
              <span class="tool-name">{item().toolName}</span>
              <span class="tool-brief">{brief(item().input)}</span>
            </summary>
            <ToolInput toolName={item().toolName} input={item().input} />
            <Show when={item().result}>
              {(result) => <pre class="code result">{result().preview || "(no output)"}</pre>}
            </Show>
          </details>
        )}
      </Match>
      <Match when={props.item.kind === "approval" && props.item}>{(item) => <ApprovalLine item={item()} />}</Match>
      <Match when={props.item.kind === "error" && props.item}>
        {(item) => <div class="notice error">{item().message}</div>}
      </Match>
      <Match when={props.item.kind === "speech" && props.item}>
        {(item) => (
          <div class="msg speech" title="Said out loud">
            <span class="speech-mark" aria-label="said">🔊</span> {item().text}
          </div>
        )}
      </Match>
      <Match when={props.item.kind === "notice" && props.item}>
        {(item) => <div class="notice">{item().text}</div>}
      </Match>
    </Switch>
  );
}

function ApprovalLine(props: { item: Extract<TimelineItem, { kind: "approval" }> }) {
  const { actions } = useHub();
  const [busy, setBusy] = createSignal(false);
  const res = () => props.item.resolution;
  const byStewardAllow = () => res()?.resolver === "steward" && res()?.decision.type === "allow";
  return (
    <div class="notice approval-line" classList={{ open: !res(), overridden: props.item.overridden !== undefined }}>
      <span class="approval-summary">{props.item.request.summary}</span>
      <span class="muted">
        {res() ? describeResolution(res()!.decision, res()!.resolver, res()!.rule) : props.item.steward?.status === "reviewing" ? "Steward is reviewing…" : "waiting for a decision"}
      </span>
      <Show when={res()?.resolver === "steward" && res()?.detail}>
        <span class="steward-reason">{res()!.detail}</span>
      </Show>
      <Show when={byStewardAllow() && props.item.overridden === undefined}>
        <button
          class="small-button danger"
          disabled={busy()}
          title="You don't approve this. The session drops to Supervised and the agent is told to undo it where it can."
          onClick={async () => {
            setBusy(true);
            await actions.override(props.item.request.id);
            setBusy(false);
          }}
        >
          Override
        </button>
      </Show>
      <Show when={props.item.overridden}>
        <span class="overridden-note">Overridden: {props.item.overridden}</span>
      </Show>
    </div>
  );
}

function brief(input: Record<string, unknown>): string {
  const v = input.command ?? input.file_path ?? input.url ?? input.pattern ?? input.query ?? input.description;
  if (typeof v !== "string") return "";
  const line = v.split("\n")[0] ?? "";
  return line.length > 100 ? `${line.slice(0, 99)}…` : line;
}
