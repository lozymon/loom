import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { projectRoot, worktreeMainRoot } from "../src/git/project.ts";
import { cardBranch, createWorktree, mainRepoRoot, removeWorktree, worktreePath } from "../src/git/worktrees.ts";
import { makeRepo } from "./support/gitRepo.ts";

const bases: string[] = [];
afterEach(() => {
  for (const b of bases.splice(0)) rmSync(b, { recursive: true, force: true });
});
function repo() {
  const r = makeRepo();
  bases.push(r.base);
  return { ...r, repo: realpathSync(r.repo), base: realpathSync(r.base) };
}

describe("worktrees", () => {
  it("creates a worktree on a new branch outside the repository, and reuses it", async () => {
    const { repo: root, base, run } = repo();
    const dataDir = path.join(base, "data");
    const wt = await createWorktree({ cwd: root, dataDir, branch: "loom/fix-login" });
    expect(wt).toMatchObject({ repoRoot: root, branch: "loom/fix-login", path: worktreePath(dataDir, root, "loom/fix-login") });
    expect(wt.path.startsWith(path.join(dataDir, "worktrees"))).toBe(true);
    expect(existsSync(path.join(wt.path, "README.md"))).toBe(true);
    expect(run("branch", "--list", "loom/fix-login").trim()).toContain("loom/fix-login");

    const again = await createWorktree({ cwd: root, dataDir, branch: "loom/fix-login" });
    expect(again.path).toBe(wt.path);
  });

  it("starts from a base ref and checks out an existing branch as is", async () => {
    const { repo: root, base, run } = repo();
    run("checkout", "-q", "-b", "feature");
    writeFileSync(path.join(root, "feature.txt"), "x\n");
    run("add", ".");
    run("commit", "-q", "-m", "feature");
    run("checkout", "-q", "main");

    const fromFeature = await createWorktree({ cwd: root, dataDir: path.join(base, "d"), branch: "loom/from-feature", baseRef: "feature" });
    expect(existsSync(path.join(fromFeature.path, "feature.txt"))).toBe(true);

    const existing = await createWorktree({ cwd: root, dataDir: path.join(base, "d"), branch: "feature" });
    expect(existsSync(path.join(existing.path, "feature.txt"))).toBe(true);
  });

  it("refuses invalid names, branches checked out elsewhere, and non-repositories", async () => {
    const { repo: root, base } = repo();
    const dataDir = path.join(base, "data");
    await expect(createWorktree({ cwd: root, dataDir, branch: "bad..name" })).rejects.toThrow(/not a valid branch name/);
    await expect(createWorktree({ cwd: root, dataDir, branch: "-x" })).rejects.toThrow(/not a valid branch name/);
    await expect(createWorktree({ cwd: root, dataDir, branch: "main" })).rejects.toThrow(/already checked out/);
    const plain = path.join(base, "plain");
    mkdirSync(plain);
    await expect(createWorktree({ cwd: plain, dataDir, branch: "x" })).rejects.toThrow(/not inside a git repository/);
  });

  it("refuses to remove a worktree with uncommitted changes unless forced, and keeps the branch", async () => {
    const { repo: root, base, run } = repo();
    const wt = await createWorktree({ cwd: root, dataDir: path.join(base, "data"), branch: "loom/dirty" });
    writeFileSync(path.join(wt.path, "new.txt"), "work in progress\n");
    await expect(removeWorktree(wt, false)).rejects.toThrow(/uncommitted changes/);
    expect(existsSync(wt.path)).toBe(true);
    await removeWorktree(wt, true);
    expect(existsSync(wt.path)).toBe(false);
    expect(run("branch", "--list", "loom/dirty").trim()).toContain("loom/dirty");
  });

  it("maps a worktree to its main repository for project identity", async () => {
    const { repo: root, base } = repo();
    mkdirSync(path.join(root, "packages", "api"), { recursive: true });
    writeFileSync(path.join(root, "packages", "api", "x.ts"), "");
    const { run } = { run: (...a: string[]) => require("node:child_process").execFileSync("git", a, { cwd: root }) };
    run("add", ".");
    run("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "api");
    const wt = await createWorktree({ cwd: root, dataDir: path.join(base, "data"), branch: "loom/api" });

    expect(worktreeMainRoot(wt.path)).toBe(root);
    expect(await mainRepoRoot(path.join(wt.path, "packages"))).toBe(root);
    expect(projectRoot(wt.path)).toBe(root);
    mkdirSync(path.join(root, "packages", "api", ".loom"));
    expect(projectRoot(path.join(wt.path, "packages", "api"))).toBe(path.join(root, "packages", "api"));
  });

  it("names card branches from their titles", () => {
    expect(cardBranch("Fix the Login flow!", "abcdef123")).toBe("loom/fix-the-login-flow-abcdef");
    expect(cardBranch("Ação: revisão", "123456789")).toBe("loom/acao-revisao-123456");
    expect(cardBranch("!!!", "zz9999")).toBe("loom/card-zz9999");
  });
});
