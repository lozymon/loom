import { describe, expect, it } from "vitest";
import { cards, addCard, updateCard, removeCard, setCardStatus, reorderCard, board } from "./board";

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

  it("scopes cards per workspace", () => {
    addCard("ws-d", { title: "X" });
    expect(cards("ws-d")).toHaveLength(1);
    expect(cards("ws-e")).toHaveLength(0);
    expect(board["ws-d"]).toBeDefined();
  });
});
