# App shortcuts live in the Ctrl+Shift namespace; everything else passes through

Termhaus claims only `Ctrl+Shift+<key>` for its own actions (split, close, move focus, switch Workspace, copy/paste, broadcast toggle). Every other key combination — plain `Ctrl+C` (SIGINT), `Ctrl+B`, `Ctrl+R`, arrows, function keys — passes straight to the focused Pane's PTY untouched. Input routes to exactly one Pane via click-to-focus. We rejected a tmux-style prefix key (`Ctrl+B` then a key) as the default because it is expert-only and collides the instant someone runs `tmux`/`vim`/`emacs` inside a Pane; the `Ctrl+Shift` convention matches GNOME Terminal and leaves the entire terminal keyspace free for inner apps.

## Consequences

- Inner TUIs (tmux, vim, emacs) work normally because Termhaus never intercepts their keys.
- The rare app that uses `Ctrl+Shift+<key>` itself will be shadowed.
- Do not add a global prefix key or intercept bare `Ctrl`+letter combos — it will swallow keys that inner apps depend on. A prefix mode, if ever added, must be opt-in.
