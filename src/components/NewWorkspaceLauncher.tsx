// The + on the rail (and Ctrl+Shift+T) opens this full-stage launcher. It takes over the stage
// where the grid normally sits — the rail and title bar stay put — rather than floating in a modal.
//
// The view reads top-to-bottom as one calm column:
//   • Working folder (native picker + Recents) + auto-filled workspace name.
//   • Layout — mini-grid preset tiles + a 1–16 slider.
//   • Fleet — one click fills every pane with a single agent (+ a Windows shell selector).
//   • "Customize each pane" (disclosure, collapsed by default) — the interactive grid where clicking
//     a pane sets its agent / command / cwd / seed individually.
// Quick-start presets (built-in + your saved ones) sit up top as a shortcut past the whole flow;
// "Save as preset" in the footer turns the current config into one.

import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { MOD_NAMESPACE } from "../lib/keybindings";
import { open } from "@tauri-apps/plugin-dialog";
import {
  createWorkspace, deletePreset, launchPreset, presets, recents, savePreset,
  type NewWorkspaceOpts,
} from "../stores/workspace";
import { settings } from "../stores/settings";
import { AGENTS, detectAgent } from "../lib/agents";
import { checkCommandAvailable } from "../lib/agentAvailability";
import { listWslDistros } from "../lib/ptyClient";
import { allocName, balancedBands } from "../lib/grid";

/** We only surface the shell picker on Windows, where PowerShell / cmd / WSL meaningfully differ.
 *  WebView2's UA carries "Windows"; WebKitGTK (Linux) does not. Zero-dependency platform sniff. */
const IS_WINDOWS = navigator.userAgent.includes("Windows");

const PRESETS = [1, 2, 4, 6];
const MAX_PANES = 16;

/** Final path segment of a folder, for the workspace name. Handles both `/` (Unix) and `\`
 * (Windows) separators so Windows paths like `C:\Users\me\proj` name the workspace `proj`. */
