# App shortcuts live in the Ctrl+Shift namespace; everything else passes through

Loom claims only `Ctrl+Shift+<key>` for its own actions (split, close, move focus, switch Workspace, copy/paste, broadcast toggle). Every other key combination — plain `Ctrl+C` (SIGINT), `Ctrl+B`, `Ctrl+R`, arrows, function keys — passes straight to the focused Pane's PTY untouched. Input routes to exactly one Pane via click-to-focus. We rejected a tmux-style prefix key (`Ctrl+B` then a key) as the default because it is expert-only and collides the instant someone runs `tmux`/`vim`/`emacs` inside a Pane; the `Ctrl+Shift` convention matches GNOME Terminal and leaves the entire terminal keyspace free for inner apps.

## Consequences

- Inner TUIs (tmux, vim, emacs) work normally because Loom never intercepts their keys.
- The rare app that uses `Ctrl+Shift+<key>` itself will be shadowed.
- Do not add a global prefix key or intercept bare `Ctrl`+letter combos — it will swallow keys that inner apps depend on. A prefix mode, if ever added, must be opt-in.

## Amendment (2026-07-05): the modifier is logical — `Cmd+Shift` on macOS

`Ctrl+Shift` is the *logical* namespace; on macOS it renders as **`Cmd+Shift`**, the native app-shortcut modifier. Cmd is the right choice there for the same reason Ctrl+Shift is elsewhere — and then some: Cmd is **never delivered to the PTY**, so `Cmd+Shift+<key>` cannot collide with a terminal control character at all (whereas Ctrl can). Plain `Ctrl+C` still reaches the shell as SIGINT on every platform.

The split lives in exactly one place — `appChord(e)` in [`src/lib/keybindings.ts`](../../src/lib/keybindings.ts) (primary modifier = `metaKey` on macOS, `ctrlKey` elsewhere; Shift required; the *other* modifier and Alt excluded). Every dispatch site calls it instead of checking `e.ctrlKey`/`e.shiftKey` inline, and labels render via `MOD_LABEL`/`MOD_NAMESPACE`, so the whole app follows the platform with no per-site `#[cfg]`-style branching. Platform is detected once from `navigator` (guarded for the node test env, where it resolves to non-mac — the CI-verified path).
