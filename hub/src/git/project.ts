import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * If `dir` is the top of a linked git worktree, the main repository's root. Read from the `.git` file
 * (`gitdir: <main>/.git/worktrees/<name>`) without running git.
 */
export function worktreeMainRoot(dir: string): string | undefined {
  const dotGit = path.join(dir, ".git");
  try {
    if (!statSync(dotGit).isFile()) return undefined;
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"));
    if (!match) return undefined;
    const gitdir = path.resolve(dir, match[1]!);
    const parts = gitdir.split(/[\\/]/);
    const i = parts.lastIndexOf("worktrees");
    if (i < 1 || parts[i - 1] !== ".git") return undefined;
    return parts.slice(0, i - 1).join(path.sep) || path.sep;
  } catch {
    return undefined;
  }
}

/** Nearest ancestor with a `.loom` folder, else with `.git`, else the directory itself. */
function plainProjectRoot(start: string): string {
  for (const marker of [".loom", ".git"]) {
    for (let dir = start; ; dir = path.dirname(dir)) {
      if (existsSync(path.join(dir, marker))) return dir;
      if (path.dirname(dir) === dir) break;
    }
  }
  return start;
}

/**
 * The project a directory belongs to (ADR-0012). Inside a linked worktree this is the matching
 * directory in the main repository, so policy, trust, and the board are the same for every branch.
 */
export function projectRoot(cwd: string): string {
  const start = path.resolve(cwd);
  for (let dir = start; ; dir = path.dirname(dir)) {
    const main = worktreeMainRoot(dir);
    if (main) {
      const mapped = path.join(main, path.relative(dir, start));
      return plainProjectRoot(existsSync(mapped) ? mapped : main);
    }
    if (existsSync(path.join(dir, ".git")) || path.dirname(dir) === dir) break;
  }
  return plainProjectRoot(start);
}
