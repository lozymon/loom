import type { ApprovalRequest, PolicyScope, Question } from "@loom/protocol";
import { createSignal, For, Show } from "solid-js";
import { createStore } from "solid-js/store";
import { useHub } from "../hub/store.ts";
import { Countdown } from "./Countdown.tsx";
import { StewardNote } from "./StewardNote.tsx";
import { ToolInput } from "./ToolInput.tsx";

/** A pending approval: what the session wants, and the ways to answer it. */
export function ApprovalCard(props: { request: ApprovalRequest; sessionName?: string; selected?: boolean }) {
  return (
    <div
      class="approval-card"
      classList={{ question: props.request.kind === "question", selected: props.selected === true }}
      data-approval-id={props.request.id}
    >
      <Show
        when={props.request.kind === "permission"}
        fallback={<QuestionForm request={props.request as Extract<ApprovalRequest, { kind: "question" }>} {...(props.sessionName ? { sessionName: props.sessionName } : {})} />}
      >
        <PermissionForm request={props.request as Extract<ApprovalRequest, { kind: "permission" }>} {...(props.sessionName ? { sessionName: props.sessionName } : {})} />
      </Show>
    </div>
  );
}

function PermissionForm(props: { request: Extract<ApprovalRequest, { kind: "permission" }>; sessionName?: string }) {
  const { actions } = useHub();
  const [mode, setMode] = createSignal<"buttons" | "deny" | "rule">("buttons");
  const [message, setMessage] = createSignal("");
  const [rule, setRule] = createSignal(props.request.suggestedRule ?? "");
  const [scope, setScope] = createSignal<PolicyScope>("project");
  const [busy, setBusy] = createSignal(false);

  const decide = async (decision: Parameters<typeof actions.decide>[1]) => {
    setBusy(true);
    await actions.decide(props.request.id, decision);
    setBusy(false);
  };

  return (
    <>
      <div class="approval-head">
        <span class="approval-kind">Needs approval</span>
        <Show when={props.sessionName}>
          <span class="chip">{props.sessionName}</span>
        </Show>
        <span class="approval-summary">{props.request.summary}</span>
        <Show when={props.request.expiresAt}>{(until) => <Countdown until={until()} />}</Show>
      </div>
      <Show when={props.request.steward}>{(review) => <StewardNote review={review()} onAccept={(d) => void decide(d)} />}</Show>
      <Show when={props.request.mustAsk}>
        <div class="approval-reason must-ask">
          Always asks: {props.request.askRule?.rule} in {props.request.askRule?.scope === "hub" ? "hub" : "project"} policy
        </div>
      </Show>
      <Show when={props.request.reason}>
        <div class="approval-reason">{props.request.reason}</div>
      </Show>
      <ToolInput toolName={props.request.toolName} input={props.request.input} />
      <Show when={mode() === "buttons"}>
        <div class="actions">
          <button class="primary" disabled={busy()} onClick={() => decide({ type: "allow" })}>
            Allow
          </button>
          <Show when={!props.request.mustAsk}>
            <button disabled={busy()} onClick={() => setMode("rule")} title="Allow, and save a rule so calls like this are allowed">
              Always allow…
            </button>
          </Show>
          <button class="danger" disabled={busy()} onClick={() => setMode("deny")}>
            Deny…
          </button>
        </div>
      </Show>
      <Show when={mode() === "rule"}>
        <form
          class="rule-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (rule().trim()) void decide({ type: "allow-rule", rule: rule().trim(), scope: scope() });
          }}
        >
          <label>
            <span class="muted small">Rule to add to Loom policy</span>
            <input class="mono" value={rule()} onInput={(e) => setRule(e.currentTarget.value)} placeholder="Bash(npm test *)" autofocus />
          </label>
          <div class="actions">
            <select value={scope()} onChange={(e) => setScope(e.currentTarget.value as PolicyScope)}>
              <option value="project">This project's policy</option>
              <option value="hub">Hub policy (every project)</option>
            </select>
            <button class="primary" type="submit" disabled={busy() || !rule().trim()}>
              Allow and save rule
            </button>
            <Show when={props.request.canAlwaysAllow}>
              <button type="button" disabled={busy()} onClick={() => decide({ type: "allow-always" })} title="Let Claude Code save its own rule in .claude/settings.local.json">
                Save in Claude settings instead
              </button>
            </Show>
            <button type="button" onClick={() => setMode("buttons")}>
              Back
            </button>
          </div>
        </form>
      </Show>
      <Show when={mode() === "deny"}>
        <form
          class="actions"
          onSubmit={(e) => {
            e.preventDefault();
            void decide({ type: "deny", message: message().trim() || "The user denied this action." });
          }}
        >
          <input
            class="grow"
            placeholder="Tell Claude why, or what to do instead (optional)"
            value={message()}
            onInput={(e) => setMessage(e.currentTarget.value)}
            autofocus
          />
          <button class="danger" type="submit" disabled={busy()}>
            Deny
          </button>
          <button type="button" onClick={() => setMode("buttons")}>
            Back
          </button>
        </form>
      </Show>
    </>
  );
}

