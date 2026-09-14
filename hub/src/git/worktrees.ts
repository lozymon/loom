import type { WorktreeInfo } from "@loom/protocol";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { HubError } from "../errors.ts";
import { git, GitError } from "./git.ts";
import { worktreeMainRoot } from "./project.ts";

/** The main repository root containing `dir`, or undefined if it is not in a git repository. */
export async function mainRepoRoot(dir: string): Promise<string | undefined> {
  try {
    const top = (await git(["rev-parse", "--show-toplevel"], dir)).trim();
    return worktreeMainRoot(top) ?? path.resolve(top);
  } catch (err) {
    if (err instanceof GitError) return undefined;
    throw err;
  }
}

export async function assertBranchName(branch: string, cwd: string): Promise<void> {
  try {
    await git(["check-ref-format", "--branch", branch], cwd);
  } catch {
    throw new HubError("invalid", `"${branch}" is not a valid branch name`);
  }
  if (branch.startsWith("-")) throw new HubError("invalid", `"${branch}" is not a valid branch name`);
}

async function branchExists(repoRoot: string, branch: string): Promise<boolean> {
  try {
    await git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], repoRoot);
    return true;
  } catch {
    return false;
  }
}

interface ListedWorktree {
  path: string;
  branch?: string;
}

async function listWorktrees(repoRoot: string): Promise<ListedWorktree[]> {
  const out = await git(["worktree", "list", "--porcelain"], repoRoot);
  const result: ListedWorktree[] = [];
  let cur: ListedWorktree | undefined;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      cur = { path: path.resolve(line.slice(9)) };
      result.push(cur);
    } else if (line.startsWith("branch refs/heads/") && cur) {
      cur.branch = line.slice(18);
    }
  }
  return result;
}

/** Where Loom puts a worktree: inside the hub's data directory, never inside the repository. */
export function worktreePath(dataDir: string, repoRoot: string, branch: string): string {
  const tag = createHash("sha256").update(path.resolve(repoRoot)).digest("hex").slice(0, 8);
  const safeBranch = branch.replace(/[\\/:*?"<>|\s]+/g, "-");
  return path.join(dataDir, "worktrees", `${path.basename(repoRoot)}-${tag}`, safeBranch);
}

/**
 * Creates (or reuses) a worktree for `branch`. A new branch starts at `baseRef`, default HEAD; an
 * existing branch is checked out as is. Refuses a branch checked out in another worktree.
 */
export async function createWorktree(opts: { cwd: string; dataDir: string; branch: string; baseRef?: string | undefined }): Promise<WorktreeInfo> {
  const repoRoot = await mainRepoRoot(opts.cwd);
  if (!repoRoot) throw new HubError("invalid", `${opts.cwd} is not inside a git repository, so it cannot have a worktree`);
  await assertBranchName(opts.branch, repoRoot);
  const target = worktreePath(opts.dataDir, repoRoot, opts.branch);

  const existing = await listWorktrees(repoRoot);
  const same = existing.find((w) => w.path === path.resolve(target));
  const baseCommit = async () =>
    (await git(["merge-base", opts.branch, opts.baseRef ?? "HEAD"], repoRoot).catch(() => git(["rev-parse", opts.baseRef ?? "HEAD"], repoRoot))).trim();
  if (same && same.branch === opts.branch && existsSync(target)) {
    return { path: target, repoRoot, branch: opts.branch, ...(opts.baseRef ? { baseRef: opts.baseRef } : {}), baseCommit: await baseCommit() };
  }
  const elsewhere = existing.find((w) => w.branch === opts.branch);
  if (elsewhere) throw new HubError("invalid", `branch ${opts.branch} is already checked out at ${elsewhere.path}`);

  try {
    if (await branchExists(repoRoot, opts.branch)) {
      await git(["worktree", "add", target, opts.branch], repoRoot);
    } else {
      await git(["worktree", "add", "-b", opts.branch, target, opts.baseRef ?? "HEAD"], repoRoot);
    }
  } catch (err) {
    throw new HubError("invalid", err instanceof Error ? err.message : String(err));
  }
  return { path: target, repoRoot, branch: opts.branch, ...(opts.baseRef ? { baseRef: opts.baseRef } : {}), baseCommit: await baseCommit() };
}

export async function hasUncommittedChanges(worktree: string): Promise<boolean> {
  return (await git(["status", "--porcelain", "--untracked-files=normal"], worktree)).trim() !== "";
}

/** Removes a worktree directory. The branch stays. Refuses uncommitted changes unless `force`. */
export async function removeWorktree(info: WorktreeInfo, force: boolean): Promise<void> {
  if (!existsSync(info.path)) {
    await git(["worktree", "prune"], info.repoRoot).catch(() => undefined);
    return;
  }
  if (!force && (await hasUncommittedChanges(info.path))) {
    throw new HubError("invalid", `the worktree for ${info.branch} has uncommitted changes; commit them or remove it with force`);
  }
  try {
    await git(["worktree", "remove", ...(force ? ["--force"] : []), info.path], info.repoRoot);
  } catch (err) {
    throw new HubError("invalid", err instanceof Error ? err.message : String(err));
  }
}

/** A branch name for a card: `loom/<slug>-<short id>`. */
export function cardBranch(title: string, id: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `loom/${slug || "card"}-${id.slice(0, 6)}`;
}
