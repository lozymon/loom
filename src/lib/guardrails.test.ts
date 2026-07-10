import { describe, it, expect } from "vitest";
import { isDestructiveCommand, sharedFolders } from "./guardrails";

describe("isDestructiveCommand (§4b)", () => {
  it("flags the classic foot-guns", () => {
    for (const cmd of [
      "git reset --hard origin/main",
      "git clean -fd",
      "git clean -xdf",
      "git checkout --force main",
      "git checkout -f .",
      "git push --force",
      "git push -f origin main",
      "git push --force-with-lease",
      "git branch -D feature",
      "git rebase main",
      "git worktree remove ../wt",
      "rm -rf node_modules",
      "rm -fr build",
      "sudo rm /etc/thing",
    ]) {
      expect(isDestructiveCommand(cmd), cmd).toBe(true);
    }
  });

  it("leaves safe commands alone", () => {
    for (const cmd of [
      "git status",
      "git pull",
      "git commit -m wip",
      "git push",           // plain push is fine
      "npm test",
      "rm file.txt",        // no -rf
      "ls -la",
      "git reset HEAD~1",   // soft/mixed reset, not --hard
      "",
    ]) {
      expect(isDestructiveCommand(cmd), cmd).toBe(false);
    }
  });
});

describe("sharedFolders", () => {
  it("returns folders held by two or more panes", () => {
    expect(sharedFolders(["/a", "/a", "/b", null, "/c", "/c", undefined])).toEqual(["/a", "/c"]);
  });
  it("is empty when every pane has its own folder", () => {
    expect(sharedFolders(["/a", "/b", "/c"])).toEqual([]);
  });
});
