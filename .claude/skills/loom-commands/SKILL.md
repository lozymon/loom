---
name: loom-commands
description: Reference for driving Loom terminal panes from inside a pane — the `loom` inter-pane control CLI (list/send/spawn/read/broadcast/focus/attention/status) and the equivalent `loom mcp` agent tools. Use when an agent running inside a Loom pane needs to inspect, message, spawn, or coordinate other panes, or to flag its own status/attention.
---

<what-this-is>

Loom is an **agent-first developer environment** built on real terminals. Every pane is a
byte-opaque PTY — Loom never parses pane output in the engine (ADR-0001/0008; an opt-in
heuristic tier is ADR-0011). A process running **inside** a pane can nonetheless drive the
other panes through an *inbound* control bus (ADR-0007): the `loom` CLI (or the `loom mcp`
MCP tools) talks to the running app over the unix socket at `$LOOM_SOCK`.

Two faces of the same bus — use whichever fits your context:

- **`loom <subcommand>`** — shell out from inside a pane. Always available; the pane's child
  gets `LOOM_SOCK` / `LOOM_PANE` / `LOOM_BIN` injected and the CLI dir prepended to `PATH`.
- **`loom mcp` tools** — model-native tools, if the MCP server is wired into your agent.
  Same ops, same routing; just call the tool instead of shelling out.

Panes are addressed by their **display name** (e.g. `Cleo`, `Faye`) — get names from `list`.

</what-this-is>

<preconditions>

These commands only work from a process launched **inside a Loom pane**. Check `$LOOM_PANE`
and `$LOOM_SOCK` are set — if they're empty, you're not in Loom and the commands are inert
no-ops (this is deliberate; the same hooks/CLI can be installed globally and stay silent
outside Loom). `$LOOM_PANE` holds *your own* pane's name — used as the default target for
`attention` and `status`.

</preconditions>

<cli-reference>

## `loom` CLI

```
loom list                                   # every pane: name, live/dead, workspace, * = focused
loom send <pane> <text...> [--no-enter]     # type text into a pane, Enter by default
loom send <pane>                            # no text → reads stdin (pipe-friendly)
loom spawn [--name N] [--cwd D] <command...>  # open a new pane running a command
loom read <pane> [-n LINES]                 # capture the tail of a pane's scrollback
loom broadcast [--workspace W] [--no-enter] <text...>   # send to every live pane (no text → stdin)
loom focus <pane>                           # switch to the pane's workspace and focus it
loom attention [pane] [--clear]             # raise/drop a pane's amber "needs you" border
loom status [pane] <text...> | [pane] --clear   # set/clear a pane's short status label
loom hooks [--print] | --install [--user|--project]   # Claude Code lifecycle → Loom Session/Task model
```

### Details & gotchas

- **`send`** — everything after the pane name is joined with spaces and typed, then Enter.
  Use `--no-enter` to leave the line unsubmitted (e.g. to stage a command). With no text it
  reads stdin, so `echo "prompt" | loom send Cleo` and `git log | loom send Cleo` work.

- **`spawn`** — the first non-flag token starts the command; everything after it is taken
  verbatim (dashes included), so `loom spawn --name worker claude --resume` works. To be
  explicit, end flag parsing with `--`: `loom spawn --name w -- claude --resume`. Returns the
  spawned pane's name.

- **`read`** — an *explicit, requested* read of scrollback (default tail, `-n`/`--lines` to
  bound it). This is not output-scraping — you asked for a snapshot; Loom still never watches
  the stream (ADR-0001 forbids parsing *output as a signal*, not answering a read).

- **`broadcast`** — fans text to every **live** pane in the active workspace (`--workspace`/`-w`
  to target another). This is the one-to-many fan-out; there is no human broadcast bar, it's
  agent-driven only.

- **`attention`** / **`status`** — with no pane argument they target **your own** pane
  (`$LOOM_PANE`), so an agent can flag *itself* blocked or label what it's doing. `status`
  disambiguation mirrors the code: `--clear` → optional lone positional is the pane, else self;
  one token + a caller pane → that token is *your* status text; two+ tokens → first is the
  target pane, rest is the text. Lead with `--` if the status text starts with a dash
  (`loom status -- --resuming`). The attention border clears when the pane is focused.

- **`hooks`** — `loom hooks` prints the recommended Claude Code hooks profile;
  `loom hooks --install` merges it into `.claude/settings.json` (`--project`, default) or
  `~/.claude/settings.json` (`--user`). Idempotent. This bridges a Claude agent's lifecycle
  (SessionStart/UserPromptSubmit/PostToolUse/Notification/Stop/SessionEnd) into Loom's
  Session/Task/Approval model (ADR-0008) — the agent *pushes* its state; Loom never parses output.

</cli-reference>

<mcp-reference>

## `loom mcp` tools

Same ops as first-class tools (arguments in parens; `target` is a pane display name):

| Tool | Args | Does |
|------|------|------|
| `list_panes` | — | List every pane (name, workspace, focused, live). |
| `send_text` | `target`, `text`, `enter?`=true | Type text into one pane. |
| `spawn_pane` | `command`, `name?`, `cwd?` | Open a new pane running `command`. |
| `read_pane` | `target`, `lines?`=50 (max 2000) | Read the tail of a pane's scrollback. |
| `broadcast` | `text`, `enter?`=true, `workspace?` | Send to every live pane in a workspace. |
| `focus_pane` | `target` | Reveal & focus a pane, switching workspace. |
| `flag_attention` | `target?`=self, `clear?`=false | Raise/drop a pane's amber border. |
| `set_status` | `target?`=self, `text?` | Set a pane's status label (empty text clears). |

`flag_attention` and `set_status` default to your own pane (`$LOOM_PANE`) when `target` is omitted.

</mcp-reference>

<recipes>

## Common patterns

- **See who's around:** `loom list` → pick target names.
- **Delegate a task to a peer:** `loom send Cleo "run the integration suite and report back"`.
- **Spin up a helper agent:** `loom spawn --name reviewer --cwd /repo claude` then
  `loom send reviewer "review the diff on branch X"`.
- **Fan a prompt to the whole workspace:** `loom broadcast "pull main and rebase"`.
- **Pull a peer's recent output:** `loom read Cleo -n 200`.
- **Flag yourself blocked so the human notices:** `loom attention` (borders your pane), then
  `loom status "waiting on API key"`. Clear with `loom attention --clear` / `loom status --clear`.
- **Report progress as you go:** `loom status "running tests (3/5)"`.

Keep it courteous: `send`/`broadcast` *type into* another terminal — don't spam, and prefer
`--no-enter` if you want a human to review before it runs.

</recipes>
