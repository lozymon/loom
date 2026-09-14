# Worktrees and boards belong to the main repository

**Status:** Accepted (2026-09-12, M4).

Running several sessions on one project at once needs isolation (worktrees) and a shared list of work (the board). Both raise the same question: when a session runs in a branch checkout, whose rules, trust, and board apply?

## Decision

- **Worktrees live in the hub's data directory**, `worktrees/<repo>-<hash>/<branch>`, created with `git worktree add`, never inside the repository. Branch names are validated with `git check-ref-format`; git runs with an argument array and prompts disabled.
- **A worktree session's project is its main repository.** The hub reads the main root from the worktree's `.git` file. Policy, allow-list trust, and the board are resolved there, so a branch checkout can neither lose trust nor quietly change rules by editing its own copy of `.loom/policy.json`.
- **Loom never deletes a branch.** Archiving can remove a worktree directory, refused when it has uncommitted changes unless forced.
- **The board is `<project>/.loom/board.json`,** written atomically by the hub, re-read when it changes on disk, and never overwritten if it fails to parse. Changes reach clients as `board` frames; the file, not the event log, is the source of truth.
- **Card lanes are to do, running, review, done, failed.** Dispatch sets running. The hub moves running to review when the card's session finishes a turn (only after it has been seen working, so start-up idle does not count), review back to running when it works again, and running or review to failed on an error. People move cards to done and back to to-do.
- **"Run" is in memory only** and keeps up to N cards running; it stops itself when nothing is left.
- **Loom's own policy and trust files are protected by built-in ask rules**, in Loom's pipeline and passed to Claude Code as settings ask rules, so even accept-edits mode prompts before an agent edits them.

## Consequences

- Two sessions editing the same file on different cards do not collide. Verified with five parallel cards, two of them editing the same file.
- A card whose kind is `claude-terminal` passes its prompt to `claude` at launch.
- Merging branches back is left to people and to sessions they ask; Loom does not merge.