function basename(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** Capitalize the first letter, leaving the rest as-is (`src-tauri` → `Src-tauri`). */
function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** The default workspace name for a folder: its basename with the first letter capitalized. */
const autoName = (path: string): string => capitalize(basename(path));

/** A small diagram of how buildBalancedTree(n) will arrange its panes — used on the layout tiles. */
function MiniGrid(props: { n: number }) {
  return (
    <span class="wiz-mini">
      <For each={balancedBands(props.n)}>
        {(take) => (
          <span class="wiz-mini-row">
            <For each={Array.from({ length: take })}>{() => <span class="wiz-mini-cell" />}</For>
          </span>
        )}
      </For>
    </span>
  );
}

export default function NewWorkspaceLauncher(props: { onClose: () => void }) {
  const [cwd, setCwd] = createSignal(settings.defaultCwd);
  // Name tracks the folder's basename until the user types their own — then it sticks.
  const [name, setName] = createSignal(autoName(settings.defaultCwd));
  const [nameDirty, setNameDirty] = createSignal(false);
  const [count, setCount] = createSignal(4);
  const [commands, setCommands] = createSignal<string[]>([]);
  const [cwds, setCwds] = createSignal<string[]>([]);
  // Per-pane seed prompt (row-major); typed into the pane once on launch (AGENTIC §3a).
  const [prompts, setPrompts] = createSignal<string[]>([]);
  // Per-pane shell override (row-major); "" = global default (PowerShell on Windows). Windows-only.
  const [shells, setShells] = createSignal<string[]>([]);
  // Installed WSL distros, loaded once on Windows; each becomes a `wsl.exe -d <distro>` shell option.
  const [wslDistros, setWslDistros] = createSignal<string[]>([]);
  const [selected, setSelected] = createSignal<number | null>(null);
  // The per-pane grid is heavy machinery most fleets never touch — kept behind a disclosure so the
  // calm column stays calm. Opening it widens the column and reveals the interactive preview.
  const [customizeOpen, setCustomizeOpen] = createSignal(false);
  // Brief "Saved ✓" confirmation on the Save-as-preset button (also appears in the preset strip).
  const [justSaved, setJustSaved] = createSignal(false);
  let savedTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(savedTimer));
  // Pre-flight: command string → is its program installed? (undefined = unchecked/checking).
  // Filled async so we never block opening the launcher; drives the "⚠ not installed" hints.
  const [avail, setAvail] = createSignal<Record<string, boolean>>({});
  const checkAvail = (cmd: string) => {
    const key = cmd.trim();
    if (!key || key in avail()) return;
    void checkCommandAvailable(key).then((ok) => setAvail((m) => ({ ...m, [key]: ok })));
  };
  /** A command we've confirmed isn't installed (false), as opposed to unchecked (undefined). */
  const isMissing = (cmd: string | undefined) => avail()[(cmd ?? "").trim()] === false;
  // Probe the built-in agents up front so the fleet warnings show before any click, and pre-fill
  // every pane with the default fleet agent so the preview reflects it (matching the design).
  onMount(() => {
    AGENTS.forEach((a) => checkAvail(a.command));
    fillAll(fleetAgent());
    if (IS_WINDOWS) void listWslDistros().then(setWslDistros).catch(() => {});
  });

  // The shell choices offered per pane: PowerShell (the default), cmd, and one entry per WSL
  // distro. The value is the literal shell spec stored on the PaneSpec; "" means global default.
  const shellOptions = createMemo(() => {
    const opts = [
      { value: "", label: "PowerShell (default)" },
      { value: "cmd.exe", label: "Command Prompt" },
    ];
    for (const d of wslDistros()) opts.push({ value: `wsl.exe -d ${d}`, label: `WSL · ${d}` });
    return opts;
  });
  const shellLabel = (value: string) =>
    shellOptions().find((o) => o.value === value)?.label ?? value;

  // Auto-names exactly as buildWorkspace allocates them (Faye, Cleo, …) so the preview matches.
  const names = createMemo(() => {
    const taken: string[] = [];
    return Array.from({ length: count() }, () => {
      const nm = allocName(taken);
      taken.push(nm);
      return nm;
    });
  });
  const bands = createMemo(() => balancedBands(count()));
  // The agent the "Fill every pane with" dropdown applies (default Claude Code, matching the
  // design). Changing it fills every pane immediately — most fleets never need per-pane config.
  const [fleetAgent, setFleetAgent] = createSignal(AGENTS[0]?.command ?? "");
  // The shell the "Fill every pane with" row applies to every pane ("" = PowerShell default).
  const [fleetShell, setFleetShell] = createSignal("");

  // No availability probe here: this fires on every keystroke of the free-text cmd field, and a
  // probe spawns a login shell. The built-in agent commands are all probed up front (onMount);
  // a hand-typed command is covered after the fact by the pane's dead-pane overlay instead.
  const setCommandAt = (i: number, cmd: string) =>
    setCommands((c) => { const n = [...c]; n[i] = cmd; return n; });
  const setCwdAt = (i: number, dir: string) =>
    setCwds((c) => { const n = [...c]; n[i] = dir; return n; });
  const setShellAt = (i: number, sh: string) =>
    setShells((c) => { const n = [...c]; n[i] = sh; return n; });
  const setPromptAt = (i: number, p: string) =>
    setPrompts((c) => { const n = [...c]; n[i] = p; return n; });
  const fillAll = (cmd: string) => setCommands(Array.from({ length: count() }, () => cmd));
  const fillAllShells = (sh: string) => setShells(Array.from({ length: count() }, () => sh));

  // Changing the folder also refreshes the name, unless the user has hand-edited it.
  function applyCwd(next: string) {
    setCwd(next);
    if (!nameDirty()) setName(next.trim() ? autoName(next) : "");
  }

  async function browse() {
    const picked = await open({ directory: true, title: "Pick a working folder" });
    if (typeof picked === "string") applyCwd(picked);
  }
  async function browseCwdAt(i: number) {
    const picked = await open({ directory: true, title: "Folder for this terminal" });
    if (typeof picked === "string") setCwdAt(i, picked);
  }

  /** The current config as a NewWorkspaceOpts — shared by "Create workspace" and "Save as preset"
   *  so a saved preset relaunches to exactly what you'd have created. */
  function buildOpts(): NewWorkspaceOpts {
    const folder = cwd().trim();
    const cmds = commands().slice(0, count());
    const dirs = cwds().slice(0, count());
    const shs = shells().slice(0, count());
    const seeds = prompts().slice(0, count());
    const wsName = name().trim() || (folder ? autoName(folder) : `Workspace ${recents().length + 1}`);
    return {
      name: wsName,
      cwd: folder,
      paneCount: count(),
      commands: cmds.some((c) => c?.trim()) ? cmds : undefined,
      cwds: dirs.some((c) => c?.trim()) ? dirs : undefined,
      shells: shs.some((s) => s?.trim()) ? shs : undefined,
      prompts: seeds.some((s) => s?.trim()) ? seeds : undefined,
    };
  }

  function launch() {
    createWorkspace(buildOpts());
    props.onClose();
  }

  function saveAsPreset() {
    savePreset(buildOpts());
    setJustSaved(true);
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => setJustSaved(false), 1600);
  }

  function launchSaved(id: string) {
    const p = presets().find((x) => x.id === id);
    if (p) { launchPreset(p); props.onClose(); }
  }

  // Esc closes the launcher from anywhere (capture phase: xterm swallows Escape when a terminal
  // has focus, so a bubble listener wouldn't fire until you click off the pane).
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") props.onClose();
    else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) launch();
  };
  onMount(() => window.addEventListener("keydown", onKey, true));
  onCleanup(() => window.removeEventListener("keydown", onKey, true));

  // The built-in quick-start shortcuts (count + fleet agent in one tap). `on` highlights the
  // one that currently matches the live config.
  const CLAUDE = AGENTS[0]?.command ?? "";
  const quick = [
    { label: "Fleet ×4", n: 4, agent: CLAUDE },
    { label: "Web dev", n: 2, agent: "" },
    { label: "Blank", n: 1, agent: "" },
  ];
  const applyQuick = (n: number, agent: string) => {
    setCount(n); setFleetAgent(agent); fillAll(agent);
  };

  return (
    <div class="launcher">
      <div class="launcher-scroll">
        <div class="launcher-col">
          <header class="launcher-head">
            <div>
              <h1 class="launcher-title">New workspace</h1>
              <p class="launcher-sub">A folder, a grid of terminals, and an optional fleet of agents.</p>
            </div>
            <button class="launcher-x" title="Close (Esc)" onClick={() => props.onClose()}>×</button>
          </header>

          {/* Quick start — a shortcut past the whole flow. Built-in shapes + your saved presets. */}
          <div class="launcher-quick">
            <span class="launcher-quick-label">Quick start</span>
            <For each={quick}>
              {(q) => (
                <button
                  class="launcher-chip"
                  classList={{ on: count() === q.n && fleetAgent() === q.agent }}
                  onClick={() => applyQuick(q.n, q.agent)}
                >
                  {q.label}
                </button>
              )}
            </For>
            <For each={presets()}>
              {(p) => (
                <span class="launcher-chip-wrap">
                  <button
                    class="launcher-chip launcher-chip-preset"
                    title={`Launch “${p.name}” · ${p.paneCount} pane${p.paneCount === 1 ? "" : "s"}${p.commands?.some(Boolean) ? " · agents" : ""}`}
                    onClick={() => launchSaved(p.id)}
                  >
                    {p.name}
                  </button>
                  <button class="launcher-chip-del" title="Delete preset" onClick={() => deletePreset(p.id)}>✕</button>
                </span>
              )}
            </For>
          </div>

          {/* 1 — Working folder + name */}
          <section class="launcher-section">
            <div class="launcher-field">
              <label class="launcher-label">Working folder</label>
              <div class="wizard-row">
                <input
                  class="wizard-input"
                  placeholder="$HOME (default)"
                  value={cwd()}
                  onInput={(e) => applyCwd(e.currentTarget.value)}
                />
                <button onClick={browse}>Browse…</button>
              </div>
              <Show when={recents().length > 0}>
                <div class="wizard-recents">
                  <For each={recents()}>
                    {(r) => (
                      <button
                        class="wizard-recent"
                        title={`${r.cwd} · ${r.count} pane${r.count === 1 ? "" : "s"}`}
                        onClick={() => { applyCwd(r.cwd); setCount(r.count); }}
                      >
                        {basename(r.cwd)}
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            </div>

            <div class="launcher-field">
              <label class="launcher-label">Workspace name</label>
              <input
                class="wizard-input"
                placeholder="Workspace name"
                value={name()}
                onInput={(e) => { setName(e.currentTarget.value); setNameDirty(true); }}
              />
            </div>
          </section>

          {/* 2 — Layout */}
          <section class="launcher-section">
            <div class="wiz-row-head">
              <label class="launcher-label">Layout</label>
              <span class="wiz-panes-n">{count()} pane{count() === 1 ? "" : "s"}</span>
            </div>
            <div class="wiz-ltiles">
              <For each={PRESETS}>
                {(n) => (
                  <button class="wiz-ltile" classList={{ on: count() === n }} title={`${n} panes`} onClick={() => setCount(n)}>
                    <MiniGrid n={n} />
                  </button>
                )}
              </For>
              <input
                class="wiz-slider-inline"
                type="range" min="1" max={MAX_PANES} value={count()}
                title="Custom pane count"
                onInput={(e) => setCount(+e.currentTarget.value)}
              />
            </div>
          </section>

          {/* 3 — Fleet one-liner */}
          <section class="launcher-section">
            <div class="wiz-fleet-row">
              <span class="wiz-fleet-label">Fill every pane with</span>
              <select
                class="wiz-fleet-select"
                value={fleetAgent()}
                onChange={(e) => { setFleetAgent(e.currentTarget.value); fillAll(e.currentTarget.value); }}
              >
                <option value="">Shells</option>
                <For each={AGENTS}>
                  {(a) => <option value={a.command}>{a.label}{isMissing(a.command) ? " (not installed)" : ""}</option>}
                </For>
              </select>
              <Show when={IS_WINDOWS}>
                <span class="wiz-fleet-label">in</span>
                <select
                  class="wiz-fleet-select"
                  value={fleetShell()}
                  onChange={(e) => { setFleetShell(e.currentTarget.value); fillAllShells(e.currentTarget.value); }}
                >
                  <For each={shellOptions()}>
                    {(o) => <option value={o.value}>{o.label}</option>}
                  </For>
                </select>
              </Show>
            </div>
          </section>

          {/* 4 — Customize each pane (disclosure). Collapsed by default; opening widens the column
              and reveals the interactive grid + per-pane editor. */}
          <section class="launcher-section">
            <button
              class="launcher-disclosure"
              aria-expanded={customizeOpen()}
              onClick={() => setCustomizeOpen((v) => !v)}
            >
              <span class="launcher-caret" classList={{ open: customizeOpen() }}>▸</span>
              Customize each pane
              <span class="launcher-disclosure-hint">click a pane to set its agent, command, folder or seed</span>
            </button>

            <Show when={customizeOpen()}>
              <div class="launcher-customize">
                <div class="wiz-grid">
                  <For each={bands()}>
                    {(take, bandIdx) => {
                      const start = () => bands().slice(0, bandIdx()).reduce((a, b) => a + b, 0);
                      return (
                        <div class="wiz-grid-row">
                          <For each={Array.from({ length: take })}>
                            {(_, k) => {
                              const idx = () => start() + k();
                              const agent = () => detectAgent(commands()[idx()]);
                              return (
                                <button
                                  class="wiz-cell"
                                  classList={{ on: selected() === idx(), agent: !!agent(), "wiz-cell-missing": isMissing(commands()[idx()]) }}
                                  style={agent() ? { "--cell-accent": agent()!.color } : undefined}
                                  title={isMissing(commands()[idx()]) ? `${commands()[idx()]} isn't installed or not on PATH` : undefined}
                                  onClick={() => setSelected(idx())}
                                >
                                  <span class="wiz-cell-name">
                                    {names()[idx()]}
                                    <Show when={isMissing(commands()[idx()])}><span class="wiz-cell-warn" title="not installed">⚠</span></Show>
                                  </span>
                                  <span class="wiz-cell-agent">
                                    {commands()[idx()]?.trim() || "shell"}
                                    <Show when={cwds()[idx()]?.trim()}> · {basename(cwds()[idx()]!)}</Show>
                                    <Show when={shells()[idx()]?.trim()}> · {shellLabel(shells()[idx()]!)}</Show>
                                  </span>
                                </button>
                              );
                            }}
                          </For>
                        </div>
                      );
                    }}
                  </For>
                </div>

                <Show
                  when={selected() !== null && selected()! < count()}
                  fallback={<div class="wiz-editor-empty">Select a pane to configure it.</div>}
                >
                  {(() => {
                    const i = () => selected()!;
                    return (
                      <div class="wiz-editor">
                        <div class="wiz-editor-head">
                          <strong>{names()[i()]}</strong>
                          <button class="wiz-editor-x" title="Done" onClick={() => setSelected(null)}>✕</button>
                        </div>
                        <div class="wiz-fleet">
                          <For each={AGENTS}>
                            {(a) => (
                              <button
                                class="wiz-chip" style={{ "--chip": a.color }}
                                classList={{ on: detectAgent(commands()[i()])?.id === a.id, "wiz-chip-missing": isMissing(a.command) }}
                                title={isMissing(a.command) ? `${a.label} isn't installed or not on PATH` : a.label}
                                onClick={() => setCommandAt(i(), a.command)}
                              >
                                <span class="wiz-chip-ic">{a.icon}</span>{a.label}
                                <Show when={isMissing(a.command)}><span class="wiz-chip-warn" title="not installed">⚠</span></Show>
                              </button>
                            )}
                          </For>
                          <button class="wiz-chip wiz-chip-shell" classList={{ on: !commands()[i()]?.trim() }} onClick={() => setCommandAt(i(), "")}>
                            <span class="wiz-chip-ic">⌗</span>Shell
                          </button>
                        </div>
                        <div class="wizard-row">
                          <span class="muted" style={{ width: "5ch" }}>cmd</span>
                          <input
                            class="wizard-input" placeholder="$SHELL"
                            value={commands()[i()] ?? ""}
                            onInput={(e) => setCommandAt(i(), e.currentTarget.value)}
                          />
                        </div>
                        <div class="wizard-row">
                          <span class="muted" style={{ width: "5ch" }}>cwd</span>
                          <input
                            class="wizard-input" placeholder="(workspace folder)"
                            value={cwds()[i()] ?? ""}
                            onInput={(e) => setCwdAt(i(), e.currentTarget.value)}
                          />
                          <button onClick={() => browseCwdAt(i())}>Browse…</button>
                        </div>
                        <div class="wizard-row">
                          <span class="muted" style={{ width: "5ch" }} title="Typed into the pane once on launch">seed</span>
                          <input
                            class="wizard-input" placeholder="Initial prompt (optional) — briefs the agent on launch"
                            value={prompts()[i()] ?? ""}
                            onInput={(e) => setPromptAt(i(), e.currentTarget.value)}
                          />
                        </div>
                        <Show when={IS_WINDOWS}>
                          <div class="wizard-row">
                            <span class="muted" style={{ width: "5ch" }}>shell</span>
                            <select
                              class="wizard-input"
                              value={shells()[i()] ?? ""}
                              onChange={(e) => setShellAt(i(), e.currentTarget.value)}
                            >
                              <For each={shellOptions()}>
                                {(o) => <option value={o.value}>{o.label}</option>}
                              </For>
                            </select>
                          </div>
                        </Show>
                      </div>
                    );
                  })()}
                </Show>
              </div>
            </Show>
          </section>
        </div>
      </div>

      {/* Footer pinned to the bottom of the stage; centered actions mirror the column. */}
      <footer class="launcher-foot">
        <div class="launcher-foot-inner">
          <span class="wiz-foot-hint">{MOD_NAMESPACE}+T</span>
          <span class="spacer" />
          <button onClick={saveAsPreset}>{justSaved() ? "Saved ✓" : "Save as preset"}</button>
          <button onClick={() => props.onClose()}>Cancel</button>
          <button class="primary" onClick={launch}>Create workspace</button>
        </div>
      </footer>
    </div>
  );
}
