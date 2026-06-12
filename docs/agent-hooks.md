# Agent hooks — wire a Claude Code agent into Termhaus

Termhaus never parses what scrolls by in a pane ([ADR-0001](adr/0001-opaque-panes-no-agent-awareness.md)).
Instead, an agent running *inside* a pane reports its own state over the `th` control bus
([ADR-0007](adr/0007-inter-pane-control-bus.md)) — it flags itself; we never infer anything from
its output. This page wires Claude Code's **lifecycle hooks** to that bus, so a fleet of agents
lights up the UI as they work and pause.

This is the "hook adapter" step of the agent-integration arc in [IDEAS.md](IDEAS.md) — the cheap,
robust bridge that validates the needs-input (#1) and status (#3) flows. Its bigger sibling is the
[Termhaus MCP server](agent-mcp.md), which exposes the same control bus as agent *tools*; hooks and
MCP are complementary (hooks signal the blocked moments MCP can't see — keep both).

## What it gives you

| Moment | Claude Code hook | Runs | Effect in Termhaus |
| --- | --- | --- | --- |
| You submit a prompt | `UserPromptSubmit` | `th status working` | pane's title/overview tile shows **working** |
| Claude needs input / permission / goes idle | `Notification` | `th attention` | pane raises its **amber "needs you" border** |
| The turn finishes | `Stop` | `th status` | clears the status label |

The amber flag is what the broadcast bar's **⚑ Reply to flagged** button targets: when several
agents pause for a `y/n`, answer once and it goes only to the flagged panes (then clears them).
Focusing a pane also clears its flag — so `Stop` deliberately leaves `attention` alone (only the
prompt/stop pair touches `status`, only `Notification` touches `attention`; they never race).

## Install

From inside any Termhaus pane (the `th` CLI is already on `PATH`, and `$TERMHAUS_SOCK` /
`$TERMHAUS_PANE` are exported so the hook commands resolve to the right pane):

```sh
th hooks --install            # merge into ./.claude/settings.json (this project)
th hooks --install --user     # merge into ~/.claude/settings.json (all projects)
```

The merge is **idempotent** (re-running adds nothing already present) and preserves any other
settings and hooks you already have. Restart `claude`, or run `/hooks`, for it to pick them up.

Prefer to wire it by hand? Print the profile and paste it yourself:

```sh
th hooks            # prints the { "hooks": { … } } fragment, makes no changes
```

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "th status working" } ] }
    ],
    "Notification": [
      { "matcher": "", "hooks": [ { "type": "command", "command": "th attention" } ] }
    ],
    "Stop": [
      { "hooks": [ { "type": "command", "command": "th status" } ] }
    ]
  }
}
```

Hook commands run via `sh -c` with the launching shell's environment and working directory, so
`th` finds the socket and pane automatically — nothing else to configure.

## Tuning it

It's plain config — trim or extend per taste:

- Drop `UserPromptSubmit` + `Stop` if you only want the amber needs-input flag (#1) and not the
  status label (#3).
- Give `Stop` a richer label instead of clearing: `"command": "th status done"`.
- Scope `Notification` to permission prompts only with `"matcher": "permission_prompt"` (the empty
  matcher fires on every notification, including idle).

## To remove

Run `/hooks` in Claude Code, or delete the three entries from the `hooks` block of the settings
file you installed into. (`th hooks` has no uninstaller — it only ever adds.)
