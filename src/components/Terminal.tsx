// M2 pane: a title bar + one xterm.js instance bound to one Rust PTY. The pane owns its
// PTY lifecycle (spawn/write/resize/kill/respawn); the workspace store owns its place in
// the layout tree, its name, focus, and zoom. Canvas renderer (ADR-0006); fit addon drives
// pty_resize; Ctrl+Shift shortcuts are intercepted before the PTY (ADR-0005).
//
// M5 polish: shared theme/font, unicode11 widths, clickable web links (opened via the OS),
// copy/paste through the OS clipboard, and a per-pane scrollback search overlay — all on the
// Ctrl+Shift namespace, so plain Ctrl+C still reaches the PTY as SIGINT.

import { onMount, onCleanup, createEffect, createSignal, Show } from "solid-js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { CanvasAddon } from "@xterm/addon-canvas";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import { homeDir } from "@tauri-apps/api/path";
import { listen } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";

import { spawnPty, writePty, resizePty, killPty, cwdPty, busyPty, foregroundPty, retargetPty } from "../lib/ptyClient";
import { detachPaneToWindow, detachedHandle, forgetDetached } from "../lib/detach";
import { gitBranch } from "../lib/gitClient";
import { captureRegion } from "../lib/capture";
import { sessionLogPath } from "../lib/sessionLog";
import { claudeSessionExists } from "../lib/claudeSessions";
import { openEditorAt } from "../lib/editor";
import { dictateIntoPane } from "../lib/voceClient";
import { registerPane, unregisterPane } from "../lib/paneRegistry";
import { stashScrollback, takeScrollback } from "../lib/scrollback";
import { notifyAttention } from "../lib/notify";
import { activity, noteUnseen, noteBell, setBusy, noteAttention, seePane, forgetPane, clearStatus, setLogError, clearLogError } from "../stores/activity";
import { currentTheme } from "../stores/theme";
import { settings, adjustFontSize } from "../stores/settings";
import { actionForKey, formatBinding, isModifierKey, SWITCH_WORKSPACE_ACTIONS, type ActionId } from "../lib/keybindings";
import { detectAgent, resumeClaudeCommand } from "../lib/agents";
import { paneActiveTask } from "../stores/sessions";
import type { PaneId, PtyHandle, LogErrorEvent } from "../ipc/protocol";
import { LOG_ERROR_EVENT } from "../ipc/protocol";
import {
  appState,
  focusPane,
  focusDir,
  splitPane,
  closePane,
  clearPaneCommand,
  setPaneSessionId,
  reopenLastClosed,
  toggleZoom,
  toggleOverview,
  switchWorkspaceRelative,
  switchWorkspaceIndex,
  swapPanes,
  type WorkspaceUI,
} from "../stores/workspace";

// Pane-control icons — consistent stroke-SVG line icons (currentColor) replacing the old
// cryptic unicode glyphs. Trusted static markup → innerHTML is safe. The rarely-used actions
// live in the `⋯` overflow menu (I.more), where each carries a text label too.
const I: Record<string, string> = {
  splitRight:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2.3" y="3" width="11.4" height="10" rx="1.4"/><path d="M8 3v10"/></svg>',
  splitDown:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2.3" y="3" width="11.4" height="10" rx="1.4"/><path d="M2.3 8h11.4"/></svg>',
  zoom:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 3H13v3.5M13 3l-4.2 4.2"/><path d="M6.5 13H3V9.5M3 13l4.2-4.2"/></svg>',
  restore:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12.5 6.5H9V3M12.5 3 9 6.5"/><path d="M3.5 9.5H7V13M3.5 13 7 9.5"/></svg>',
  more:
    '<svg viewBox="0 0 16 16" fill="currentColor"><circle cx="3.8" cy="8" r="1.15"/><circle cx="8" cy="8" r="1.15"/><circle cx="12.2" cy="8" r="1.15"/></svg>',
  close:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>',
  restart:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"><path d="M12.6 8a4.6 4.6 0 1 1-1.4-3.3"/><path d="M12.9 2.4V5h-2.6"/></svg>',
  claude:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"><path d="M8 2.2l1.55 3.9 3.9 1.4-3.9 1.4L8 12.8 6.45 8.9 2.55 7.5l3.9-1.4z"/></svg>',
  editor:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"><path d="M10.8 2.6 13.4 5.2"/><path d="M12.1 1.3 4.4 9l-1.1 3.4 3.4-1.1L14.4 3.6z"/></svg>',
  find:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2 13.6 13.6"/></svg>',
  tearOff:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H3.4v9.6H13V8"/><path d="M9.6 2.5h4v4"/><path d="M13.6 2.5 8.4 7.7"/></svg>',
  log:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M3 4h10M3 8h10M3 12h6.5"/></svg>',
};

// Resolved once and cached: collapse a leading $HOME to "~" in the title-bar path. Resolves
// async; until it lands paths show in full, and the next poll picks up the abbreviation.
let homePrefix: string | null = null;
void homeDir().then((h) => { homePrefix = h.replace(/\/+$/, ""); }).catch(() => {});

function prettyCwd(dir: string): string {
  if (homePrefix && (dir === homePrefix || dir.startsWith(homePrefix + "/"))) {
    return "~" + dir.slice(homePrefix.length);
  }
  return dir;
}

