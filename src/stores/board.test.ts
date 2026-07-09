import { describe, expect, it } from "vitest";
import { cards, addCard, updateCard, removeCard, setCardStatus, reorderCard, reopenCard, board, drainCandidates, setDrain, drainState, type BoardCard } from "./board";

const mk = (status: BoardCard["status"], i: number): BoardCard => ({ id: `c${i}`, title: `T${i}`, prompt: "", command: "claude", status });

// Exercises the pure card CRUD (dispatch is side-effectful and covered manually). Each test uses a
// unique workspace id so they don't interfere via the shared module store.
describe("board store", () => {
  it("adds a card as To-do with a default command", () => {
    addCard("ws-a", { title: "Write tests" });
    const list = cards("ws-a");
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe("Write tests");
    expect(list[0].status).toBe("todo");
    expect(list[0].command).toBe("claude");
  });

  it("ignores a blank title and trims fields", () => {
    addCard("ws-b", { title: "   " });
    expect(cards("ws-b")).toHaveLength(0);
    addCard("ws-b", { title: "  Fix bug  ", prompt: "  do it  ", command: "  codex  " });
    expect(cards("ws-b")[0]).toMatchObject({ title: "Fix bug", prompt: "do it", command: "codex" });
  });

  it("sets status and removes by id", () => {
    addCard("ws-c", { title: "A" });
    const id = cards("ws-c")[0].id;
    setCardStatus("ws-c", id, "done");
    expect(cards("ws-c")[0].status).toBe("done");
    removeCard("ws-c", id);
    expect(cards("ws-c")).toHaveLength(0);
  });

  it("edits a card's fields, keeping the old title on a blank one", () => {
    addCard("ws-edit", { title: "old", prompt: "p", command: "claude" });
    const id = cards("ws-edit")[0].id;
    updateCard("ws-edit", id, { title: "new title", prompt: "new prompt", command: "codex" });
    expect(cards("ws-edit")[0]).toMatchObject({ title: "new title", prompt: "new prompt", command: "codex" });
    updateCard("ws-edit", id, { title: "   " }); // blank title ignored
    expect(cards("ws-edit")[0].title).toBe("new title");
    expect(updateCard("ws-edit", "nope", { title: "x" })).toBe(false);
  });

  it("reorders a card before/after a same-lane neighbour", () => {
    addCard("ws-order", { title: "A" });
    addCard("ws-order", { title: "B" });
    addCard("ws-order", { title: "C" });
    const [a, , c] = cards("ws-order").map((x) => x.id);
    reorderCard("ws-order", c, a, "before"); // C moves ahead of A
    expect(cards("ws-order").map((x) => x.title)).toEqual(["C", "A", "B"]);
    reorderCard("ws-order", c, "B", "after"); // no-op: target id "B" isn't a real id
    expect(cards("ws-order").map((x) => x.title)).toEqual(["C", "A", "B"]);
    expect(reorderCard("ws-order", c, c, "before")).toBe(false); // can't reorder onto itself
  });

  it("reopens a done/failed card back to To-do and drops its pane pin", () => {
    addCard("ws-reopen", { title: "R" });
    const id = cards("ws-reopen")[0].id;
    setCardStatus("ws-reopen", id, "failed");
    reopenCard("ws-reopen", id);
    expect(cards("ws-reopen")[0].status).toBe("todo");
    expect(cards("ws-reopen")[0].paneId).toBeUndefined();
    expect(reopenCard("ws-reopen", "nope")).toBe(false);
  });

  it("scopes cards per workspace", () => {
    addCard("ws-d", { title: "X" });
    expect(cards("ws-d")).toHaveLength(1);
    expect(cards("ws-e")).toHaveLength(0);
    expect(board["ws-d"]).toBeDefined();
  });
});

describe("auto-drainer", () => {
  it("picks the top To-do cards to fill open slots up to the cap", () => {
    const list = [mk("todo", 1), mk("todo", 2), mk("todo", 3), mk("todo", 4)];
    expect(drainCandidates(list, 2).map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  it("counts dispatched cards as occupying slots (hold the slot)", () => {
    const list = [mk("dispatched", 1), mk("todo", 2), mk("todo", 3)];
    expect(drainCandidates(list, 2).map((c) => c.id)).toEqual(["c2"]); // 1 slot free
  });

  it("dispatches nothing when the lane is already full", () => {
    const list = [mk("dispatched", 1), mk("dispatched", 2), mk("todo", 3)];
    expect(drainCandidates(list, 2)).toEqual([]);
  });

  it("ignores done/failed cards — only To-do is pulled", () => {
    const list = [mk("done", 1), mk("failed", 2), mk("todo", 3)];
    expect(drainCandidates(list, 3).map((c) => c.id)).toEqual(["c3"]);
  });

  it("arms/disarms drain and clamps the cap to at least 1", () => {
    expect(drainState("ws-drain").on).toBe(false);
    expect(drainState("ws-drain").cap).toBe(3); // default
    setDrain("ws-drain", true, 5);
    expect(drainState("ws-drain")).toMatchObject({ on: true, cap: 5 });
    setDrain("ws-drain", true, 0); // clamps up
    expect(drainState("ws-drain").cap).toBe(1);
    setDrain("ws-drain", false); // keeps the cap when omitted
    expect(drainState("ws-drain")).toMatchObject({ on: false, cap: 1 });
  });

  it("arms drain for a folderless (in-memory) workspace too, like cards do", () => {
    setDrain("", true, 4);
    expect(drainState("")).toMatchObject({ on: true, cap: 4 });
    setDrain("", false); // reset the shared "" key so other tests aren't affected
  });
});
