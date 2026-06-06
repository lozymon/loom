# PTYs live in the app process; no detach/reattach daemon

Terminal multiplexers like tmux run a background server so sessions survive the client disconnecting. Termhaus deliberately does not: every PTY is owned by the Rust process inside the app, so quitting the app kills every child. "Persistence" across restarts means respawning each Pane's command in its cwd (see the persistence model), not keeping live processes alive. We chose this because a detach daemon is a large, separate architecture (out-of-process supervisor, reattach protocol, orphan management) that conflicts with the v1 goal of a thin Rust core, and the respawn model already covers the common "get my layout back" need.

## Consequences

- A long-running job (build, training run) dies when you quit Termhaus — for those, users still reach for `tmux`/`nohup` inside a Pane.
- No reattach protocol, no orphaned-process reaping across app restarts.
- If detach is ever wanted, it is a major additive feature, not a tweak.