function QuestionForm(props: { request: Extract<ApprovalRequest, { kind: "question" }>; sessionName?: string }) {
  const { actions } = useHub();
  const [picked, setPicked] = createStore<Record<string, string[]>>({});
  const [other, setOther] = createStore<Record<string, string>>({});
  const [busy, setBusy] = createSignal(false);

  const toggle = (q: Question, label: string) => {
    const current = picked[q.question] ?? [];
    if (q.multiSelect) {
      setPicked(q.question, current.includes(label) ? current.filter((l) => l !== label) : [...current, label]);
    } else {
      setPicked(q.question, [label]);
      setOther(q.question, "");
    }
  };

  const answerFor = (q: Question): string | string[] | undefined => {
    const free = other[q.question]?.trim();
    const labels = picked[q.question] ?? [];
    if (q.multiSelect) {
      const all = free ? [...labels, free] : labels;
      return all.length ? all : undefined;
    }
    return free || labels[0];
  };

  const complete = () => props.request.questions.every((q) => answerFor(q) !== undefined);

  const submit = async () => {
    const answers: Record<string, string | string[]> = {};
    for (const q of props.request.questions) {
      const a = answerFor(q);
      if (a !== undefined) answers[q.question] = a;
    }
    setBusy(true);
    await actions.decide(props.request.id, { type: "answer", answers });
    setBusy(false);
  };

  return (
    <>
      <div class="approval-head">
        <span class="approval-kind">Question</span>
        <Show when={props.sessionName}>
          <span class="chip">{props.sessionName}</span>
        </Show>
        <Show when={props.request.expiresAt}>{(until) => <Countdown until={until()} />}</Show>
      </div>
      <For each={props.request.questions}>
        {(q) => (
          <fieldset class="question">
            <legend>
              <Show when={q.header}>
                <span class="chip">{q.header}</span>
              </Show>
              {q.question}
            </legend>
            <For each={q.options}>
              {(opt) => (
                <button
                  type="button"
                  class="option"
                  classList={{ selected: (picked[q.question] ?? []).includes(opt.label) }}
                  onClick={() => toggle(q, opt.label)}
                >
                  <span class="option-label">{opt.label}</span>
                  <Show when={opt.description}>
                    <span class="option-desc">{opt.description}</span>
                  </Show>
                </button>
              )}
            </For>
            <input
              placeholder={q.multiSelect ? "Something else (added to your picks)" : "Something else"}
              value={other[q.question] ?? ""}
              onInput={(e) => {
                setOther(q.question, e.currentTarget.value);
                if (!q.multiSelect && e.currentTarget.value) setPicked(q.question, []);
              }}
            />
          </fieldset>
        )}
      </For>
      <div class="actions">
        <button class="primary" disabled={busy() || !complete()} onClick={submit}>
          Answer
        </button>
        <button class="danger" disabled={busy()} onClick={() => actions.decide(props.request.id, { type: "deny", message: "The user declined to answer." })}>
          Decline
        </button>
      </div>
    </>
  );
}
