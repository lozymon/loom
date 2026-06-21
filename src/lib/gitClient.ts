// Client for the read-only git commands (src-tauri/src/git.rs) plus a pure unified-diff
// parser that turns `git diff` text into side-by-side rows for the Source Control panel.
//
// Rust stays a thin shell-out (status + raw diff text); all diff parsing/alignment is product
// logic, so it lives here in TS (CLAUDE.md: UX/state in TS).

import { invoke } from "@tauri-apps/api/core";

/** One changed path from `git status` (see Rust `GitFile`). */
export interface GitFile {
  /** Repo-root-relative path — feed back to `gitDiff` verbatim. */
  path: string;
  /** Raw two-char porcelain code, e.g. " M", "M ", "MM", "??". */
  status: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}

/** Result of `git_status` (see Rust `GitStatus`). */
export interface GitStatus {
  isRepo: boolean;
  root: string;
  branch: string;
  files: GitFile[];
}

export const gitStatus = (cwd: string): Promise<GitStatus> =>
  invoke<GitStatus>("git_status", { cwd });

/** Just the current branch for `cwd` (see Rust `git_branch`); null outside a repo. */
export const gitBranch = (cwd: string): Promise<string | null> =>
  invoke<string | null>("git_branch", { cwd });

export const gitDiff = (
  cwd: string,
  path: string,
  staged: boolean,
  untracked: boolean,
): Promise<string> => invoke<string>("git_diff", { cwd, path, staged, untracked });

// ---- unified-diff parsing → single-column rows ----

/**
 * One rendered row of a unified diff: a hunk header band, or one context/removed/added line.
 * `sign` is the diff marker (` ` context, `-` removed, `+` added); `oldNo`/`newNo` are the
 * 1-based line numbers on each side (null on the side a line doesn't exist).
 */
export type DiffRow =
  | { kind: "hunk"; header: string }
  | { kind: "line"; sign: " " | "-" | "+"; oldNo: number | null; newNo: number | null; text: string };

/** Parse the `@@ -a,b +c,d @@` header; returns the 1-based old/new start line numbers. */
function parseHunkHeader(line: string): { oldStart: number; newStart: number } | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (!m) return null;
  return { oldStart: Number(m[1]), newStart: Number(m[2]) };
}

/**
 * Turn `git diff` output for a single file into a flat list of unified rows — one row per
 * source line, the way the diff is rendered (and selected) in the panel. File/index headers
 * (everything before the first hunk) and "\ No newline at end of file" markers are skipped.
 */
export function parseUnifiedDiff(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  const lines = diff.split("\n");
  let oldNo = 0;
  let newNo = 0;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      const h = parseHunkHeader(line);
      if (h) {
        oldNo = h.oldStart;
        newNo = h.newStart;
        rows.push({ kind: "hunk", header: line });
      }
      continue;
    }

    // Skip everything before the first hunk (diff --git / index / --- / +++) and stray markers.
    if (oldNo === 0 && newNo === 0) continue;
    if (line.startsWith("\\")) continue; // "\ No newline at end of file" — no line number consumed

    if (line.startsWith(" ")) {
      rows.push({ kind: "line", sign: " ", oldNo: oldNo++, newNo: newNo++, text: line.slice(1) });
    } else if (line.startsWith("-")) {
      rows.push({ kind: "line", sign: "-", oldNo: oldNo++, newNo: null, text: line.slice(1) });
    } else if (line.startsWith("+")) {
      rows.push({ kind: "line", sign: "+", oldNo: null, newNo: newNo++, text: line.slice(1) });
    }
    // anything else (a blank trailing element from the split) — ignore
  }

  return rows;
}

/** A reconstructed slice of a diff, ready to send into a terminal. */
export interface DiffSelection {
  /** The selected lines as unified-diff text (`+`/`-`/` ` prefixed), no trailing newline. */
  text: string;
  /** 1-based line range in the file (new-side where available, else old-side). */
  start: number;
  end: number;
  /** Number of diff lines emitted (a paired replace contributes both its `-` and `+`). */
  count: number;
}

/**
 * Rebuild raw unified-diff text for the given `rows` at `indices` (a contiguous user
 * selection; hunk-header rows are ignored). The line range prefers new-side numbers, falling
 * back to old-side for pure deletes.
 */
export function formatDiffSelection(rows: DiffRow[], indices: number[]): DiffSelection {
  const lines: string[] = [];
  const nums: number[] = [];
  for (const i of indices) {
    const row = rows[i];
    if (!row || row.kind !== "line") continue;
    lines.push(row.sign + row.text);
    const no = row.newNo ?? row.oldNo;
    if (no != null) nums.push(no);
  }
  return {
    text: lines.join("\n"),
    start: nums.length ? Math.min(...nums) : 0,
    end: nums.length ? Math.max(...nums) : 0,
    count: lines.length,
  };
}
