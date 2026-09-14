# desktop

Tauri 2 app (M9): attaches to the local hub or starts the bundled one, shows the hub's page, stays in the tray, owns the global push-to-talk key, and is the `loom` CLI when given arguments. `scripts/prepare.mjs` gathers what installers ship; `npm run desktop:build` makes the `.deb` or NSIS installer. See ADR-0010 and docs/dev.md.
