# `loom` — the inter-pane control CLI

`loom` runs *inside* a Loom pane and drives the rest of the fleet: list panes, type
into a named pane, spawn new ones, broadcast, focus, and flag attention/status. It talks
to the running app over a unix socket (`$LOOM_SOCK`), and Loom injects `loom` onto
the `PATH` of every pane it launches — so a `claude` (or any) process in a pane can call
it directly, and so can you.

This is an **inbound command channel** (ADR-0007). It never parses pane *output* —
reading scrollback (`loom read`) is an explicit, requested capture, not output scraping
(ADR-0001).

> Two front-ends, one bus: `loom` is the CLI face; **`loom mcp`** exposes the exact same
> operations as agent *tools* over MCP. For the model-native path see
> [agent-mcp.md](agent-mcp.md); for wiring an agent's lifecycle events to
> attention/status see [agent-hooks.md](agent-hooks.md).

## Pane addressing

Panes are addressed by their **display name** (the auto-name in the title bar, e.g.
`Cleo`, `Faye`). `loom list` shows the current names. Commands that act on "your own pane"
default to `$LOOM_PANE`, set by Loom for the pane the process is running in.

## Commands

### `loom list`
List every pane: name, live/dead, and workspace.

```
loom list
```

### `loom send <pane> <text...> [--no-enter]`
Type text into a pane and press Enter (so a command actually runs). With `--no-enter`
the text is typed without the trailing newline. With **no text**, `loom send <pane>` reads
from stdin — pipe-friendly.

```
loom send Cleo claude "summarise the diff"     # types it and runs it
loom send Cleo --no-enter "git commit -m "     # leaves the cursor mid-line
git log --oneline | loom send Cleo             # pipe stdin into the pane
```

### `loom spawn [--name N] [--cwd D] <command...>`
Open a new pane running a command (e.g. another agent), optionally named and in a working
directory.

```
loom spawn --name Cleo --cwd /repo claude
loom spawn npm run dev
```

### `loom read <pane> [-n LINES]`
Capture the tail of a pane's scrollback. `-n` defaults to 50 lines (max 2000).

```
loom read Cleo            # last 50 lines
loom read Cleo -n 200
```

### `loom broadcast [--workspace W] [--no-enter] [--dry-run] <text...>`
Send the same text to every **live** pane in a workspace — the active one by default, or
a named one with `--workspace`. Presses Enter unless `--no-enter`. With `--dry-run` it prints
which panes the fan-out **would** reach — flagging dead and 🔒 gated ones — and sends nothing.

```
loom broadcast "run the tests"
loom broadcast --workspace deploy "git pull"
loom broadcast --dry-run "git reset --hard"   # preview the reach; no send
```

### `loom gate [pane] [--reason R] | [pane] --clear | --list`
Hold a pane's **inbound bus input** (AGENTIC §4a): while a pane is gated, any `loom send` /
`loom broadcast` to it needs a human OK before it lands — so a bad broadcast can't drive a
sensitive pane (a prod-touching one, a live migration) unattended. Defaults to your own pane.
Honored per **Settings → Safety → Honor per-pane input holds**. Gate state shows on the pane's
title-bar chip (🔒) and in the Fleet panel's "Input gates" section.

```
loom gate Cleo --reason "touches prod"   # hold Cleo's input
loom gate                                # gate my own pane
loom gate Cleo --clear                   # release the gate
loom gate --list                         # list gated panes
```

### `loom focus <pane>`
Switch to a pane's workspace and focus it.

```
loom focus Cleo
```

### `loom attention [pane] [--clear]`
Light a pane's amber **"needs you"** border. Defaults to your own pane. The border clears
when you focus the pane, or explicitly with `--clear`.

```
loom attention                 # flag my own pane
loom attention Cleo --clear    # drop Cleo's flag
```

### `loom status [pane] <text...> | [pane] --clear`
Set a pane's short status label (shown in its title bar and overview tile). Defaults to
your own pane. Clear it with `--clear` or by passing no text.

```
loom status "running tests"
loom status Cleo "blocked on review"
loom status --clear
```

### `loom hooks [--print] | --install [--user|--project]`
Print or install a Claude Code hooks profile that wires an agent's lifecycle into
attention/status automatically:

- **UserPromptSubmit** → `loom status working`
- **Notification** (needs input / idle) → `loom attention`
- **Stop** (turn ended) → `loom status` (clears the label)

```
loom hooks                 # print the profile (no changes made)
loom hooks --install       # merge it into ~/.claude/settings.json (--user)
loom hooks --install --project   # ...into ./.claude/settings.json instead
```

Install is idempotent — re-running won't duplicate entries. See
[agent-hooks.md](agent-hooks.md) for tuning and removal.

## Environment

Loom injects these into every pane it launches:

| Variable | Meaning |
|---|---|
| `LOOM_SOCK` | Control-bus socket address `loom` connects to. |
| `LOOM_PANE` | The current pane's display name (the "self" default). |
| `LOOM_BIN`  | Directory holding `loom`, prepended to `PATH`. |

The socket lives at `$XDG_RUNTIME_DIR/loom.sock` (fallback `/tmp/loom-<user>.sock`)
on Linux, and a per-user named pipe on Windows. Same-user access is the whole trust
boundary (ADR-0007).

## Exit status

`loom` exits non-zero and prints `loom: <error>` to stderr on failure (unknown pane, no
running app / socket, bad arguments). On success it prints a short human-readable
confirmation (e.g. `sent to 3 panes`, `spawned pane 'Cleo'`).
