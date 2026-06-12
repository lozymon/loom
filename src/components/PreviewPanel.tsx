// Right-side preview panel (a "bigger bet" from IDEAS.md): a docked browser view for a localhost
// dev server, rendered docs, a dashboard — whatever you'd otherwise alt-tab to. It's a plain
// <iframe>, so it shows anything that doesn't refuse framing (most dev servers are fine; sites that
// set X-Frame-Options/CSP frame-ancestors won't — use "open externally" for those). Docked as a
// flex sibling of the stage, so opening it shrinks the grid and panes refit (their ResizeObserver).

import { createSignal, onMount } from "solid-js";
import { openUrl } from "@tauri-apps/plugin-opener";
import { settings, setSetting } from "../stores/settings";

const WIDTH_MIN = 320;
const WIDTH_MAX = 960;

/** Best-effort URL normalisation: bare host/port → http://…, ":3000" → http://localhost:3000. */
function normalize(input: string): string {
  const t = input.trim();
  if (!t) return "";
  if (/^https?:\/\//i.test(t)) return t;
  if (/^:\d+/.test(t)) return `http://localhost${t}`;
  return `http://${t}`;
}

export default function PreviewPanel(props: { onClose: () => void }) {
  const [url, setUrl] = createSignal(settings.previewUrl || "http://localhost:3000");
  let frame: HTMLIFrameElement | undefined;

  function go(raw?: string) {
    const u = normalize(raw ?? url());
    if (!u) return;
    setUrl(u);
    setSetting("previewUrl", u);
    if (frame) frame.src = u; // assigning src navigates (and reloads on an identical value)
  }
  function reload() {
    if (frame) frame.src = frame.src;
  }
  async function openExternal() {
    const u = normalize(url());
    if (u) try { await openUrl(u); } catch (e) { console.error("open external failed", e); }
  }

  onMount(() => { if (frame) frame.src = normalize(url()); });

  // Drag the left edge to resize; clamp + persist (mirrors the rail resizer).
  function onResizeDown(e: PointerEvent) {
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = settings.previewWidth;
    const move = (ev: PointerEvent) => {
      // Dragging left (smaller clientX) widens the right-docked panel.
      const w = Math.max(WIDTH_MIN, Math.min(WIDTH_MAX, startW + (startX - ev.clientX)));
      setSetting("previewWidth", w);
    };
    const up = (ev: PointerEvent) => {
      handle.releasePointerCapture(ev.pointerId);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  return (
    <aside class="preview-panel" style={{ "flex-basis": `${settings.previewWidth}px`, width: `${settings.previewWidth}px` }}>
      <div class="preview-resizer" title="Drag to resize" onPointerDown={onResizeDown} />
      <div class="preview-bar">
        <button class="preview-btn" title="Reload" onClick={reload}>⟳</button>
        <input
          class="preview-url"
          value={url()}
          spellcheck={false}
          placeholder="localhost:3000"
          onInput={(e) => setUrl(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); go(); } }}
        />
        <button class="preview-btn" title="Go" onClick={() => go()}>▸</button>
        <button class="preview-btn" title="Open in your browser" onClick={() => void openExternal()}>↗</button>
        <button class="preview-btn close" title="Close preview (Ctrl+Shift+B)" onClick={() => props.onClose()}>✕</button>
      </div>
      <iframe
        ref={frame}
        class="preview-frame"
        title="Preview"
        referrerpolicy="no-referrer"
        allow="clipboard-read; clipboard-write"
      />
    </aside>
  );
}
