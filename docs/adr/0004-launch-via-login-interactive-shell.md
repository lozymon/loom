# Panes launch via the user's login interactive shell

A Pane spawns the user's `$SHELL` with login + interactive semantics (e.g. `bash -l`), and a Pane that has a command runs it *inside* that shell via `$SHELL -lc "<command>"` rather than exec'ing the binary directly. We also inject `TERM=xterm-256color` and `COLORTERM=truecolor`. The reason: exec'ing a bare binary or a non-login shell skips the user's PATH setup (`nvm`/`asdf`/`volta`/`~/.profile`), so tools like `claude` and `node` appear "not found" even though they work in a normal terminal — the classic DIY-terminal-emulator bug. Routing through the login shell makes a Pane behave identically to the user's real terminal, which is what makes "agents = just launch `claude`" (ADR-0001) actually work.

## Consequences

- Marginally slower pane startup (sources rc files) and inherits the user's shell quirks — accepted, because that is the point.
- Command-exit ends the shell → Dead pane (consistent with the Pane lifecycle). A "drop to shell after the command" mode is deferred.
- Do not "optimize" this to `execvp` the binary directly — it will silently break PATH resolution.
