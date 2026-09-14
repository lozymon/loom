import type { PermissionLevel } from "@loom/protocol";
import { createSignal, For, Show } from "solid-js";
import { useHub } from "../hub/store.ts";
import { MODEL_CHOICES } from "../lib/format.ts";
import { LevelSelect } from "./LevelSelect.tsx";

import { rememberDir as remember, recentDirs } from "../lib/recentDirs.ts";

type Kind = "chat" | "claude-terminal" | "terminal";

const KINDS: Array<{ id: Kind; label: string; hint: string }> = [
  { id: "chat", label: "Claude chat", hint: "Structured conversation with approvals, tools, and cost." },
  { id: "claude-terminal", label: "Claude terminal", hint: "Claude's own interface in a terminal, with approvals routed to Loom." },
  { id: "terminal", label: "Terminal", hint: "Your shell, or any command." },
];

export function NewSession(props: { onClose(): void }) {
  const { state, actions } = useHub();
  const [kind, setKind] = createSignal<Kind>("chat");
  const [command, setCommand] = createSignal("");
  const [useWorktree, setUseWorktree] = createSignal(false);
  const [branch, setBranch] = createSignal("");
  const [baseRef, setBaseRef] = createSignal("");
  const [cwd, setCwd] = createSignal(recentDirs(state.hub?.id)[0] ?? "");
  const [model, setModel] = createSignal("");
  const [level, setLevel] = createSignal<PermissionLevel>(state.hub?.defaultLevel ?? "supervised");
  const [prompt, setPrompt] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  const submit = async (e: Event) => {
    e.preventDefault();
    if (!cwd().trim()) return;
    setBusy(true);
    const base = {
      cwd: cwd().trim(),
      ...(useWorktree() && branch().trim() ? { worktree: { branch: branch().trim(), ...(baseRef().trim() ? { baseRef: baseRef().trim() } : {}) } } : {}),
    };
    const created = await actions.create(
      kind() === "terminal"
        ? { ...base, adapter: "pty", ...(command().trim() ? { command: command().trim() } : {}) }
        : kind() === "claude-terminal"
          ? { ...base, adapter: "pty", agent: "claude", level: level(), ...(model() ? { model: model() } : {}) }
          : {
              ...base,
              adapter: "claude-sdk",
              level: level(),
              ...(model() ? { model: model() } : {}),
              ...(prompt().trim() ? { prompt: prompt().trim() } : {}),
            },
    );
    setBusy(false);
    if (created) {
      remember(cwd().trim(), state.hub?.id);
      props.onClose();
    }
  };

  return (
    <div class="overlay" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <form class="dialog" onSubmit={submit} onKeyDown={(e) => e.key === "Escape" && props.onClose()}>
        <h2>New session</h2>
        <div class="segmented" role="radiogroup" aria-label="Session kind">
          <For each={KINDS}>
            {(k) => (
              <button
                type="button"
                role="radio"
                aria-checked={kind() === k.id}
                classList={{ selected: kind() === k.id }}
                onClick={() => setKind(k.id)}
                title={k.hint}
              >
                {k.label}
              </button>
            )}
          </For>
        </div>
        <p class="muted small hint">{KINDS.find((k) => k.id === kind())?.hint}</p>
        <label>
          <span>Working directory on {state.hub?.name ?? "the hub"}</span>
          <input
            list="recent-dirs"
            value={cwd()}
            onInput={(e) => setCwd(e.currentTarget.value)}
            placeholder={state.hub?.platform === "win32" ? "C:\\Users\\you\\code\\project" : "/home/you/code/project"}
            required
            autofocus
          />
          <datalist id="recent-dirs">
            <For each={recentDirs(state.hub?.id)}>{(d) => <option value={d} />}</For>
          </datalist>
        </label>
        <Show when={kind() === "terminal"}>
          <label>
            <span>Command (optional)</span>
            <input
              class="mono"
              value={command()}
              onInput={(e) => setCommand(e.currentTarget.value)}
              placeholder={state.hub?.platform === "win32" ? "empty for PowerShell" : "empty for your login shell"}
            />
          </label>
        </Show>
        <div class="row" classList={{ hidden: kind() === "terminal" }}>
          <label>
            <span>Model</span>
            <select value={model()} onChange={(e) => setModel(e.currentTarget.value)}>
              <For each={MODEL_CHOICES}>{(m) => <option value={m.id}>{m.label}</option>}</For>
            </select>
          </label>
          <label>
            <span>Permission level</span>
            <LevelSelect stewardOn={state.hub?.stewardModel ?? false} value={level()} max={state.hub?.maxLevel ?? "supervised"} onChange={setLevel} />
          </label>
        </div>
        <label class="inline">
          <input type="checkbox" checked={useWorktree()} onChange={(e) => setUseWorktree(e.currentTarget.checked)} />
          <span>Run in a git worktree on its own branch</span>
        </label>
        <Show when={useWorktree()}>
          <div class="row">
            <label>
              <span>Branch</span>
              <input class="mono" value={branch()} onInput={(e) => setBranch(e.currentTarget.value)} placeholder="loom/fix-login" required />
            </label>
            <label>
              <span>From (empty for HEAD)</span>
              <input class="mono" value={baseRef()} onInput={(e) => setBaseRef(e.currentTarget.value)} placeholder="origin/main" />
            </label>
          </div>
        </Show>
        <Show when={kind() === "chat"}>
          <label>
            <span>First message (optional)</span>
            <textarea rows={4} value={prompt()} onInput={(e) => setPrompt(e.currentTarget.value)} />
          </label>
        </Show>
        <Show when={state.error}>
          <div class="notice error">{state.error}</div>
        </Show>
        <div class="actions end">
          <button type="button" onClick={() => props.onClose()}>
            Cancel
          </button>
          <button type="submit" class="primary" disabled={busy() || !cwd().trim()}>
            {busy() ? "Starting…" : "Start session"}
          </button>
        </div>
      </form>
    </div>
  );
}
