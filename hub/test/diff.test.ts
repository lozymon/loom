import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/sessionManager.ts";
import { changeSummary, parseUnifiedDiff, readDiff, revertChange } from "../src/git/diff.ts";
import { EventLog } from "../src/log/eventLog.ts";
import { fakeFactory } from "./support/fakeAdapter.ts";
import { makeRepo } from "./support/gitRepo.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function repo() {
  const r = makeRepo("loom-diff-");
  cleanups.push(() => rmSync(r.base, { recursive: true, force: true }));
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
  writeFileSync(path.join(r.repo, "app.txt"), `${lines.join("\n")}\n`);
  writeFileSync(path.join(r.repo, "old-name.txt"), "a\nb\nc\nd\ne\n");
  writeFileSync(path.join(r.repo, "gone.txt"), "bye\n");
  r.run("add", ".");
  r.run("commit", "-q", "-m", "files");
  const file = (name: string) => path.join(r.repo, name);
  return { ...r, lines, file };
}

describe("readDiff", () => {
  it("lists modified, added, deleted, renamed, untracked, and binary changes with hunks", async () => {
    const r = repo();
    const changed = [...r.lines];
    changed[1] = "line 2 changed";
    changed[35] = "line 36 changed";
    writeFileSync(r.file("app.txt"), `${changed.join("\n")}\n`);
    writeFileSync(r.file("staged.txt"), "new\n");
    r.run("add", "staged.txt");
    unlinkSync(r.file("gone.txt"));
    r.run("mv", "old-name.txt", "new-name.txt");
    writeFileSync(r.file("notes.md"), "draft\nmore\n");
    writeFileSync(r.file("image.bin"), Buffer.from([0, 1, 2, 3]));

    const diff = await readDiff(r.repo, "uncommitted");
    expect(diff.git).toBe(true);
    const by = Object.fromEntries(diff.files.map((f) => [f.path, f]));
    expect(by["app.txt"]).toMatchObject({ status: "modified", added: 2, removed: 2 });
    expect(by["app.txt"]!.hunks).toHaveLength(2);
    expect(by["staged.txt"]).toMatchObject({ status: "added", added: 1 });
    expect(by["gone.txt"]).toMatchObject({ status: "deleted", removed: 1 });
    expect(by["new-name.txt"]).toMatchObject({ status: "renamed", oldPath: "old-name.txt" });
    expect(by["notes.md"]).toMatchObject({ status: "untracked", added: 2 });
    expect(by["image.bin"]).toMatchObject({ status: "untracked", binary: true, hunks: [] });

    const summary = await changeSummary(r.repo);
    expect(summary?.map((f) => f.path).sort()).toEqual(["app.txt", "gone.txt", "image.bin", "new-name.txt", "notes.md", "staged.txt"]);
    expect(await readDiff(r.base, "uncommitted")).toMatchObject({ git: false, files: [] });
  });

  it("compares a branch with where it started, including committed work", async () => {
    const r = repo();
    const start = r.run("rev-parse", "HEAD").trim();
    r.run("checkout", "-q", "-b", "feature");
    writeFileSync(r.file("feature.txt"), "done\n");
    r.run("add", ".");
    r.run("commit", "-q", "-m", "feature");
    expect((await readDiff(r.repo, "uncommitted")).files).toEqual([]);
    const branch = await readDiff(r.repo, "branch", start);
    expect(branch.files.map((f) => [f.path, f.status])).toEqual([["feature.txt", "added"]]);
    expect(branch.base).toBe(start.slice(0, 12));
  });
});

