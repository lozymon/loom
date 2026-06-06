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

export const gitDiff = (
  cwd: string,
  path: string,
  staged: boolean,
  untracked: boolean,
): Promise<string> => invoke<string>("git_diff", { cwd, path, staged, untracked });

// ---- unified-diff parsing → side-by-side rows ----

/** One side of a side-by-side row. `kind: "empty"` is the blank gutter opposite an add/del. */
export interface DiffCell {
  /** Line number in that file, or null for empty/filler cells. */
  no: number | null;
  text: string;
  kind: "ctx" | "del" | "add" | "empty";
}

/** A rendered row: either a hunk header band, or a left/right line pair. */
export type DiffRow =
  | { kind: "hunk"; header: string }
  | { kind: "pair"; left: DiffCell; right: DiffCell };

const EMPTY: DiffCell = { no: null, text: "", kind: "empty" };

/** Parse the `@@ -a,b +c,d @@` header; returns the 1-based old/new start line numbers. */
function parseHunkHeader(line: string): { oldStart: number; newStart: number } | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (!m) return null;
  return { oldStart: Number(m[1]), newStart: Number(m[2]) };
}

/**
 * Turn `git diff` output for a single file into side-by-side rows. Runs of removed/added lines
 * within a hunk are paired positionally (del[i] ↔ add[i]); any overflow becomes one-sided rows
 * with an empty cell opposite. Context lines mirror on both sides. File/index headers and
 * "\ No newline at end of file" markers are skipped.
 */
export function parseUnifiedDiff(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  const lines = diff.split("\n");
  let oldNo = 0;
  let newNo = 0;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith("@@")) {
      const h = parseHunkHeader(line);
      if (h) {
        oldNo = h.oldStart;
        newNo = h.newStart;
        rows.push({ kind: "hunk", header: line });
      }
      i++;
      continue;
    }

    // Skip everything before the first hunk (diff --git / index / --- / +++) and stray markers.
    if (oldNo === 0 && newNo === 0) {
      i++;
      continue;
    }
    if (line.startsWith("\\")) {
      i++; // "\ No newline at end of file" — no line number consumed
      continue;
    }

    if (line.startsWith(" ")) {
      const text = line.slice(1);
      rows.push({
        kind: "pair",
        left: { no: oldNo++, text, kind: "ctx" },
        right: { no: newNo++, text, kind: "ctx" },
      });
      i++;
      continue;
    }

    if (line.startsWith("-") || line.startsWith("+")) {
      const dels: string[] = [];
      const adds: string[] = [];
      while (i < lines.length && lines[i].startsWith("-")) dels.push(lines[i++].slice(1));
      // tolerate "\ No newline" markers interleaved between the - and + runs
      while (i < lines.length && lines[i].startsWith("\\")) i++;
      while (i < lines.length && lines[i].startsWith("+")) adds.push(lines[i++].slice(1));
      const n = Math.max(dels.length, adds.length);
      for (let k = 0; k < n; k++) {
        const left: DiffCell =
          k < dels.length ? { no: oldNo++, text: dels[k], kind: "del" } : EMPTY;
        const right: DiffCell =
          k < adds.length ? { no: newNo++, text: adds[k], kind: "add" } : EMPTY;
        rows.push({ kind: "pair", left, right });
      }
      continue;
    }

    i++; // anything else (blank trailing line) — ignore
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
 * selection; non-pair rows are ignored). A paired replace row emits both its `-old` and
 * `+new`; the line range prefers new-side numbers, falling back to old-side for pure deletes.
 */
export function formatDiffSelection(rows: DiffRow[], indices: number[]): DiffSelection {
  const lines: string[] = [];
  const nums: number[] = [];
  for (const i of indices) {
    const row = rows[i];
    if (!row || row.kind !== "pair") continue;
    const { left, right } = row;
    if (left.kind === "ctx") {
      lines.push(" " + left.text);
    } else {
      if (left.kind === "del") lines.push("-" + left.text);
      if (right.kind === "add") lines.push("+" + right.text);
    }
    if (right.no != null) nums.push(right.no);
    else if (left.no != null) nums.push(left.no);
  }
  return {
    text: lines.join("\n"),
    start: nums.length ? Math.min(...nums) : 0,
    end: nums.length ? Math.max(...nums) : 0,
    count: lines.length,
  };
}
