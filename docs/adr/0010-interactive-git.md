# Interactive git (stage / commit), still user-confirmed

The Source Control panel (`git.rs` + `GitPanel.tsx`) shipped **read-only** in M8: it lists
changed files and renders unified diffs so you can *review* an agent's work and send comments
back into its pane, but staging and committing stayed inside the agent's own terminal. As Loom
reorients toward an agent-first developer environment (see [AGENT_FIRST_PLAN.md](../../AGENT_FIRST_PLAN.md)),
the review → **stage → commit** loop is the natural close of that workflow: you've reviewed what
the fleet produced, so let the same panel land it — without alt-tabbing to a separate git TUI.

## Decision

**Promote the read-only git panel to a real stage / commit surface, but every write stays an
explicit user action. Loom never auto-commits.** Three new thin Rust commands join the existing
read-only ones in `git.rs`:

- `git_stage(cwd, path)` → `git add -- <path>` (works for tracked-modified and untracked alike).
- `git_unstage(cwd, path)` → `git reset -q HEAD -- <path>`, falling back to `git rm -q --cached`
  on an unborn branch (no `HEAD` yet), so a brand-new repo unstages correctly.
- `git_commit(cwd, message)` → `git commit -m <message>`; git's own non-zero output (nothing
  staged, missing `user.name`/`user.email`, a failing pre-commit hook) is surfaced verbatim.

Same split as the rest of the codebase (CLAUDE.md): Rust is a **thin shell-out** — resolve the
repo root, run `git`, hand back success/stderr — and all UX/state (which files, the commit
message, refresh-after-write) lives in TS (`gitClient.ts` / `GitPanel.tsx`). The commit
`message` is passed as a process argument, never through a shell, so it can't be injected.

## Why this is safe to do (and where the line is)

The opacity rule (ADR-0001) and the host-not-orchestrator stance (the bus, ADR-0007) both still
hold: this is a **user-initiated** write path, not Loom reasoning about pane output or driving
agents. The "host, not autocommitter" boundary is the load-bearing constraint:

- **No automatic commits.** Nothing in Loom calls `git_commit` on its own — it fires only from a
  button the user clicked, with a message the user typed. An agent can *write files*; turning that
  into history is a human gesture.
- **No bus/MCP surface for committing.** Unlike `send`/`spawn`/`broadcast`, the git writes are
  **not** exposed over the inter-pane control bus. A pane process cannot stage or commit on your
  behalf — that would hand a prompt-injectable agent the keys to your history. (If a future use
  case wants it, it goes through the same explicit-confirmation gate `spawn` already has; tracked,
  not built.)
- **Repo-scoped.** Writes resolve and run from the repo root (like `git_status`/`git_diff`) and
  act only on paths git itself reported as changed — no arbitrary-path primitive.

## Consequences

- Supersedes M8's deliberate read-only decision and the ADR-0001 live-cwd amendment's "read-only"
  note for the git panel. The panel's purpose widens from *review* to *review → stage → commit*.
- **File-level staging first.** v1 stages/unstages whole files; per-hunk staging (which would reuse
  the panel's existing hunk-selection gesture via `git apply --cached`) is a clean follow-up, not a
  v1 requirement.
- The session-aware tie ("Faye's session touched these files → review → commit") from
  AGENT_FIRST_PLAN Phase 4 grafts on later for free once the `Session`/`Task` model exists; it is
  **not** a prerequisite here — interactive git operates on the focused pane's repo today,
  independent of the larger agent-awareness pivot (and of the still-open ADR-0001 reversal).
- Linux-first like the rest; `git` is assumed on `PATH` (already true for the read path).
