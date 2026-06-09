// The + on the rail opens this 3-step wizard (Start → Layout → Agents):
//  1. Start  — pick the working folder (native picker + Recents) every pane starts in.
//  2. Layout — a grid-preset tile (1/2/4/6/8/10/12) → buildBalancedTree(n) on launch.
//  3. Agents — optional per-pane launch command; "Open without AI" = all plain shells.

import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { open } from "@tauri-apps/plugin-dialog";
import { createWorkspace, deletePreset, launchPreset, presets, recents } from "../stores/workspace";
import { settings } from "../stores/settings";
import { AGENTS } from "../lib/agents";

const PRESETS = [1, 2, 4, 6, 8, 10, 12];

/** Final path segment of a folder, for the workspace name. */
function basename(path: string): string {
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}

export default function NewWorkspaceWizard(props: { onClose: () => void }) {
  const [step, setStep] = createSignal(1);
  const [cwd, setCwd] = createSignal(settings.defaultCwd);
  const [count, setCount] = createSignal(4);
  const [commands, setCommands] = createSignal<string[]>([]);

  async function browse() {
    const picked = await open({ directory: true, title: "Pick a working folder" });
    if (typeof picked === "string") setCwd(picked);
  }

  function launch(withCommands: boolean) {
    const folder = cwd().trim();
    createWorkspace({
      name: folder ? basename(folder) : `Workspace ${recents().length + 1}`,
      cwd: folder,
      paneCount: count(),
      commands: withCommands ? commands() : undefined,
    });
    props.onClose();
  }

  function launchSaved(id: string) {
    const p = presets().find((x) => x.id === id);
    if (p) { launchPreset(p); props.onClose(); }
  }

  // Esc closes the wizard from anywhere (the panel isn't focus-trapped), matching Settings
  // and GitPanel. Capture phase: while a terminal has focus, xterm stops propagation of
  // Escape (it sends \x1b to the PTY), so a bubble-phase listener wouldn't fire until you
  // click off the pane.
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") props.onClose();
  };
  onMount(() => window.addEventListener("keydown", onKey, true));
  onCleanup(() => window.removeEventListener("keydown", onKey, true));

  return (
    <div class="wizard-backdrop" onClick={() => props.onClose()}>
      <div class="wizard" onClick={(e) => e.stopPropagation()}>
        <header class="wizard-steps">
          <span classList={{ on: step() === 1 }}>1 · Start</span>
          <span classList={{ on: step() === 2 }}>2 · Layout</span>
          <span classList={{ on: step() === 3 }}>3 · Agents</span>
        </header>

        {/* Step 1 — working folder + presets + recents */}
        <Show when={step() === 1}>
          <div class="wizard-body">
            <Show when={presets().length > 0}>
              <div class="wizard-label">Presets · one-click relaunch</div>
              <div class="wizard-presets">
                <For each={presets()}>
                  {(p) => (
                    <div class="wizard-preset">
                      <button class="wizard-preset-go" onClick={() => launchSaved(p.id)}>
                        <span>{p.name}</span>
                        <span class="muted">{p.paneCount} panes{p.commands?.some(Boolean) ? " · agents" : ""}</span>
                      </button>
                      <button class="wizard-preset-del" title="Delete preset" onClick={() => deletePreset(p.id)}>✕</button>
                    </div>
                  )}
                </For>
              </div>
            </Show>
            <label class="wizard-label">Working folder</label>
            <div class="wizard-row">
              <input
                class="wizard-input"
                placeholder="$HOME (default)"
                value={cwd()}
                onInput={(e) => setCwd(e.currentTarget.value)}
              />
              <button onClick={browse}>Browse…</button>
            </div>
            <Show when={recents().length > 0}>
              <div class="wizard-label">Recent</div>
              <div class="wizard-recents">
                <For each={recents()}>
                  {(r) => (
                    <button class="wizard-recent" onClick={() => { setCwd(r.cwd); setCount(r.count); }}>
                      <span>{basename(r.cwd)}</span>
                      <span class="muted">{r.cwd} · {r.count}</span>
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </Show>

        {/* Step 2 — grid preset */}
        <Show when={step() === 2}>
          <div class="wizard-body">
            <label class="wizard-label">Terminals</label>
            <div class="wizard-tiles">
              <For each={PRESETS}>
                {(n) => (
                  <button class="wizard-tile" classList={{ on: count() === n }} onClick={() => setCount(n)}>
                    {n}
                  </button>
                )}
              </For>
            </div>
          </div>
        </Show>

        {/* Step 3 — per-pane commands */}
        <Show when={step() === 3}>
          <div class="wizard-body">
            <label class="wizard-label">Launch command per terminal (optional)</label>
            <div class="wizard-cmds">
              <For each={Array.from({ length: count() })}>
                {(_, i) => (
                  <div class="wizard-row">
                    <span class="muted" style={{ width: "5ch" }}>#{i() + 1}</span>
                    <input
                      class="wizard-input"
                      placeholder="$SHELL"
                      value={commands()[i()] ?? ""}
                      onInput={(e) => setCommands((c) => { const n = [...c]; n[i()] = e.currentTarget.value; return n; })}
                    />
                    <select
                      class="wizard-agent"
                      title="Quick-fill an AI agent command"
                      value=""
                      onChange={(e) => {
                        const cmd = e.currentTarget.value;
                        e.currentTarget.value = "";
                        if (cmd) setCommands((c) => { const n = [...c]; n[i()] = cmd; return n; });
                      }}
                    >
                      <option value="">+ agent</option>
                      <For each={AGENTS}>
                        {(a) => <option value={a.command}>{a.label}</option>}
                      </For>
                    </select>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>

        <footer class="wizard-foot">
          <button onClick={() => props.onClose()}>Cancel</button>
          <span class="spacer" />
          <Show when={step() > 1}>
            <button onClick={() => setStep((s) => s - 1)}>Back</button>
          </Show>
          <Show when={step() < 3}>
            <button onClick={() => setStep((s) => s + 1)}>Next</button>
          </Show>
          <Show when={step() === 2}>
            <button class="primary" onClick={() => launch(false)}>Open without AI</button>
          </Show>
          <Show when={step() === 3}>
            <button class="primary" onClick={() => launch(true)}>Launch</button>
          </Show>
        </footer>
      </div>
    </div>
  );
}
