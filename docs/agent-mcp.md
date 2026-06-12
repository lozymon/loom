# Termhaus MCP server — drive the fleet as agent tools

`th-mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server that exposes the
Termhaus control bus ([ADR-0007](adr/0007-inter-pane-control-bus.md)) as first-class **tools** an
agent can call. It's the model-native face of the same relay the [`th` CLI](agent-hooks.md) drives
— each tool builds the identical `ControlRequest` JSON and forwards it over `$TERMHAUS_SOCK`, so the
`th` CLI and `th-mcp` are two front-ends to one bus. This is step **C** of the agent-integration arc
in [IDEAS.md](IDEAS.md): the model *plans with* Termhaus ("spawn a pane to run tests while I edit")
instead of shelling out.

It stays inside the opacity rule ([ADR-0001](adr/0001-opaque-panes-no-agent-awareness.md)): these
are inbound *commands* (and an explicit, requested `read_pane`), never inference from pane output.

## Tools

| Tool | Bus op | What it does |
| --- | --- | --- |
| `list_panes` | `list` | every pane: name, workspace, focused, live |
| `send_text` | `send` | type text into one pane (by name), Enter by default |
| `spawn_pane` | `spawn` | open a new pane running a command (e.g. another agent) |
| `read_pane` | `read` | read the tail of a pane's scrollback (explicit, requested) |
| `broadcast` | `broadcast` | send the same text to every live pane in a workspace |
| `focus_pane` | `focus` | reveal + focus a pane, switching to its workspace |
| `flag_attention` | `attention` | raise/clear a pane's amber "needs you" border |
| `set_status` | `status` | set/clear a pane's status label (title bar + overview) |

`flag_attention` and `set_status` default their target to the agent's **own** pane
(`$TERMHAUS_PANE`), so an agent can flag *itself* — the same self-reporting the
[hook adapter](agent-hooks.md) does, but as a tool the model invokes deliberately.

## Register it with Claude Code

Run this **inside a Termhaus pane** (so `$TERMHAUS_SOCK` / `$TERMHAUS_PANE` are exported and
`th-mcp` is on `PATH`, sitting beside `th`):

```sh
claude mcp add --transport stdio termhaus -- th-mcp
```

An MCP server launched by Claude Code inherits the shell's environment, so the tools resolve the
socket and the agent's own pane automatically. Verify with `/mcp` inside `claude` — you'll see
`termhaus` connected with its tools.

Prefer a committed config? Drop a `.mcp.json` at the project root. `$TERMHAUS_MCP` holds the
server's absolute path (injected into every pane), which is handy here:

```json
{
  "mcpServers": {
    "termhaus": {
      "command": "th-mcp"
    }
  }
}
```

## Hooks vs. MCP — use both

They cover different moments, so the mature setup runs both (see [agent-hooks.md](agent-hooks.md)):

- **MCP acts.** Bidirectional verbs the model plans with — spawn, broadcast, focus, flag.
- **Hooks signal.** A blocked agent waiting on stdin makes *no* tool call — that "needs your input"
  moment is the absence of activity, which only a lifecycle hook (`Notification`) can catch. So the
  thin hook adapter stays even with MCP in place.

## Protocol notes (for maintainers)

`th-mcp` hand-rolls MCP over stdio — newline-delimited JSON-RPC 2.0, pure std + `serde_json`, no
SDK (matching `th`'s lightweight stance). stdout carries protocol messages **only**; diagnostics go
to stderr. It implements `initialize` (echoing the client's `protocolVersion`), `tools/list`,
`tools/call`, and `ping`; unknown methods return JSON-RPC `-32601`, tool failures return a result
with `isError: true` (so the model can retry). It holds no state — every call is one socket
round-trip — so it's safe to start one per agent.
