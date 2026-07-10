// The single-pane view rendered in a torn-off window (multi-window tear-off). It's a minimal
// xterm bound to an *already-running* PTY in the main process: on mount it claims that PTY's output
// stream via retargetPty (the main window had released it), then drives input/resize by handle —
// every pty_* command operates on the shared PtyManager, so this works from any window. Closing the
// window re-docks the pane (the main window listens for this window's destroyed event).

import { createEffect, onCleanup, onMount } from "solid-js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { CanvasAddon } from "@xterm/addon-canvas";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "@xterm/xterm/css/xterm.css";
import "../App.css";
import { retargetPty, writePty, resizePty } from "../lib/ptyClient";
import { appChord } from "../lib/keybindings";
import { stashScrollback, takeScrollback } from "../lib/scrollback";
import { settings } from "../stores/settings";
import { currentTheme } from "../stores/theme";

export default function DetachedPane(props: { paneId: number; handle: number; title: string }) {
  let container!: HTMLDivElement;
  let term: Terminal;
  let fit: FitAddon;
  let serialize: SerializeAddon;

  onMount(async () => {
    term = new Terminal({
      fontFamily: settings.fontFamily,
      fontSize: settings.fontSize,
      scrollback: settings.scrollback,
      cursorStyle: settings.cursorStyle,
      cursorBlink: settings.cursorBlink,
      allowProposedApi: true,
      theme: currentTheme().terminal,
    });
    fit = new FitAddon();
    serialize = new SerializeAddon();
    term.loadAddon(fit);
    term.loadAddon(serialize);
    term.loadAddon(new WebLinksAddon((_e, uri) => { void openUrl(uri); }));
    const uni = new Unicode11Addon();
    term.loadAddon(uni);
    term.unicode.activeVersion = "11";
    term.open(container);
    try { term.loadAddon(new CanvasAddon()); } catch (e) { console.error("canvas addon failed", e); }
    fit.fit();

    // Replay the buffer the main window serialized on tear-off, so this window opens with the pane's
    // painted history instead of blank — then claim the live stream so new output appends after it.
    const snap = takeScrollback(props.handle);
    if (snap) term.write(snap);

    // Claim the live PTY's stream (it kept running; the main window released it on tear-off).
    try {
      await retargetPty(
        props.handle,
        (bytes) => term.write(bytes),
        (code) => term.write(`\r\n\x1b[2m[process exited: ${code}]\x1b[0m\r\n`),
      );
      void resizePty(props.handle, term.cols, term.rows);
      term.focus();
    } catch (e) {
      term.write(`\r\n\x1b[31mthis pane is no longer available (${e}). Close this window to re-dock.\x1b[0m\r\n`);
    }

    // Belt-and-suspenders re-dock signal: besides the parent listening for this window's destroyed
    // event, emit one as the window closes so the main grid always reclaims the pane.
    const un = await getCurrentWindow().onCloseRequested(() => {
      // Hand this window's painted buffer back so the re-mounted grid pane replays it (vs blank).
      stashScrollback(props.handle, serialize);
      void emit("loom://redock", { paneId: props.paneId });
    });
    onCleanup(un);

    term.onData((data) => void writePty(props.handle, data));

    // Clipboard in the Ctrl+Shift namespace (ADR-0005), so plain Ctrl+C still reaches the PTY.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown" || !appChord(e)) return true;
      const k = e.key.toLowerCase();
      if (k === "c") {
        const sel = term.getSelection();
        if (sel) { void writeText(sel); e.preventDefault(); return false; }
      }
      if (k === "v") {
        e.preventDefault();
        // term.paste() brackets the text (ESC[200~ … ESC[201~) for apps in bracketed-paste mode
        // (claude/vim/…), so a multi-line paste doesn't submit line-by-line. See Terminal.tsx.
        void readText().then((t) => { if (t) term.paste(t); });
        return false;
      }
      return true;
    });

    const refit = () => {
      if (container.clientWidth === 0 || container.clientHeight === 0) return;
      fit.fit();
      void resizePty(props.handle, term.cols, term.rows);
      term.refresh(0, term.rows - 1);
    };
    const ro = new ResizeObserver(() => refit());
    ro.observe(container);
    onCleanup(() => { ro.disconnect(); term.dispose(); });
  });

  // Live-apply appearance/theme changes (the setting is shared via persisted store reads).
  createEffect(() => {
    const t = currentTheme().terminal;
    if (!term) return;
    term.options.fontFamily = settings.fontFamily;
    term.options.fontSize = settings.fontSize;
    term.options.theme = t;
    queueMicrotask(() => { try { fit.fit(); void resizePty(props.handle, term.cols, term.rows); } catch { /* not ready */ } });
  });

  return (
    <div class="detached-window">
      <div ref={container} class="detached-term" />
    </div>
  );
}
