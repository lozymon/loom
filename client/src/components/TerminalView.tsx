import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { onCleanup, onMount } from "solid-js";
import { useHub } from "../hub/store.ts";
import { TerminalStream } from "../lib/terminalStream.ts";

const THEME = {
  background: "#0e0f12",
  foreground: "#e7e7ea",
  cursor: "#22d3ee",
  cursorAccent: "#0e0f12",
  selectionBackground: "rgba(34, 211, 238, 0.28)",
  black: "#1c1e24",
  red: "#e06c75",
  green: "#7fbf8f",
  yellow: "#d7b46a",
  blue: "#6fa8dc",
  magenta: "#c678dd",
  cyan: "#22d3ee",
  white: "#c8c8c8",
  brightBlack: "#5f6268",
  brightRed: "#ef8891",
  brightGreen: "#98d4a6",
  brightYellow: "#e8c883",
  brightBlue: "#8fbfee",
  brightMagenta: "#d69ae9",
  brightCyan: "#67e8f9",
  brightWhite: "#ffffff",
};

/**
 * A live terminal session. Bytes are opaque here too: xterm renders them, keystrokes go back as
 * bytes, and the hub owns the process (ADR-0001).
 */
export function TerminalView(props: { sessionId: string; focus?: boolean }) {
  const { actions } = useHub();
  let host!: HTMLDivElement;

  onMount(() => {
    const term = new Terminal({
      fontFamily: '"IBM Plex Mono", ui-monospace, "JetBrains Mono", "Cascadia Code", monospace',
      fontSize: 13,
      lineHeight: 1.15,
      scrollback: 10_000,
      cursorBlink: true,
      allowProposedApi: false,
      theme: THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(host);
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      // The DOM renderer is fine where WebGL is unavailable (v1 ADR-0006).
    }

    const stream = new TerminalStream(
      (bytes) => term.write(bytes),
      () => term.reset(),
    );
    let resyncing = false;
    const stop = actions.watchTerminal(props.sessionId, {
      snapshot: (offset, bytes) => {
        resyncing = false;
        stream.snapshot(offset, bytes);
      },
      data: (offset, bytes) => {
        // Missing bytes (e.g. frames dropped for a slow connection): ask for a fresh screen once.
        if (!stream.data(offset, bytes) && !resyncing) {
          resyncing = true;
          actions.resyncTerminal(props.sessionId);
        }
      },
    });

    const encoder = new TextEncoder();
    const input = term.onData((data) => actions.terminalInput(props.sessionId, encoder.encode(data)));
    const binary = term.onBinary((data) => {
      const bytes = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xff;
      actions.terminalInput(props.sessionId, bytes);
    });

    let lastSize = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refit = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!host.isConnected || host.clientWidth === 0) return;
        fit.fit();
        const size = `${term.cols}x${term.rows}`;
        if (size !== lastSize) {
          lastSize = size;
          actions.terminalResize(props.sessionId, term.cols, term.rows);
        }
      }, 60);
    };
    const observer = new ResizeObserver(refit);
    observer.observe(host);
    refit();
    if (props.focus !== false) term.focus();

    onCleanup(() => {
      clearTimeout(timer);
      observer.disconnect();
      input.dispose();
      binary.dispose();
      stop();
      term.dispose();
    });
  });

  return <div class="terminal-host" ref={host} />;
}