/** Last segment of a path — the pane's folder-derived display name (e.g. "loom"). Accepts
 * both `/` and `\` so a Windows cwd (`C:\Users\me\proj`) resolves to its final segment. */
function basename(dir: string): string {
  const p = dir.replace(/[\\/]+$/, "");
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) || p : p;
}

// Per-pane metadata poll cadence (refreshLoc). The branch lookup is the costly bit — it spawns a
// `git` subprocess — so it's throttled hard: re-run only when the cwd changes, or every
// GIT_REFRESH_EVERY ticks to catch an in-pane `git checkout`. And pane interval starts are spread
// across POLL_STAGGER_SLOTS so N panes don't poll /proc+git in lockstep (the burst that, with the
// commands previously on the UI thread, froze the app for 1-2s every cycle).
const POLL_INTERVAL_MS = 2000;
const GIT_REFRESH_EVERY = 5; // ~10s at a stable cwd
const POLL_STAGGER_SLOTS = 8;

export default function TerminalPane(props: { paneId: PaneId; ws: WorkspaceUI }) {
  let container!: HTMLDivElement;
  let term!: Terminal;
  let fit!: FitAddon;
  let search!: SearchAddon;
  // Serializes this pane's buffer for the scrollback handoff on tear-off / re-dock (see scrollback.ts).
  let serialize!: SerializeAddon;
  let searchInput: HTMLInputElement | undefined;
  // The live PTY handle, or null before first spawn / after the child exits.
  let handle: PtyHandle | null = null;
  // Set true while tearing this pane off into its own window, so onCleanup unmounts the xterm
  // WITHOUT killing the PTY — the detached window takes over the live stream.
  let detaching = false;
  // True while the live PTY is the interactive shell we auto-opened after a command pane's
  // launch command (e.g. `claude`) exited — so the user keeps a usable terminal instead of a
  // dead pane. Gates the drop-to-shell to fire once: when *this* shell later exits (the user
  // typed `exit`), we let the pane die normally rather than looping a fresh shell forever.
  let currentIsShellDrop = false;
  // git-branch poll throttle: the last cwd we ran `git` for, and a tick counter so the subprocess
  // only fires on a cwd change or a slow refresh (the branch is rarely what changes).
  let lastGitCwd: string | null = null;
  let pollTick = 0;
  const [dead, setDead] = createSignal<number | null>(null);
  const [finding, setFinding] = createSignal(false);
  const [query, setQuery] = createSignal("");
  // Live match position from the SearchAddon: {index, count}. index is -1 when no active match.
  const [matches, setMatches] = createSignal<{ index: number; count: number }>({ index: -1, count: 0 });
  const [dragOver, setDragOver] = createSignal(false);
  // The `⋯` overflow menu (rarely-used pane actions). Closes on outside click / after any action.
  const [menuOpen, setMenuOpen] = createSignal(false);
  const runMenu = (fn: () => void | Promise<void>) => { setMenuOpen(false); void fn(); };
  createEffect(() => {
    if (!menuOpen()) return;
    const close = () => setMenuOpen(false);
    document.addEventListener("pointerdown", close);
    onCleanup(() => document.removeEventListener("pointerdown", close));
  });
  // Live shell location for the title bar: cwd (via /proc, ADR-0001's carve-out) + git branch.
  const [cwd, setCwd] = createSignal<string | null>(null);
  const [branch, setBranch] = createSignal<string | null>(null);
  // The live foreground command in this pane (polled from /proc), or null at the prompt.
  const [foreground, setForeground] = createSignal<string | null>(null);

  const spec = () => props.ws.panes[props.paneId];
  // Which AI agent (if any) this pane is running — drives the title-bar badge. Prefer the live
  // foreground process (catches `claude` launched via the ✦ button or typed by hand), and fall
  // back to the launch command (covers the gap before the first /proc poll). Both are metadata,
  // never pane output (opacity-safe; see agents.ts + ADR-0001).
  const agent = () => detectAgent(foreground()) ?? detectAgent(spec()?.command);
  const isFocused = () => props.ws.focused === props.paneId;
  /** Is the user actually looking at this pane right now? (active workspace + focused) */
  const looking = () => appState.activeId === props.ws.id && isFocused();
  const act = () => activity[props.paneId];
  // The pane's live agent Task — drives the overview fleet caption (ADR-0008).
  const task = () => paneActiveTask(props.paneId);

  // The single chip state dot (Frameless): one of working / idle / needs / dead, by precedence.
  // Derived purely from existing metadata (exit code + the activity store) — never pane output,
  // so it stays opacity-safe (ADR-0001). `needs` is the MCP/needs-input attention flag; `working`
  // is a live foreground command; everything else is `idle`.
  const paneState = (): "working" | "idle" | "needs" | "dead" => {
    if (dead() !== null) return "dead";
    if (act()?.attention) return "needs";
    if (act()?.busy === true) return "working";
    return "idle";
  };

  // The name shown in the title bar is the live folder (cwd basename) — it tracks `cd` so the bar
  // always tells you *where* the pane is. The pool name (Faye…) is only the fallback before the
  // first cwd read, and stays the pane's routing handle for `loom send`/broadcast (folder names
  // aren't unique) — only the display changes.
  const displayName = () => {
    const d = cwd();
    return d ? basename(d) : (spec()?.title ?? "");
  };

  // Stream bytes into xterm; flag unseen output when this pane isn't being looked at (ADR-0001:
  // we react to the *fact* of output, never its content). Shared by spawn + re-dock binding.
  const onOutput = (bytes: Uint8Array) => {
    term.write(bytes);
    if (!looking()) noteUnseen(props.paneId);
  };
  const onExit = (code: number) => {
    handle = null;
    setBusy(props.paneId, null);
    setForeground(null);
    // Drop into an interactive shell when a command pane's launch command finishes, so exiting
    // (e.g.) `claude` leaves you at a usable prompt rather than a dead pane. Fires once per launch
    // (currentIsShellDrop guards the follow-on `exit` from looping), and never for a 127
    // missing-binary exit — that keeps the "command not found" panel useful (Unix; on Windows a
    // missing command exits non-127 and just prints its error above the new shell).
    const hadCommand = !!spec()?.command?.trim();
    if (hadCommand && !currentIsShellDrop && code !== 127) {
      term.write(`\r\n\x1b[2m[process exited: ${code}] — opening shell\x1b[0m\r\n`);
      void start(true);
      return;
    }
    term.write(`\r\n\x1b[2m[process exited: ${code}]\x1b[0m\r\n`);
    setDead(code);
  };

  /** Spawn a fresh PTY and bind it to this pane's xterm — or, when re-docking from a torn-off
   *  window, rebind to the *existing* PTY (no respawn). Used for first run, respawn, and re-dock.
   *  `asShell` forces a plain interactive shell, ignoring the pane's launch command — used to drop
   *  to a shell after a command pane's command exits (see onExit). */
  async function start(asShell = false) {
    if (handle !== null) return;
    setDead(null);

    // Re-docking: a saved handle means this pane is a live PTY coming back from its own window.
    // Reclaim its output stream instead of spawning a new shell.
    const reattach = detachedHandle(props.paneId);
    if (reattach !== null) {
      try {
        handle = reattach;
        // Replay the buffer the detached window serialized on close, then resume the live stream so
        // new output appends after the restored history (vs the grid coming back blank).
        const snap = takeScrollback(reattach);
        if (snap) term.write(snap);
        await retargetPty(reattach, onOutput, onExit);
        if (handle !== null) void resizePty(handle, term.cols, term.rows);
      } catch (e) {
        handle = null;
        term.write(`\r\n\x1b[31mfailed to re-dock pane: ${e}\x1b[0m\r\n`);
      } finally {
        forgetDetached(props.paneId);
      }
      return;
    }

    // Resolve the opt-in session-log path (same file across respawns; null if logging off).
    const logPath = settings.sessionLogging
      ? (await sessionLogPath(props.ws.name, spec()?.title ?? "", props.paneId)) ?? undefined
      : undefined;
    // Claude resume: rewrite the launch command so a restart resumes this pane's own conversation
    // (first run pins a `--session-id`, later runs `--resume`; see lib/agents.ts). We pin the id
    // up front rather than reading it from output, so this stays opacity-safe (ADR-0001). A pinned
    // id only resumes if its transcript is actually on disk — otherwise it never got a conversation
    // (e.g. trust dialog), so we re-pin the same id and start fresh instead of a failing `--resume`.
    let command = asShell ? undefined : spec()?.command;
    if (!asShell) {
      const s = spec();
      if (s) {
        const sessionExists = s.sessionId ? await claudeSessionExists(s.sessionId) : false;
        const resolved = resumeClaudeCommand(s, {
          enabled: settings.resumeAgentSessions,
          newId: () => crypto.randomUUID(),
          sessionExists,
        });
        command = resolved.command;
        if (resolved.sessionId && resolved.sessionId !== s.sessionId)
          setPaneSessionId(props.paneId, resolved.sessionId);
      }
    }
    try {
      handle = await spawnPty(
        {
          cols: term.cols,
          rows: term.rows,
          command,
          // Per-pane cwd wins (e.g. a `loom spawn --cwd …` pane), then the workspace folder.
          cwd: spec()?.cwd || props.ws.cwd || settings.defaultCwd || undefined,
          // Per-pane shell (e.g. a WSL distro chosen in the wizard) wins over the global default.
          shell: spec()?.shell || settings.defaultShell || undefined,
          name: spec()?.title,
          logPath,
        },
        onOutput,
        onExit,
      );
      // Remember whether the live PTY is the auto-opened shell, so its eventual exit lets the
      // pane die instead of re-dropping. A normal launch/restart clears it (re-runs the command).
      currentIsShellDrop = asShell;
      // A fresh spawn re-opens the session-log file, so any prior write-failure flag is stale.
      clearLogError(props.paneId);
    } catch (e) {
      term.write(`\r\n\x1b[31mfailed to spawn pty: ${e}\x1b[0m\r\n`);
    }
  }

  // A pane's session-log write can break mid-stream (disk full, file removed); Rust emits
  // LOG_ERROR_EVENT instead of silently dropping bytes. Flag our own pane (matched by live
  // handle) so its log control shows the break rather than pretending to still record.
  onMount(() => {
    const un = listen<LogErrorEvent>(LOG_ERROR_EVENT, (e) => {
      if (e.payload.id === handle) setLogError(props.paneId, e.payload.error);
    });
    onCleanup(() => { void un.then((f) => f()); });
  });

  /** Tear this pane off into its own window: hand the live PTY's output to a new window and let
   *  the main grid show a placeholder until that window closes (the PTY itself never stops). */
  async function detachPane() {
    if (handle === null) return; // a dead pane has nothing to tear off
    detaching = true; // tell onCleanup not to kill the PTY when this Terminal unmounts
    // Snapshot the painted buffer so the new window can replay it — retargetPty only moves the live
    // stream, so without this the torn-off pane would start blank (history lives in xterm, not the PTY).
    stashScrollback(handle, serialize);
    try {
      await detachPaneToWindow(props.paneId, handle, spec()?.title ?? displayName());
    } catch {
      detaching = false; // window didn't open — detachPaneToWindow already re-docked us
    }
  }

  // ---- Clipboard (OS, via Tauri — reliable under WebKitGTK) --------------------------
  // The last non-empty xterm selection, mirrored here on every selection change. Under
  // WebKitGTK 2.5x the visual selection can already be cleared by the time the Ctrl+Shift+C
  // keydown handler runs, so `term.getSelection()` returns "" and the copy is lost; this cache
  // is the fallback so the copy keybinding always has the text the user actually highlighted.
  let lastSelection = "";

  async function copySelection(): Promise<boolean> {
    const sel = term.getSelection() || lastSelection;
    if (!sel) return false;
    try {
      await writeText(sel);
    } catch (e) {
      console.error("clipboard write failed", e);
      return false;
    }
    return true;
  }

  async function pasteClipboard() {
    try {
      const text = await readText();
      if (text && handle !== null) void writePty(handle, text);
    } catch (e) {
      console.error("clipboard read failed", e);
    }
  }

  // Capture a screen region → PNG, then type its path into this pane (with a trailing space,
  // no Enter) so it lands in the prompt — e.g. a Claude Code message referencing the image.
  async function captureToPane() {
    try {
      const path = await captureRegion();
      if (path && handle !== null) {
        await writePty(handle, `${path} `);
        term.focus();
      }
    } catch (e) {
      // A cancelled selection or a missing screenshot tool both land here. A missing tool is
      // otherwise invisible (it looks like a dead shortcut), so for that case type a harmless
      // shell comment into the pane as an install hint; the user can run it (a no-op) or clear
      // it. Cancellation stays silent. The marker substring is set in capture.rs.
      const msg = String((e as { message?: string })?.message ?? e);
      if (msg.includes("no screenshot tool") && handle !== null) {
        await writePty(handle, "# Loom: screenshot tool not found — install flameshot or gnome-screenshot ");
        term.focus();
      }
      console.error("region capture failed", e);
    }
  }

  // Launch the Claude CLI in this pane's shell. The shell is already sitting in the
  // terminal's current directory, so a bare `claude` runs in exactly that cwd.
  function launchClaude() {
    if (handle === null) return;
    void writePty(handle, "claude\n");
    term.focus();
  }

  // ---- Title-bar location (cwd + git branch) -----------------------------------------
  // Panes are opaque (ADR-0001) — we can't watch the shell's output for `cd`, so we poll
  // /proc for the live cwd and derive the branch from it. Cheap: one /proc readlink + one
  // `git rev-parse` per tick, only while this pane's workspace is visible.
  async function refreshLoc() {
    if (handle === null) { setCwd(null); setBranch(null); setForeground(null); setBusy(props.paneId, null); lastGitCwd = null; return; }
    pollTick++;
    // Busy state (running a command vs. at the prompt) — a cheap foreground-pgrp read. A
    // busy→idle transition in a pane you're not watching means a command just finished and the
    // shell is back at its prompt → raise the sticky attention border (cleared when you look).
    // It's the foreground-pgrp fact, never pane output (opacity-safe; ADR-0001).
    try {
      const wasBusy = act()?.busy === true;
      const nowBusy = await busyPty(handle);
      if (wasBusy && nowBusy === false && !looking() && noteAttention(props.paneId)) {
        void notifyAttention(displayName() || `Pane ${props.paneId}`, props.ws.name);
      }
      setBusy(props.paneId, nowBusy);
    } catch { /* leave last value */ }
    // The live foreground command, for the agent badge (e.g. `claude`); null at the prompt.
    try { setForeground(await foregroundPty(handle)); } catch { /* leave last value */ }
    let dir: string | null = null;
    try { dir = await cwdPty(handle); } catch { return; }
    setCwd(dir);
    if (!dir) { setBranch(null); lastGitCwd = null; return; }
    // Only spawn `git` when the cwd changed, or every GIT_REFRESH_EVERY ticks as a slow refresh to
    // catch an in-pane `git checkout`. Skips the per-tick subprocess for a pane sitting still.
    if (dir !== lastGitCwd || pollTick % GIT_REFRESH_EVERY === 0) {
      lastGitCwd = dir;
      try { setBranch(await gitBranch(dir)); } catch { setBranch(null); }
    }
  }

  // ---- Search overlay ----------------------------------------------------------------
  const SEARCH_OPTS = {
    decorations: {
      matchBackground: "#5b8cff66", matchOverviewRuler: "#5b8cff",
      activeMatchBackground: "#e0b85a", activeMatchColorOverviewRuler: "#e0b85a",
    },
  };
  function openSearch() {
    setFinding(true);
    queueMicrotask(() => searchInput?.focus());
  }
  // Resolve this pane's on-disk session log and hand it to the viewer (shared by the menu row
  // and the `session-log` shortcut). No-op unless session logging is enabled.
  async function openSessionLog() {
    if (!settings.sessionLogging) return;
    const path = await sessionLogPath(props.ws.name, spec()?.title ?? "", props.paneId);
    window.dispatchEvent(new CustomEvent("loom:view-session-log", { detail: { path: path ?? undefined } }));
  }
  function closeSearch() {
    setFinding(false);
    setQuery("");
    setMatches({ index: -1, count: 0 });
    search.clearDecorations();
    term.focus();
  }
  function findNext() { if (query()) search.findNext(query(), SEARCH_OPTS); }
  function findPrev() { if (query()) search.findPrevious(query(), SEARCH_OPTS); }

  // ---- Scrollback read (loom read) -----------------------------------------------------
  // Return the last `lines` rows of this pane's buffer as plain text. Only reached on an
  // explicit inbound `loom read` request (ADR-0007), never to drive Loom's own UI.
  function readScrollback(lines: number): string {
    const buf = term.buffer.active;
    const total = buf.length; // scrollback + viewport rows
    const want = Math.max(1, Math.min(lines, total));
    const out: string[] = [];
    for (let i = total - want; i < total; i++) {
      const line = buf.getLine(i);
      out.push(line ? line.translateToString(true) : "");
    }
    // Drop trailing blank lines (the empty viewport below the prompt) for a tidy capture.
    while (out.length > 1 && out[out.length - 1] === "") out.pop();
    return out.join("\n");
  }

  onMount(async () => {
    term = new Terminal({
      fontFamily: settings.fontFamily,
      fontSize: settings.fontSize,
      scrollback: settings.scrollback,
      cursorStyle: settings.cursorStyle,
      cursorBlink: settings.cursorBlink,
      allowProposedApi: true, // required by the unicode11 addon
      theme: currentTheme().terminal,
    });

    fit = new FitAddon();
    search = new SearchAddon();
    serialize = new SerializeAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    // Keep the overlay's match counter in sync with the addon. resultIndex is -1 when there's
    // no active match (empty query or no hits); xterm reports it 0-based, we show it 1-based.
    search.onDidChangeResults((r) => setMatches({ index: r.resultIndex, count: r.resultCount }));
    term.loadAddon(serialize);
    term.loadAddon(new WebLinksAddon((_e, uri) => { void openUrl(uri); }));
    const uni = new Unicode11Addon();
    term.loadAddon(uni);
    term.unicode.activeVersion = "11";
    term.open(container);
    try {
      term.loadAddon(new CanvasAddon());
    } catch (e) {
      console.error("canvas renderer unavailable, using DOM renderer", e);
    }
    fit.fit();

    // Restyle live when the active theme changes — every open pane reacts.
    createEffect(() => {
      term.options.theme = currentTheme().terminal;
    });

    // Live-apply appearance settings. Font changes alter the cell size, so refit + tell the
    // PTY its new cols/rows; cursor/scrollback are pure xterm option flips.
    createEffect(() => {
      term.options.fontFamily = settings.fontFamily;
      term.options.fontSize = settings.fontSize;
      if (container.clientWidth > 0 && container.clientHeight > 0) {
        fit.fit();
        if (handle !== null) void resizePty(handle, term.cols, term.rows);
      }
    });
    createEffect(() => {
      term.options.cursorStyle = settings.cursorStyle;
      term.options.cursorBlink = settings.cursorBlink;
      term.options.scrollback = settings.scrollback;
    });

    // Poll the cwd/branch only while this workspace is on screen — hidden layers don't burn
    // /proc reads or git calls (CLAUDE.md: throttle hidden Workspaces). The effect re-runs on
    // activeId changes, tearing down the old timers first via onCleanup. The first read fires
    // right away (snappy title bar on switch); the recurring interval is offset per pane so the
    // ticks don't all land in the same frame.
    createEffect(() => {
      if (appState.activeId !== props.ws.id) return;
      void refreshLoc();
      const stagger = (props.paneId % POLL_STAGGER_SLOTS) * (POLL_INTERVAL_MS / POLL_STAGGER_SLOTS);
      let interval: ReturnType<typeof setInterval> | undefined;
      const start = setTimeout(() => {
        interval = setInterval(() => void refreshLoc(), POLL_INTERVAL_MS);
      }, stagger);
      onCleanup(() => { clearTimeout(start); if (interval) clearInterval(interval); });
    });

    // Repaint when this workspace is shown again. Hidden workspaces are display:none'd, and the
    // canvas renderer under WebKitGTK leaves a blank surface behind — so after a workspace
    // switch the terminal looks black until a click forces a redraw. On becoming active, wait
    // one frame for display:block to land (so the box has real dimensions), re-fit (it may have
    // been resized while hidden), then force a full refresh.
    createEffect(() => {
      if (appState.activeId !== props.ws.id) return;
      const raf = requestAnimationFrame(() => {
        if (container.clientWidth === 0 || container.clientHeight === 0) return;
        fit.fit();
        if (handle !== null) void resizePty(handle, term.cols, term.rows);
        term.refresh(0, term.rows - 1);
      });
      onCleanup(() => cancelAnimationFrame(raf));
    });

    // Keep real keyboard focus in sync with the focus ring. When this pane becomes the
    // workspace's focused pane (e.g. via Ctrl+Shift+arrow nav, which only moves the store's
    // `focused`), pull DOM focus onto its xterm — otherwise typing and the *next* nav keypress
    // would still target the previously-focused pane. Guard to the active workspace so hidden
    // layers don't grab focus, and skip while the title/search inputs are taking input.
    createEffect(() => {
      if (appState.activeId === props.ws.id && isFocused() && !finding()) {
        term.focus();
      }
    });

    // The terminal bell (BEL) is an attention signal — agents/builds often ring on
    // done/needs-input. Note it unless you're already looking at this pane.
    term.onBell(() => { if (!looking()) noteBell(props.paneId); });

    // Clear a pane's sticky unseen/bell signals the moment you look at it (focus it in the
    // active workspace). Separate from the focus-pull effect so it isn't gated on editing/find.
    createEffect(() => { if (looking()) seePane(props.paneId); });

    // Keep the last-selection cache current (used by copySelection when the live selection has
    // already been cleared), and mirror to the clipboard immediately when copy-on-select is on.
    term.onSelectionChange(() => {
      const sel = term.getSelection();
      if (!sel) return;
      lastSelection = sel;
      if (settings.copyOnSelect) void writeText(sel).catch((e) => console.error("clipboard write failed", e));
    });

    // Middle-click paste (optional, classic X11 behaviour) — paste into the PTY.
    container.addEventListener("auxclick", (e) => {
      if (e.button === 1 && settings.middleClickPaste) { e.preventDefault(); void pasteClipboard(); }
    });

    // App shortcuts live in the Ctrl+Shift namespace (ADR-0005). Intercept them before the
    // PTY; everything else (Ctrl+C SIGINT, arrows, fn keys) passes through untouched. The
    // final key of each combo is user-configurable — look it up in the live bindings map.
    const ACTIONS: Record<ActionId, () => void> = {
      "focus-up": () => focusDir(props.paneId, "up"),
      "focus-down": () => focusDir(props.paneId, "down"),
      "focus-left": () => focusDir(props.paneId, "left"),
      "focus-right": () => focusDir(props.paneId, "right"),
      "split-right": () => splitPane(props.paneId, "row"),
      "split-down": () => splitPane(props.paneId, "col"),
      "close-pane": () => closePane(props.paneId),
      "toggle-zoom": () => toggleZoom(props.paneId),
      "open-editor": () => void openEditorAt(cwd() || spec()?.cwd || props.ws.cwd || settings.defaultCwd || ""),
      "launch-claude": () => launchClaude(),
      "dictate": () => void dictateIntoPane(props.paneId, spec()?.title ?? ""),
      "detach-pane": () => void detachPane(),
      "session-log": () => void openSessionLog(),
      "new-workspace": () => window.dispatchEvent(new CustomEvent("loom:new-workspace")),
      "reopen-closed": () => reopenLastClosed(),
      "reopen": () => window.dispatchEvent(new CustomEvent("loom:reopen")),
      "history": () => window.dispatchEvent(new CustomEvent("loom:history")),
      "command-palette": () => window.dispatchEvent(new CustomEvent("loom:command-palette")),
      "source-control": () => window.dispatchEvent(new CustomEvent("loom:source-control")),
      "docs": () => window.dispatchEvent(new CustomEvent("loom:docs")),
      "settings": () => window.dispatchEvent(new CustomEvent("loom:settings")),
      "overview": () => toggleOverview(),
      "shortcuts": () => window.dispatchEvent(new CustomEvent("loom:shortcuts")),
      "prev-workspace": () => switchWorkspaceRelative(-1),
      "next-workspace": () => switchWorkspaceRelative(1),
      // Ctrl+Shift+1…9 → jump straight to workspace N.
      ...(Object.fromEntries(
        SWITCH_WORKSPACE_ACTIONS.map((id, i) => [id, () => switchWorkspaceIndex(i)]),
      ) as Record<(typeof SWITCH_WORKSPACE_ACTIONS)[number], () => void>),
      "copy": () => void copySelection(), // no selection → no-op
      "paste": () => void pasteClipboard(),
      "search": () => openSearch(),
      "capture-region": () => void captureToPane(),
      "font-increase": () => adjustFontSize(1),
      "font-decrease": () => adjustFontSize(-1),
    };
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown" || !e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return true;
      if (isModifierKey(e.key)) return true;
      const action = actionForKey(settings.keybindings, e.key);
      if (!action) return true;
      // Stop the webview's native handling too. WebKitGTK treats Ctrl+Shift+V / Ctrl+Shift+C
      // as clipboard shortcuts: without preventDefault it would *also* paste into the textarea
      // (firing xterm's onData) on top of our pasteClipboard(), doubling the input.
      e.preventDefault();
      ACTIONS[action]();
      return false;
    });

    term.onData((data) => {
      if (handle !== null) void writePty(handle, data);
    });
    term.textarea?.addEventListener("focus", () => focusPane(props.paneId));

    // Publish this pane to the broadcast router. `handle` reflects live/dead via closure,
    // so a Restart re-arms reach without re-registering.
    registerPane(props.paneId, {
      write: (data) => { if (handle !== null) void writePty(handle, data); },
      isLive: () => handle !== null,
      cwd: () => (handle !== null ? cwdPty(handle) : Promise.resolve(null)),
      read: (lines) => readScrollback(lines),
    });

    // Refit + tell the PTY whenever the box resizes (split, drag, zoom, window). Skip when
    // hidden (zoom) — a 0-size box would compute nonsense cols/rows.
    //
    // fit.fit() reflows xterm's whole scrollback to the new column count — too heavy to run
    // every frame of a gutter drag (that's the resize stutter). The CSS box already tracks
    // the pointer 1:1, so we debounce the reflow: it fires once movement settles (~100ms),
    // keeping discrete resizes (split/zoom/window) imperceptibly delayed while a live drag
    // stays smooth.
    let settle = 0;
    const refit = () => {
      if (container.clientWidth === 0 || container.clientHeight === 0) return;
      fit.fit();
      if (handle !== null) void resizePty(handle, term.cols, term.rows);
      // Force a repaint too: a box going from hidden→shown (un-zoom, window restore) keeps a
      // blank canvas under WebKitGTK until xterm redraws it.
      term.refresh(0, term.rows - 1);
    };
    const ro = new ResizeObserver(() => {
      clearTimeout(settle);
      settle = window.setTimeout(refit, 100);
    });
    ro.observe(container);

    onCleanup(() => {
      clearTimeout(settle);
      ro.disconnect();
      unregisterPane(props.paneId);
      forgetPane(props.paneId);
      // Detaching hands the PTY to another window — keep it alive; otherwise this unmount is a
      // real close, so kill the child.
      if (handle !== null && !detaching) void killPty(handle);
      term.dispose();
    });

    await start();
  });

  return (
    <div
      class="pane"
      data-state={paneState()}
      classList={{
        focused: isFocused(),
        attention: !isFocused() && (act()?.attention ?? false),
        agented: !!agent(),
        "drag-over": dragOver(),
      }}
      style={agent() ? { "--agent-color": agent()!.color } : undefined}
      onPointerDown={() => focusPane(props.paneId)}
      onDragOver={(e) => { e.preventDefault(); if (!dragOver()) setDragOver(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false); }}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const src = Number(e.dataTransfer?.getData("text/plain"));
        if (src) swapPanes(src, props.paneId);
      }}
    >
      {/* Floating identity chip (top-left). Glass card carrying the state dot + name + branch/status.
          The chip is also the drag handle for swapping panes (drop target is the .pane below). */}
      <div
        class="pane-chip"
        title={cwd() ? prettyCwd(cwd()!) : (spec()?.title ?? "")}
        draggable={true}
        onDragStart={(e) => {
          e.dataTransfer?.setData("text/plain", String(props.paneId));
          if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
        }}
      >
        <span
          class="pane-dot"
          data-state={paneState()}
          title={
            paneState() === "dead" ? "Exited" :
            paneState() === "needs" ? "Needs you" :
            paneState() === "working" ? "Working" : "Idle"
          }
        />
        {/* Secondary group-tint dot — the per-agent grouping signal in the fleet (overview) view,
            where the icon badge is hidden for space. State (the dot above) stays primary. */}
        <Show when={agent()}>
          <span class="pane-tint-dot" title={`Group: ${agent()!.label}`} />
        </Show>
        <Show when={agent()}>
          {(a) => (
            <span class="pane-agent" style={{ "--agent-color": a().color }} title={`Running ${a().label}`}>
              {a().icon}
            </span>
          )}
        </Show>
        <span class="pane-name">{displayName()}</span>
        <Show
          when={act()?.status}
          fallback={
            <Show when={branch()}>
              <span class="pane-branch" title={`git branch: ${branch()}`}>⎇ {branch()}</span>
            </Show>
          }
        >
          {(s) => (
            <span class="pane-statuslabel" data-state={paneState()} title={`agent status: ${s()}`}>{s()}</span>
          )}
        </Show>
        <Show when={act()?.listening}>
          <span class="pane-listening" title="Listening… (voice dictation)">🎙</span>
        </Show>
      </div>

      {/* Uppercase state label (top-right) — the primary fleet signal; shown only in overview,
          where the hit overlay intercepts the hover controls. */}
      <span class="pane-state-label" data-state={paneState()}>
        {paneState() === "dead"
          ? `EXITED · ${dead() ?? ""}`.trim()
          : paneState() === "needs" ? "NEEDS YOU" : paneState().toUpperCase()}
      </span>

      {/* Fleet caption (overview only, ADR-0008): the live agent Task — its title + files touched,
          tinted for a "needs you" pane. CSS hides it outside overview. */}
      <Show when={task()}>
        {(t) => (
          <div class="pane-fleet" data-state={paneState()}>
            <span class="pf-task" title={t().title}>{t().title}</span>
            <span class="pf-meta">
              <Show when={t().files.length}>
                <span>{t().files.length} file{t().files.length === 1 ? "" : "s"}</span>
              </Show>
            </span>
          </div>
        )}
      </Show>

      {/* Controls (top-right): revealed on pane hover only; a dead pane swaps in restart.
          Core actions (split/zoom/close) stay inline; the rest live in the `⋯` overflow menu. */}
      <div class="pane-ctl pctl" classList={{ "menu-open": menuOpen() }}>
        <Show
          when={dead() === null}
          fallback={
            <button class="pane-ctl-restart" title="Restart" onClick={() => { term.clear(); clearStatus(props.paneId); void start(); }} innerHTML={I.restart} />
          }
        >
          <Show when={settings.editorCommand.trim()}>
            <button
              title={`Open in editor (${formatBinding(settings.keybindings["open-editor"])})`}
              onClick={() => void openEditorAt(cwd() || spec()?.cwd || props.ws.cwd || settings.defaultCwd || "")}
              innerHTML={I.editor}
            />
          </Show>
          <button title="Split right (Ctrl+Shift+D)" onClick={() => splitPane(props.paneId, "row")} innerHTML={I.splitRight} />
          <button
            title="Zoom (Ctrl+Shift+Enter)"
            onClick={() => toggleZoom(props.paneId)}
            innerHTML={props.ws.zoomed === props.paneId ? I.restore : I.zoom}
          />
          <div class="pane-ctl-more" onPointerDown={(e) => e.stopPropagation()}>
            <button title="More actions" classList={{ on: menuOpen() }} onClick={() => setMenuOpen((v) => !v)} innerHTML={I.more} />
            <Show when={menuOpen()}>
              <div class="pane-menu">
                <button class="pane-menu-item" onClick={() => runMenu(launchClaude)}>
                  <span class="pmi-ico" innerHTML={I.claude} />Launch Claude here
                  <span class="pmi-key">{formatBinding(settings.keybindings["launch-claude"])}</span>
                </button>
                <button class="pane-menu-item" onClick={() => runMenu(openSearch)}>
                  <span class="pmi-ico" innerHTML={I.find} />Find in scrollback
                  <span class="pmi-key">{formatBinding(settings.keybindings["search"])}</span>
                </button>
                <button class="pane-menu-item" onClick={() => runMenu(() => splitPane(props.paneId, "col"))}>
                  <span class="pmi-ico" innerHTML={I.splitDown} />Split down
                  <span class="pmi-key">{formatBinding(settings.keybindings["split-down"])}</span>
                </button>
                <button class="pane-menu-item" onClick={() => runMenu(() => void detachPane())}>
                  <span class="pmi-ico" innerHTML={I.tearOff} />Tear off into window
                  <span class="pmi-key">{formatBinding(settings.keybindings["detach-pane"])}</span>
                </button>
                <Show when={settings.sessionLogging}>
                  <button class="pane-menu-item" onClick={() => runMenu(openSessionLog)}>
                    <span class="pmi-ico" innerHTML={I.log} />View session log
                    <Show when={act()?.logError}>
                      <span class="pmi-warn" title={`Session logging stopped: ${act()!.logError}\nRestart the pane to resume.`}>⚠</span>
                    </Show>
                    <span class="pmi-key">{formatBinding(settings.keybindings["session-log"])}</span>
                  </button>
                </Show>
              </div>
            </Show>
          </div>
        </Show>
        <button class="pane-ctl-close" title="Close (Ctrl+Shift+W)" onClick={() => closePane(props.paneId)} innerHTML={I.close} />
      </div>

      <div class="pane-term-wrap">
        <Show when={finding()}>
          <div
            class="pane-search"
            classList={{ "is-empty": query().length === 0, "no-match": query().length > 0 && matches().count === 0 }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <div class="pane-search-field">
              <svg class="pane-search-icon" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                <circle cx="7" cy="7" r="4.25" fill="none" stroke="currentColor" stroke-width="1.5" />
                <line x1="10.3" y1="10.3" x2="13.5" y2="13.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
              </svg>
              <input
                ref={searchInput}
                class="pane-search-input"
                placeholder="Find in scrollback"
                value={query()}
                onInput={(e) => { setQuery(e.currentTarget.value); findNext(); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); e.shiftKey ? findPrev() : findNext(); }
                  else if (e.key === "Escape") { e.preventDefault(); closeSearch(); }
                }}
              />
              <Show when={query().length > 0}>
                <span class="pane-search-count">
                  {matches().count === 0 ? "No results" : `${matches().index + 1}/${matches().count}`}
                </span>
              </Show>
            </div>
            <div class="pane-search-nav">
              <button title="Previous (Shift+Enter)" disabled={matches().count === 0} onClick={findPrev}>↑</button>
              <button title="Next (Enter)" disabled={matches().count === 0} onClick={findNext}>↓</button>
            </div>
            <button class="pane-search-close" title="Close (Esc)" onClick={closeSearch}>✕</button>
          </div>
        </Show>
        <div ref={container} class="terminal-pane" />
        <Show when={dead() !== null}>
          {(() => {
            const cmd = () => spec()?.command?.trim() ?? "";
            const prog = () => cmd().split(/\s+/)[0];
            const restart = () => { term.clear(); clearStatus(props.paneId); void start(); };
            const openShell = () => { clearPaneCommand(props.paneId); restart(); };
            return (
              <div class="pane-dead">
                {/* Exit 127 from `$SHELL -lc "<cmd>"` means the program wasn't found — the common
                    case of launching an agent (e.g. copilot) that isn't installed. Say so plainly
                    instead of a bare "process exited (127)", which reads as a crash. */}
                <Show
                  when={dead() === 127 && cmd()}
                  fallback={<span class="pane-dead-msg">process exited ({dead()})</span>}
                >
                  <span class="pane-dead-msg">command not found: {cmd()}</span>
                  <span class="pane-dead-hint">“{prog()}” isn’t installed or not on your PATH</span>
                </Show>
                <div class="pane-dead-actions">
                  <button onClick={restart}>Restart</button>
                  <Show when={cmd()}>
                    <button onClick={openShell}>Open shell instead</button>
                  </Show>
                </div>
              </div>
            );
          })()}
        </Show>
      </div>
    </div>
  );
}
