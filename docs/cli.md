# `th` — the inter-pane control CLI

`th` runs *inside* a Termhaus pane and drives the rest of the fleet: list panes, type
into a named pane, spawn new ones, broadcast, focus, and flag attention/status. It talks
to the running app over a unix socket (`$TERMHAUS_SOCK`), and Termhaus injects `th` onto
the `PATH` of every pane it launches — so a `claude` (or any) process in a pane can call
it directly, and so can you.

This is an **inbound command channel** (ADR-0007). It never parses pane *output* —
reading scrollback (`th read`) is an explicit, requested capture, not output scraping
(ADR-0001).

> Two front-ends, one bus: `th` is the CLI face; **`th-mcp`** exposes the exact same
> operations as agent *tools* over MCP. For the model-native path see
> [agent-mcp.md](agent-mcp.md); for wiring an agent's lifecycle events to
> attention/status see [agent-hooks.md](agent-hooks.md).

## Pane addressing

Panes are addressed by their **display name** (the auto-name in the title bar, e.g.
`Cleo`, `Faye`). `th list` shows the current names. Commands that act on "your own pane"
default to `$TERMHAUS_PANE`, set by Termhaus for the pane the process is running in.

## Commands

### `th list`
List every pane: name, live/dead, and workspace.

```
th list
```

### `th send <pane> <text...> [--no-enter]`
Type text into a pane and press Enter (so a command actually runs). With `--no-enter`
the text is typed without the trailing newline. With **no text**, `th send <pane>` reads
from stdin — pipe-friendly.

```
th send Cleo claude "summarise the diff"     # types it and runs it
th send Cleo --no-enter "git commit -m "     # leaves the cursor mid-line
git log --oneline | th send Cleo             # pipe stdin into the pane
```

### `th spawn [--name N] [--cwd D] <command...>`
Open a new pane running a command (e.g. another agent), optionally named and in a working
directory.

```
th spawn --name Cleo --cwd /repo claude
th spawn npm run dev
```

### `th read <pane> [-n LINES]`
Capture the tail of a pane's scrollback. `-n` defaults to 50 lines (max 2000).

```
th read Cleo            # last 50 lines
th read Cleo -n 200
```

### `th broadcast [--workspace W] [--no-enter] <text...>`
Send the same text to every **live** pane in a workspace — the active one by default, or
a named one with `--workspace`. Presses Enter unless `--no-enter`.

```
th broadcast "run the tests"
th broadcast --workspace deploy "git pull"
```

### `th focus <pane>`
Switch to a pane's workspace and focus it.

```
th focus Cleo
```

### `th attention [pane] [--clear]`
Light a pane's amber **"needs you"** border. Defaults to your own pane. The border clears
when you focus the pane, or explicitly with `--clear`.

```
th attention                 # flag my own pane
th attention Cleo --clear    # drop Cleo's flag
```

### `th status [pane] <text...> | [pane] --clear`
Set a pane's short status label (shown in its title bar and overview tile). Defaults to
your own pane. Clear it with `--clear` or by passing no text.

```
th status "running tests"
th status Cleo "blocked on review"
th status --clear
```

### `th hooks [--print] | --install [--user|--project]`
Print or install a Claude Code hooks profile that wires an agent's lifecycle into
attention/status automatically:

- **UserPromptSubmit** → `th status working`
- **Notification** (needs input / idle) → `th attention`
- **Stop** (turn ended) → `th status` (clears the label)

```
th hooks                 # print the profile (no changes made)
th hooks --install       # merge it into ~/.claude/settings.json (--user)
th hooks --install --project   # ...into ./.claude/settings.json instead
```

Install is idempotent — re-running won't duplicate entries. See
[agent-hooks.md](agent-hooks.md) for tuning and removal.

## Environment

Termhaus injects these into every pane it launches:

| Variable | Meaning |
|---|---|
| `TERMHAUS_SOCK` | Control-bus socket address `th` connects to. |
| `TERMHAUS_PANE` | The current pane's display name (the "self" default). |
| `TERMHAUS_CLI`  | Directory holding `th`, prepended to `PATH`. |

The socket lives at `$XDG_RUNTIME_DIR/termhaus.sock` (fallback `/tmp/termhaus-<user>.sock`)
on Linux, and a per-user named pipe on Windows. Same-user access is the whole trust
boundary (ADR-0007).

## Exit status

`th` exits non-zero and prints `th: <error>` to stderr on failure (unknown pane, no
running app / socket, bad arguments). On success it prints a short human-readable
confirmation (e.g. `sent to 3 panes`, `spawned pane 'Cleo'`).
