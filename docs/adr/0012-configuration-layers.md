# Hub config plus per-project `.loom/`, project overrides hub

**Status:** Accepted (2026-09-12).

## Decision

- **Hub config** at `~/.config/loom/hub.json` (Windows: `%APPDATA%\loom\hub.json`): hub name, bind address, token, default and maximum permission level, Steward model switch and budgets, voice engines and keys, quiet hours.
- **Project config** in `<repo>/.loom/`, committable:
  - `policy.json` — allow, deny, and always-ask rules.
  - `board.json` — task cards (as in v1).
  - `config.json` — project overrides such as default level or model.
- **Precedence:** project overrides hub, except that **a project can never raise the hub's maximum level or enable the Steward model where the hub disabled it.** Deny rules from both layers apply.
- Secrets never go in `.loom/`.

### As built (M3, 2026-09-12)

- Hub policy lives at `policy.json` next to `hub.json`; its `/path` rules anchor at that directory, mirroring Claude Code's user settings.
- The project root is the nearest ancestor of the session's directory with a `.loom` folder, else a `.git` folder, else the directory itself.
- **Trust covers the allow list only**, by an order-insensitive hash stored in `trust.json` in the hub's data directory. An untrusted list's allow rules do nothing; its deny and ask rules apply at once. The client shows a banner with the exact rules and trusts that hash; if the file changed in the meantime, trust is refused.
- Saving a project policy from the client trusts it. Saving a single rule from an approval keeps the list's previous trust state: an untrusted list stays untrusted, so one click cannot trust rules nobody reviewed.
- Files are re-read when their modification time or size changes, so editing `policy.json` in an editor applies to the next approval.

## Consequences

- A team shares allow lists by committing `.loom/policy.json`; each person's hub still enforces its own ceiling.
- Opening an unfamiliar repo shows its `.loom/policy.json` allow rules for confirmation before they take effect, since a repo could ship a permissive policy.
