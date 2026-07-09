import { describe, expect, it } from "vitest";
import { cards, addCard, removeCard, setCardStatus, board } from "./board";

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

  it("scopes cards per workspace", () => {
    addCard("ws-d", { title: "X" });
    expect(cards("ws-d")).toHaveLength(1);
    expect(cards("ws-e")).toHaveLength(0);
    expect(board["ws-d"]).toBeDefined();
  });
});
