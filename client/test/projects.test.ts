import type { SessionSummary } from "@loom/protocol";
import { describe, expect, it } from "vitest";
import { groupByProject, projectName } from "../src/lib/projects.ts";

const s = (id: string, projectRoot: string, updatedAt: number, archived = false) =>
  ({ id, projectRoot, updatedAt, createdAt: updatedAt, archived }) as SessionSummary;

describe("groupByProject", () => {
  it("groups, hides archived unless asked, and orders by recent activity", () => {
    const groups = groupByProject([s("a", "/code/api", 1), s("b", "/code/web", 5), s("c", "/code/api", 9), s("d", "/code/old", 20, true)], false);
    expect(groups.map((g) => [g.name, g.sessions.map((x) => x.id)])).toEqual([
      ["api", ["c", "a"]],
      ["web", ["b"]],
    ]);
    expect(groupByProject([s("d", "/code/old", 20, true)], true)).toHaveLength(1);
  });

  it("names Windows and POSIX roots", () => {
    expect(projectName("C:\\Users\\kim\\code\\loom")).toBe("loom");
    expect(projectName("/home/kim/loom-v2")).toBe("loom-v2");
  });
});
