# v1 decisions that still hold

**Status:** Accepted (2026-09-12).

These v1 ADRs carry into v2 with the adjustments noted. The v1 files remain the detailed rationale.

| v1 ADR | Still holds as | v2 adjustment |
|---|---|---|
| 0003 Channel-first output transport | Terminal output is coalesced bytes, never per-line JSON | Coalescing lives in `sidecars/pty`; hub forwards base64 frames |
| 0004 Launch via login interactive shell | `pty` sessions run `$SHELL -l`, so PATH and rc files load | On Windows, PowerShell with the user's profile |
| 0005 Ctrl+Shift shortcut namespace | Loom only claims `Ctrl+Shift`; everything else reaches the terminal | Applies to the desktop and browser clients |
| 0006 Canvas renderer, not WebGL | xterm canvas renderer by default | WebGL may be enabled where the webview is not WebKitGTK |
| 0008 Agents first-class via self-report | Pushed signals beat kernel facts beat heuristics | Generalized in ADR-0004 |
| 0010 Interactive git, always user-confirmed | Loom never commits or pushes on its own | Commits come from sessions; Loom shows diffs |
| 0011 Heuristic output observer | Heuristics are opt-in per CLI and always labeled | Moves to herdr-style TOML screen manifests read by the hub, never in the byte hot path |

Dropped: 0001 (superseded in v1), 0002 (in-process PTYs, replaced by ADR-0001), 0007 (the bus becomes hub commands, ADR-0007), 0009 (replaced by ADR-0003), 0012 (relay deferred, ADR-0008).

## As built (M12, 2026-09-13): screen manifests

- Manifests are TOML files in `<config dir>/manifests/`, loaded only when their id is listed in `hub.json` `heuristics.enabled`. None ship built in; `docs/manifests/example.toml` documents the format.
- A manifest names programs (a session's agent, or its command's first word) and ordered rules of regular expressions for `working`, `blocked` (with `approval`, `question`, or `input`), and `idle`.
- For a matching terminal session the hub queues output as it arrives and, at most once a second, renders it in a headless terminal (`@xterm/headless`) and matches the screen's last non-empty lines, so redraws, colors, and cleared screens look as they do to a person. The first matching rule sets the state with provenance `heuristic`; the client shows "from screen".
- A session that reports a `pushed` state (hooks) is dropped from heuristics for good.
