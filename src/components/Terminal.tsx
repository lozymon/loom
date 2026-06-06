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
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import "@xterm/xterm/css/xterm.css";

import { spawnPty, writePty, resizePty, killPty } from "../lib/ptyClient";
import { registerPane, unregisterPane } from "../lib/paneRegistry";
import { currentTheme } from "../stores/theme";
import { settings } from "../stores/settings";
import type { Dir } from "../lib/layout";
import type { PaneId, PtyHandle } from "../ipc/protocol";
import {
  appState,
  focusPane,
  focusDir,
  splitPane,
  closePane,
  toggleZoom,
  renamePane,
  toggleBroadcastTarget,
  switchWorkspaceRelative,
  type WorkspaceUI,
} from "../stores/workspace";

const ARROW_DIR: Record<string, Dir> = {
  arrowleft: "left", arrowright: "right", arrowup: "up", arrowdown: "down",
};

export default function TerminalPane(props: { paneId: PaneId; ws: WorkspaceUI }) {
  let container!: HTMLDivElement;
  let term!: Terminal;
  let fit!: FitAddon;
  let search!: SearchAddon;
  let searchInput: HTMLInputElement | undefined;
  // The live PTY handle, or null before first spawn / after the child exits.
  let handle: PtyHandle | null = null;
  const [dead, setDead] = createSignal<number | null>(null);
  const [editing, setEditing] = createSignal(false);
  const [finding, setFinding] = createSignal(false);
  const [query, setQuery] = createSignal("");

  const spec = () => props.ws.panes[props.paneId];
  const isFocused = () => props.ws.focused === props.paneId;
  const inBroadcast = () => props.ws.broadcast.includes(props.paneId);

  /** Spawn a fresh PTY and bind it to this pane's xterm. Used for first run and respawn. */
  async function start() {
    if (handle !== null) return;
    setDead(null);
    try {
      handle = await spawnPty(
        {
          cols: term.cols,
          rows: term.rows,
          command: spec()?.command,
          cwd: props.ws.cwd || settings.defaultCwd || undefined,
          shell: settings.defaultShell || undefined,
        },
        (bytes) => term.write(bytes),
        (code) => {
          handle = null;
          term.write(`\r\n\x1b[2m[process exited: ${code}]\x1b[0m\r\n`);
          setDead(code);
        },
      );
    } catch (e) {
      term.write(`\r\n\x1b[31mfailed to spawn pty: ${e}\x1b[0m\r\n`);
    }
  }

  // ---- Clipboard (OS, via Tauri — reliable under WebKitGTK) --------------------------
  async function copySelection(): Promise<boolean> {
    const sel = term.getSelection();
    if (!sel) return false;
    try { await writeText(sel); } catch (e) { console.error("clipboard write failed", e); }
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
  function closeSearch() {
    setFinding(false);
    search.clearDecorations();
    term.focus();
  }
  function findNext() { if (query()) search.findNext(query(), SEARCH_OPTS); }
  function findPrev() { if (query()) search.findPrevious(query(), SEARCH_OPTS); }

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
    term.loadAddon(fit);
    term.loadAddon(search);
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

    // Copy-on-select (optional): mirror any selection straight to the OS clipboard.
    term.onSelectionChange(() => {
      if (!settings.copyOnSelect) return;
      const sel = term.getSelection();
      if (sel) void writeText(sel).catch((e) => console.error("clipboard write failed", e));
    });

    // Middle-click paste (optional, classic X11 behaviour) — paste into the PTY.
    container.addEventListener("auxclick", (e) => {
      if (e.button === 1 && settings.middleClickPaste) { e.preventDefault(); void pasteClipboard(); }
    });

    // App shortcuts live in the Ctrl+Shift namespace (ADR-0005). Intercept them before the
    // PTY; everything else (Ctrl+C SIGINT, arrows, fn keys) passes through untouched.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown" || !e.ctrlKey || !e.shiftKey) return true;
      const key = e.key.toLowerCase();
      if (key in ARROW_DIR) { focusDir(props.paneId, ARROW_DIR[key]); return false; }
      switch (key) {
        case "c": void copySelection(); return false; // copy selection (no selection → no-op)
        case "v": void pasteClipboard(); return false;
        case "f": openSearch(); return false;
        case "d": splitPane(props.paneId, "row"); return false; // split right
        case "e": splitPane(props.paneId, "col"); return false; // split down
        case "w": closePane(props.paneId); return false;
        case "enter": toggleZoom(props.paneId); return false;
        case "t": window.dispatchEvent(new CustomEvent("termhaus:new-workspace")); return false;
        case "pageup": switchWorkspaceRelative(-1); return false;
        case "pagedown": switchWorkspaceRelative(1); return false;
        default: return true;
      }
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
    });

    // Refit + tell the PTY whenever the box resizes (split, drag, zoom, window). Skip when
    // hidden (zoom) — a 0-size box would compute nonsense cols/rows.
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (container.clientWidth === 0 || container.clientHeight === 0) return;
        fit.fit();
        if (handle !== null) void resizePty(handle, term.cols, term.rows);
      });
    });
    ro.observe(container);

    onCleanup(() => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      unregisterPane(props.paneId);
      if (handle !== null) void killPty(handle);
      term.dispose();
    });

    await start();
  });

  return (
    <div
      class="pane"
      classList={{ focused: isFocused(), "bcast-target": appState.broadcastSelecting && inBroadcast() }}
      onPointerDown={() => focusPane(props.paneId)}
    >
      <div class="pane-title">
        <Show when={appState.broadcastSelecting}>
          <button
            class="bcast-toggle"
            classList={{ on: inBroadcast() }}
            title={inBroadcast() ? "In broadcast set" : "Add to broadcast set"}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => toggleBroadcastTarget(props.paneId)}
          >
            {inBroadcast() ? "◉" : "○"}
          </button>
        </Show>
        <Show
          when={editing()}
          fallback={
            <span class="pane-name" title="double-click to rename" onDblClick={() => setEditing(true)}>
              {spec()?.title}
            </span>
          }
        >
          <input
            class="pane-name-edit"
            value={spec()?.title ?? ""}
            autofocus
            onBlur={(e) => { renamePane(props.paneId, e.currentTarget.value); setEditing(false); }}
            onKeyDown={(e) => {
              if (e.key === "Enter") { renamePane(props.paneId, e.currentTarget.value); setEditing(false); }
              else if (e.key === "Escape") setEditing(false);
            }}
          />
        </Show>
        <span class="pane-controls">
          <button title="Find (Ctrl+Shift+F)" onClick={openSearch}>⌕</button>
          <button title="Split right (Ctrl+Shift+D)" onClick={() => splitPane(props.paneId, "row")}>▥</button>
          <button title="Split down (Ctrl+Shift+E)" onClick={() => splitPane(props.paneId, "col")}>▤</button>
          <button title="Zoom (Ctrl+Shift+Enter)" onClick={() => toggleZoom(props.paneId)}>
            {props.ws.zoomed === props.paneId ? "▢" : "⤢"}
          </button>
          <button title="Close (Ctrl+Shift+W)" onClick={() => closePane(props.paneId)}>✕</button>
        </span>
      </div>

      <div class="pane-term-wrap">
        <Show when={finding()}>
          <div class="pane-search" onPointerDown={(e) => e.stopPropagation()}>
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
            <button title="Previous (Shift+Enter)" onClick={findPrev}>↑</button>
            <button title="Next (Enter)" onClick={findNext}>↓</button>
            <button title="Close (Esc)" onClick={closeSearch}>✕</button>
          </div>
        </Show>
        <div ref={container} class="terminal-pane" />
        <Show when={dead() !== null}>
          <div class="pane-dead">
            <span>process exited ({dead()})</span>
            <button onClick={() => { term.clear(); void start(); }}>Restart</button>
          </div>
        </Show>
      </div>
    </div>
  );
}