describe("revertChange", () => {
  it("reverts one hunk by id, refuses a stale id, and reverts whole files of every kind", async () => {
    const r = repo();
    const changed = [...r.lines];
    changed[1] = "line 2 changed";
    changed[35] = "line 36 changed";
    writeFileSync(r.file("app.txt"), `${changed.join("\n")}\n`);
    const first = (await readDiff(r.repo, "uncommitted")).files[0]!;

    const after = await revertChange(r.repo, "app.txt", first.hunks[0]!.id);
    expect(readFileSync(r.file("app.txt"), "utf8")).toContain("line 2\n");
    expect(readFileSync(r.file("app.txt"), "utf8")).toContain("line 36 changed");
    expect(after.files[0]!.hunks).toHaveLength(1);
    await expect(revertChange(r.repo, "app.txt", first.hunks[0]!.id)).rejects.toThrow(/no longer there/);
    await expect(revertChange(r.repo, "nothing.txt")).rejects.toThrow(/no uncommitted changes/);

    writeFileSync(r.file("staged.txt"), "new\n");
    r.run("add", "staged.txt");
    unlinkSync(r.file("gone.txt"));
    r.run("mv", "old-name.txt", "new-name.txt");
    writeFileSync(r.file("notes.md"), "draft\n");
    await revertChange(r.repo, "app.txt");
    await revertChange(r.repo, "staged.txt");
    await revertChange(r.repo, "gone.txt");
    await revertChange(r.repo, "new-name.txt");
    await revertChange(r.repo, "notes.md");
    expect(existsSync(r.file("staged.txt"))).toBe(false);
    expect(existsSync(r.file("notes.md"))).toBe(false);
    expect(readFileSync(r.file("gone.txt"), "utf8")).toBe("bye\n");
    expect(existsSync(r.file("old-name.txt"))).toBe(true);
    expect(existsSync(r.file("new-name.txt"))).toBe(false);
    expect((await readDiff(r.repo, "uncommitted")).files).toEqual([]);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: r.repo, encoding: "utf8" })).toBe("");
  });
});

describe("parseUnifiedDiff", () => {
  it("keeps hunk ids stable and counts lines", () => {
    const text = ["diff --git a/x.ts b/x.ts", "index 1..2 100644", "--- a/x.ts", "+++ b/x.ts", "@@ -1,2 +1,2 @@", " keep", "-old", "+new", ""].join("\n");
    const [a] = parseUnifiedDiff(text);
    const [b] = parseUnifiedDiff(text);
    expect(a).toMatchObject({ path: "x.ts", added: 1, removed: 1 });
    expect(a!.hunks[0]!.id).toBe(b!.hunks[0]!.id);
    expect(a!.hunks[0]!.lines).toEqual([" keep", "-old", "+new"]);
  });
});

describe("files.changed and reverts through the manager", () => {
  it("records changed files after a turn and refuses reverts while working", async () => {
    const r = repo();
    const fake = fakeFactory();
    const manager = new SessionManager({ log: new EventLog(":memory:", "t"), defaultLevel: "supervised", maxLevel: "accept-edits", adapters: { "claude-sdk": fake.factory } });
    manager.init();
    const s = await manager.create({ adapter: "claude-sdk", cwd: r.repo, prompt: "edit things" });
    const until = async (check: () => boolean) => {
      const end = Date.now() + 5000;
      while (!check()) {
        if (Date.now() > end) throw new Error("timed out");
        await new Promise((res) => setTimeout(res, 20));
      }
    };
    await until(() => manager.get(s.id).state === "working");
    writeFileSync(r.file("notes.md"), "from the session\n");
    await expect(manager.revertChange(s.id, "notes.md")).rejects.toThrow(/working/);
    fake.latest().reply("done", 0.01);
    await until(() => manager.get(s.id).changedFiles === 1);
    expect(manager.replay(0, [s.id], 1000).filter((e) => e.event.type === "files.changed").at(-1)?.event).toEqual({ type: "files.changed", files: [{ path: "notes.md", added: 0, removed: 0 }] });

    const diff = await manager.revertChange(s.id, "notes.md");
    expect(diff.files).toEqual([]);
    await until(() => manager.get(s.id).changedFiles === 0);
  });
});
