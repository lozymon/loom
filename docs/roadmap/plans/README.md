# Plans — active, being fleshed out

Working plans for the next round of Loom work. Each file is self-contained so a fresh session can pick
one up cold: goal, why, code grounding (file:line refs), locked decisions, task checklist, open
questions. Flesh these out in place; promote to an ADR when a design fork needs pinning.

| # | Plan | Effort | Rust | ADR | Notes |
|---|------|--------|------|-----|-------|
| 01 | [Move / reorder panes](01-move-panes.md) | ~1 day | none | no | ✅ **Shipped v1.11.0** (#52) — pure TS; the live PTY is handed across the remount so the process survives. |
| 04 | [New-workspace form → full-space](04-new-workspace-form.md) | ~1–2 days | none | no | ✅ **Shipped v1.12.0** (#56) — full-stage launcher (rail + title bar persist); calm centered column; per-pane grid behind a disclosure; Save as preset. |
| 03 | [Website + docs on VPS](03-website-docs.md) | ~2–3 days | none | no | Astro+Starlight (rec.), rsync→VPS. Parallelizable. |
| 02 | [Mobile remote (VPS relay)](02-mobile-remote.md) | weeks | yes | **required** | Flagship. Write the ADR first. |

**Suggested order:** ~~01~~ (shipped) → ~~04~~ (shipped) → 03 (can run in parallel) → 02.

Shared thread: plans 03 and 02 both live on the user's **VPS** — coordinate the domain/subdomain layout
and reuse one nginx + Let's Encrypt setup across the docs site and the mobile relay.
