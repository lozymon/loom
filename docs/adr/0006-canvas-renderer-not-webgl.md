# Terminal renderer: canvas-leading, DOM fallback, WebGL experimental-only

xterm.js 5.x defaults to a DOM renderer, with canvas (`@xterm/addon-canvas`) and WebGL (`@xterm/addon-webgl`) as opt-in addons. We lead with **canvas**, keep **DOM** as an ultra-safe fallback, and treat **WebGL as experimental opt-in only** — never the default. The instinctive perf choice is WebGL (it's fastest), but it is also the renderer most likely to be broken or janky inside WebKitGTK, where it can fail silently. The M0 flood test is the experiment that picks the winner empirically on the real webview; canvas is the leading hypothesis and the final choice is recorded after M0.

## Consequences

- Do not "optimize" the renderer to WebGL-by-default on WebKitGTK — it's deliberately not the default for compatibility reasons, not by oversight.
- If canvas underperforms or misrenders on WebKitGTK, fall back to DOM, not WebGL.
- The chosen renderer is validated/locked in M0 alongside the transport decision (ADR-0003).
