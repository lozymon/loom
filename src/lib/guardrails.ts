// Git-aware / destructive-command guardrails (AGENTIC-ENHANCEMENTS §4b).
//
// A heuristic on a command Loom is about to *broadcast* — an inbound action Loom itself originates
// (ADR-0007), NOT pane output (ADR-0001 still forbids reading output as a signal). When one agent
// fans a destructive command (`git reset --hard`, `rm -rf`, a force-push, a rebase, …) to every pane
// in a workspace, and several of those panes share a folder/worktree, it either runs N× on the same
// tree or races — so we warn the operator first. Best-effort by design: a pattern list, meant to
// catch the obvious foot-guns, not to be a sandbox.

/** Command fragments that are destructive enough to confirm before fanning out. Case-insensitive. */
const DESTRUCTIVE: RegExp[] = [
  /\bgit\s+reset\b[^\n]*--hard\b/i,
  /\bgit\s+clean\b[^\n]*\s-[a-z]*f/i, // git clean -f / -fd / -xdf
  /\bgit\s+checkout\b[^\n]*(--force\b|\s-f\b)/i,
  /\bgit\s+push\b[^\n]*(--force\b|--force-with-lease\b|\s-f\b)/i,
  /\bgit\s+branch\b[^\n]*(\s-D\b|--delete\s+--force\b)/i,
  /\bgit\s+rebase\b/i,
  /\bgit\s+worktree\s+remove\b/i,
  /\bgit\s+stash\s+clear\b/i,
  /\bgit\s+filter-branch\b/i,
  /\brm\s+-[a-z]*r[a-z]*f\b/i, // rm -rf / -Rf
  /\brm\s+-[a-z]*f[a-z]*r\b/i, // rm -fr
  /\bsudo\s+rm\b/i,
];

/** Does `text` look like a destructive command worth confirming before broadcasting to many panes? */
export function isDestructiveCommand(text: string): boolean {
  const cmd = text.trim();
  if (!cmd) return false;
  return DESTRUCTIVE.some((re) => re.test(cmd));
}

/** From the target panes' folders, the ones that appear on ≥2 panes — i.e. a shared worktree the
 *  destructive command would hit repeatedly. `null`/empty cwds are ignored. */
export function sharedFolders(cwds: (string | null | undefined)[]): string[] {
  const counts = new Map<string, number>();
  for (const c of cwds) {
    if (!c) continue;
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, n]) => n >= 2).map(([dir]) => dir);
}
