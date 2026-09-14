import type { PolicyFile, PolicyScope, PolicySourceView, PolicyView, RuleListName } from "@loom/protocol";
import { createResource, createSignal, For, Show } from "solid-js";
import { createStore } from "solid-js/store";
import { useHub } from "../hub/store.ts";

const LISTS: Array<{ id: RuleListName; label: string; hint: string }> = [
  { id: "deny", label: "Deny", hint: "Refused without asking. Beats every other rule." },
  { id: "ask", label: "Always ask", hint: "A person decides every time; no always-allow is offered." },
  { id: "allow", label: "Allow", hint: "Approved without asking. Project allow rules need trust on this hub." },
];

interface Draft {
  allow: string;
  deny: string;
  ask: string;
  timeout: string;
  then: "deny" | "steward";
}

function toDraft(p: PolicyFile): Draft {
  return {
    allow: p.allow.join("\n"),
    deny: p.deny.join("\n"),
    ask: p.ask.join("\n"),
    timeout: p.approvalTimeout ? String(p.approvalTimeout.minutes) : "",
    then: p.approvalTimeout?.then ?? "deny",
  };
}

function fromDraft(d: Draft): PolicyFile {
  const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);
  const minutes = Number.parseInt(d.timeout, 10);
  return {
    allow: lines(d.allow),
    deny: lines(d.deny),
    ask: lines(d.ask),
    ...(Number.isFinite(minutes) && minutes > 0 ? { approvalTimeout: { minutes, then: d.then } } : {}),
  };
}

/** View and edit the policy that applies to a session's project, and the hub policy. */
export function PolicyEditor(props: { cwd: string; onClose(): void }) {
  const { state, actions } = useHub();
  const [scope, setScope] = createSignal<PolicyScope>("project");
  const [view, { mutate }] = createResource(() => props.cwd, (cwd) => actions.policyGet(cwd));
  const [drafts, setDrafts] = createStore<{ hub?: Draft; project?: Draft }>({});
  const [saving, setSaving] = createSignal(false);

  const source = (v: PolicyView): PolicySourceView => (scope() === "hub" ? v.hub : v.project);
  const draft = (v: PolicyView): Draft => drafts[scope()] ?? toDraft(source(v).policy);
  const setField = (v: PolicyView, key: keyof Draft, value: string) => setDrafts(scope(), { ...draft(v), [key]: value } as Draft);

  const save = async (v: PolicyView) => {
    setSaving(true);
    const next = await actions.policySave(scope(), props.cwd, fromDraft(draft(v)));
    setSaving(false);
    if (next) {
      mutate(next);
      setDrafts(scope(), undefined);
    }
  };

  const trust = async (v: PolicyView) => {
    const next = await actions.policyTrust(props.cwd, v.project.allowHash);
    if (next) mutate(next);
  };

  return (
    <div class="overlay" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <section class="dialog policy-editor" onKeyDown={(e) => e.key === "Escape" && props.onClose()}>
        <header class="panel-head">
          <h2>Policy</h2>
          <div class="segmented small-seg" role="radiogroup">
            <button type="button" role="radio" aria-checked={scope() === "project"} classList={{ selected: scope() === "project" }} onClick={() => setScope("project")}>
              Project
            </button>
            <button type="button" role="radio" aria-checked={scope() === "hub"} classList={{ selected: scope() === "hub" }} onClick={() => setScope("hub")}>
              Hub
            </button>
          </div>
        </header>
        <Show when={view()} fallback={<p class="muted">Loading…</p>}>
          {(v) => (
            <>
              <p class="muted small mono">{source(v()).path}{source(v()).exists ? "" : " (not created yet)"}</p>
              <Show when={scope() === "project" && !v().project.trusted}>
                <div class="notice-box warn">
                  <strong>These allow rules are not trusted on this hub, so they do nothing yet.</strong>
                  <ul class="mono small">
                    <For each={v().project.policy.allow}>{(r) => <li>{r}</li>}</For>
                  </ul>
                  <button class="primary" onClick={() => void trust(v())}>
                    Trust these allow rules
                  </button>
                </div>
              </Show>
              <Show when={source(v()).loadError}>
                <div class="notice error">The file could not be read: {source(v()).loadError}</div>
              </Show>
              <For each={LISTS}>
                {(list) => (
                  <label class="rule-list">
                    <span>
                      {list.label} <span class="muted small">{list.hint}</span>
                    </span>
                    <textarea
                      class="mono"
                      rows={4}
                      spellcheck={false}
                      value={draft(v())[list.id]}
                      onInput={(e) => setField(v(), list.id, e.currentTarget.value)}
                      placeholder={list.id === "deny" ? "Bash(rm -rf *)\nRead(./.env)" : list.id === "ask" ? "Bash(git push *)" : "Bash(npm test *)\nRead"}
                    />
                  </label>
                )}
              </For>
              <label class="inline">
                <span class="muted">When nobody answers within</span>
                <input class="mono narrow" inputMode="numeric" value={draft(v()).timeout} onInput={(e) => setField(v(), "timeout", e.currentTarget.value)} placeholder="never" />
                <span class="muted">minutes,</span>
                <select value={draft(v()).then} onChange={(e) => setField(v(), "then", e.currentTarget.value)}>
                  <option value="deny">deny it</option>
                  <option value="steward" disabled={!state.hub?.stewardModel}>
                    let the Steward decide{state.hub?.stewardModel ? "" : " (off on this hub)"}
                  </option>
                </select>
              </label>
              <Show when={source(v()).problems.length > 0}>
                <ul class="problems">
                  <For each={source(v()).problems}>
                    {(p) => (
                      <li>
                        <span class="mono">{p.rule}</span> in {p.list}: {p.message}
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
              <div class="actions end">
                <button type="button" onClick={() => props.onClose()}>
                  Close
                </button>
                <button class="primary" disabled={saving()} onClick={() => void save(v())}>
                  {saving() ? "Saving…" : "Save"}
                </button>
              </div>
            </>
          )}
        </Show>
      </section>
    </div>
  );
}
