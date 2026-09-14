import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** A throwaway git repository with one commit. */
export function makeRepo(prefix = "loom-git-"): { base: string; repo: string; run: (...args: string[]) => string } {
  const base = mkdtempSync(path.join(os.tmpdir(), prefix));
  const repo = path.join(base, "repo");
  mkdirSync(repo);
  const run = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  run("init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("add", ".");
  run("commit", "-q", "-m", "init");
  return { base, repo, run };
}
