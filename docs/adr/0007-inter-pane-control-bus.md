# Inter-pane control bus: a unix-socket relay, routing in TS

A process running *inside* a pane (typically a CLI agent like `claude`) has no way to
address another pane — by design, panes are opaque byte streams (ADR-0001) and the only
control surface is Tauri commands callable from the webview. But "from this agent, kick
off a second agent in the **Cleo** pane and hand it a task" is a core fleet-driving
workflow. We add an explicit, opt-in **control bus** so a pane process can `list`, `send`
to, and `spawn` panes — without breaking opacity (Termhaus still never reads pane *output*;
this is a separate inbound command channel the user's processes call deliberately).

## Decision

**Rust owns a unix-domain socket; the socket is a pure relay. All product logic stays in
TypeScript.** This preserves the project's golden split (CLAUDE.md): PTY/OS syscalls and
transport in Rust; naming, name→pane resolution, write routing, and layout mutation in
TS/SolidJS.

The round trip is **opaque to Rust** — it forwards a request *string*, never parsing the
protocol:

1. `th` (a tiny second cargo binary, std-only) connects to `$TERMHAUS_SOCK` and writes one
   newline-delimited JSON request, then blocks for one JSON response line.
2. The Rust accept loop reads the line, assigns a `reqId` (u32), parks the connection on a
   oneshot channel in a `PendingReplies` map, and emits a `termhaus://pane-cmd` Tauri event
   carrying `{ reqId, request }` — the raw request string, unparsed.
3. The frontend (`src/lib/paneControl.ts`) listens, parses the JSON, dispatches:
   - `list` → enumerate panes from the workspace store (name/live/focused/workspace),
   - `send` → resolve the target name to a `PaneId`, write via the existing pane registry
     (the same path the broadcast bar uses),
   - `spawn` → mutate the active workspace's layout tree to add a pane running a command.
   It then calls the `pane_cmd_reply(reqId, response)` command with a JSON result string.
4. Rust matches `reqId` back to the parked connection, writes the response line, closes.

**Discovery via env.** Each PTY child gets `TERMHAUS_SOCK` (socket path), `TERMHAUS_PANE`
(its own pane name, so an agent can say "spawn next to me"), and `TERMHAUS_CLI` (absolute
path to `th`); the CLI's directory is also prepended to the child `PATH`, so `th` is
directly invokable inside any pane in dev and packaged builds alike.

**Name resolution** prefers the active workspace, then falls back to a unique match across
all workspaces; an ambiguous name is an error listing the candidates. Names are the
frontend's `spec.title` (the NAME_POOL: Faye, Cleo, …) — there is no name registry in Rust.

## Why a unix socket (not TCP, not stdin tricks)

- **Same-user trust boundary for free.** The socket lives at
  `$XDG_RUNTIME_DIR/termhaus.sock` (dir is mode 0700) or `/tmp/termhaus-<uid>.sock`, created
  mode 0600. Only the user who launched Termhaus can connect — which is exactly the set of
  principals who can already drive the user's terminals by other means. No network exposure.
- **No new dependencies.** `std::os::unix::net` on the Rust side; `serde_json` (already a
  dep) for framing. The CLI is a second `[[bin]]` in the same crate.
- A stale socket from a crash is unlinked-then-rebound on startup; a second instance losing
  the bind logs and continues without the bus rather than failing to launch.

## Consequences

- This is an **inbound command channel**, deliberately distinct from ADR-0001's opacity rule
  (which forbids *parsing pane output*). We never tail or interpret what a pane prints; we
  only act on explicit requests the user's own processes send us. Opacity is intact.
- Rust gains no protocol knowledge: the request/response schema lives once in
  `src/ipc/protocol.ts`. Adding an op is a frontend-only change plus a CLI subcommand.
- Layout mutation from `spawn` reuses the same store ops as the UI, so a CLI-spawned pane is
  indistinguishable from a hand-split one (persisted, nameable, broadcast-targetable).
- Linux-only (unix sockets). A Windows port would swap the transport (named pipe) behind the
  same event/reply contract; out of scope for the Linux-first v1.
- If the webview isn't listening yet (startup race) or no pane matches, the request times
  out / returns an error and `th` exits non-zero — it never hangs a pane indefinitely.
