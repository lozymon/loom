# Loom MCP server — drive the fleet as agent tools

`loom mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server that exposes the
Loom control bus ([ADR-0007](../adr/0007-inter-pane-control-bus.md)) as first-class **tools** an
agent can call. It's the model-native face of the same relay the [`loom` CLI](agent-hooks.md) drives
— each tool builds the identical `ControlRequest` JSON and forwards it over `$LOOM_SOCK`, so the
`loom` CLI and `loom mcp` are two front-ends to one bus. This is step **C** of the agent-integration arc
in [IDEAS.md](../roadmap/IDEAS.md): the model *plans with* Loom ("spawn a pane to run tests while I edit")
instead of shelling out.

It stays inside the opacity rule ([ADR-0001](../adr/0001-opaque-panes-no-agent-awareness.md)): these
are inbound *commands* (and an explicit, requested `read_pane`), never inference from pane output.

## Tools

| Tool | Bus op | What it does |
| --- | --- | --- |
| `list_panes` | `list` | every pane: name, workspace, focused, live |
| `send_text` | `send` | type text into one pane (by name), Enter by default |
| `spawn_pane` | `spawn` | open a new pane running a command (e.g. another agent) |
| `read_pane` | `read` | read the tail of a pane's scrollback (explicit, requested) |
| `broadcast` | `broadcast` | send the same text to every live pane in a workspace (`dry_run` previews the reach) |
| `focus_pane` | `focus` | reveal + focus a pane, switching to its workspace |
| `flag_attention` | `attention` | raise/clear a pane's amber "needs you" border |
| `set_status` | `status` | set/clear a pane's status label (title bar + overview) |
| `gate_pane` | `gate.set` | hold/release a pane's inbound bus input (needs a human OK to land) |
| `list_gates` | `gate.list` | list every pane whose bus input is gated |

`flag_attention` and `set_status` default their target to the agent's **own** pane
(`$LOOM_PANE`), so an agent can flag *itself* — the same self-reporting the
[hook adapter](agent-hooks.md) does, but as a tool the model invokes deliberately.

## Register it with Claude Code

Run this **inside a Loom pane** (so `$LOOM_SOCK` / `$LOOM_PANE` are exported and
`loom mcp` is on `PATH`, sitting beside `loom`):

```sh
claude mcp add --transport stdio loom -- loom mcp
```

An MCP server launched by Claude Code inherits the shell's environment, so the tools resolve the
socket and the agent's own pane automatically. Verify with `/mcp` inside `claude` — you'll see
`loom` connected with its tools.

Prefer a committed config? Drop a `.mcp.json` at the project root. The server is the `loom`
binary with an `mcp` subcommand (`loom` is on every pane's `PATH`; `$LOOM_BIN` holds its absolute
path if you'd rather not rely on `PATH`):

```json
{
  "mcpServers": {
    "loom": {
      "command": "loom",
      "args": ["mcp"]
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

`loom mcp` hand-rolls MCP over stdio — newline-delimited JSON-RPC 2.0, pure std + `serde_json`, no
SDK (matching `loom`'s lightweight stance). stdout carries protocol messages **only**; diagnostics go
to stderr. It implements `initialize` (echoing the client's `protocolVersion`), `tools/list`,
`tools/call`, and `ping`; unknown methods return JSON-RPC `-32601`, tool failures return a result
with `isError: true` (so the model can retry). It holds no state — every call is one socket
round-trip — so it's safe to start one per agent.
