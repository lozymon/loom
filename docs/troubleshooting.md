# Troubleshooting

## Where Loom keeps its files

| What | Location (Linux) |
|---|---|
| Workspaces & per-pane intent | `~/.config/com.loom.app/workspaces.json` |
| Logs | `~/.config/com.loom.app/logs/` |
| Control-bus socket | `$XDG_RUNTIME_DIR/loom.sock` (fallback `/tmp/loom-<user>.sock`) |

Loom persists *intent*, not scrollback: on launch it rebuilds each workspace tree and
**respawns** every pane's command in its cwd. Terminals are not restored to their previous
output — that's by design.

### Reset to a clean slate
Quit Loom, then move `workspaces.json` aside:

```
mv ~/.config/com.loom.app/workspaces.json{,.bak}
```

Relaunch and you'll start with an empty workspace. Restore the `.bak` to undo.

## Rendering / display

**Garbled text, blank panes, or GPU glitches.** Loom renders on the **canvas**
renderer by default (ADR-0006); the WebGL addon is optional and is the flaky path under
WebKitGTK. If you've enabled WebGL and see artifacts, turn it back off in Settings — canvas
is the supported default.

**A pane froze during a flood (`yes`, a huge `cat`).** Output is coalesced and
back-pressured in Rust specifically to keep the webview alive under floods (ADR-0003 /
ADR-0006). If a single pane locks the whole window, that's a regression — capture what the
pane was running and file it.

## `loom` / inter-pane control

**`loom: ...` errors, or `loom` not found.** `loom` only works *inside* a pane Loom
launched — that's where `LOOM_SOCK`, `LOOM_PANE`, and the `PATH` entry for `loom`
get injected. Check they're set:

```
echo "$LOOM_PANE @ $LOOM_SOCK"
command -v loom
```

If `LOOM_SOCK` is empty, you're not in a Loom pane (or you started a sub-shell
that scrubbed the environment).

**`loom` can't reach the app / "connection refused".** The app must be running. A stale
socket file left by a crash is detected and replaced on next launch; if `loom` still can't
connect, quit Loom fully and relaunch. The socket is per-user — `loom` from a different
user account won't reach your panes.

**Commands target the wrong pane.** Panes are addressed by **display name**, not index.
Run `loom list` to see current names; names can repeat across workspaces, so `loom focus` /
`loom send` resolve within reach of the caller's pane.

## Agent integration (MCP / hooks)

**MCP tools don't show up in Claude Code.** Confirm `loom mcp` is registered and that the
app is running when the agent starts. See [agent-mcp.md](agent-mcp.md). Note that
interactively-authenticated servers may be absent in headless/cron runs.

**Attention/status borders never light up.** Install the hooks profile
(`loom hooks --install`) and confirm the agent's hook events fire. See
[agent-hooks.md](agent-hooks.md).

## Build & dev

- Frontend typecheck: `npx tsc --noEmit`
- Unit tests: `npm test`
- Rust: `cargo check`, `cargo clippy`, `cargo fmt --check` (CI enforces rustfmt)
- Dev run: `npm run tauri dev`

If `npm run tauri dev` fails to open a window, confirm the platform prerequisites in the
[README](../README.md#prerequisites) (WebKitGTK, Rust toolchain).
