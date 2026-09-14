/** A session's changes as git sees them (M12 diff review). */

export interface DiffHunk {
  /** Stable for the same file, header, and lines; a revert must name the hunk it saw. */
  id: string;
  /** `@@ -12,7 +12,9 @@ function name` */
  header: string;
  /** Diff lines with their ` `, `+`, `-`, or `\` prefix. */
  lines: string[];
}

export interface DiffFile {
  path: string;
  oldPath?: string;
  status: "modified" | "added" | "deleted" | "renamed" | "untracked";
  added: number;
  removed: number;
  binary: boolean;
  hunks: DiffHunk[];
  /** Too large to show every line. */
  truncated: boolean;
}

export interface SessionDiff {
  /** False when the session's folder is not in a git repository. */
  git: boolean;
  root: string;
  /** `uncommitted`: working tree against HEAD. `branch`: against where the worktree's branch started. */
  mode: "uncommitted" | "branch";
  /** The commit compared against, abbreviated. */
  base: string;
  files: DiffFile[];
  /** More files changed than are shown. */
  truncated: boolean;
}
