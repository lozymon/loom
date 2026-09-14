import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/log/eventLog.ts";
import { ftsQuery, searchableText } from "../src/log/searchText.ts";
import { testHub } from "./support/hub.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

const mark = (s: string) => s.replace(/\u0001/g, "[").replace(/\u0002/g, "]");

describe("history search", () => {
  it("finds messages, tool calls, and approvals, ignoring accents, by prefix, newest first", () => {
    const log = new EventLog(":memory:", "hub");
    log.append("s1", { type: "user.message", text: "Rode os testes da sessão de pagamento", from: "human" });
    log.append("s1", { type: "tool.use", toolUseId: "t1", toolName: "Bash", input: { command: "npm test -- payments" } });
    log.append("s2", { type: "assistant.text", messageId: "m1", text: "The payment tests pass now." });
    log.append("s2", { type: "tool.result", toolUseId: "t1", isError: false, preview: "secret token in output payment" });

    expect(log.search("sessao").map((h) => mark(h.snippet))).toEqual(["Rode os testes da [sessão] de pagamento"]);
    expect(log.search("payment").map((h) => [h.sessionId, h.type])).toEqual([
      ["s2", "assistant.text"],
      ["s1", "tool.use"],
    ]);
    expect(log.search("pay test", { sessionId: "s2" })).toHaveLength(1);
    expect(log.search("secret")).toEqual([]);
    for (const q of ['"', "*", "NEAR(", "a OR", "-x", "col:val", "   "]) expect(() => log.search(q)).not.toThrow();
  });

  it("indexes an existing log the first time it is opened", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "loom-search-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "events.db");
    const first = new EventLog(file, "hub");
    first.append("s1", { type: "user.message", text: "deploy the relay", from: "human" });
    first.close();
    // Simulate a log written before search existed.
    const raw = new DatabaseSync(file);
    raw.exec("DROP TABLE event_text; DELETE FROM meta WHERE key = 'search_version';");
    raw.close();
    const again = new EventLog(file, "hub");
    expect(again.search("relay")).toHaveLength(1);
    again.close();
  });

  it("names sessions in results through the manager", async () => {
    const hub = testHub();
    const s = await hub.manager.create({ adapter: "claude-sdk", cwd: "/repo", prompt: "Refactor the invoice module" });
    const hits = hub.manager.searchHistory("invoice");
    expect(hits[0]).toMatchObject({ sessionId: s.id, sessionName: s.name, type: "user.message" });
  });

  it("keeps tool output and thinking out, and makes safe queries", () => {
    expect(searchableText({ type: "assistant.thinking", messageId: "m", text: "hmm" })).toBeUndefined();
    expect(searchableText({ type: "tool.use", toolUseId: "t", toolName: "Edit", input: { file_path: "src/a.ts", old_string: "x" } })).toBe("Edit src/a.ts");
    expect(ftsQuery('git "push" --force')).toBe('"git"* "push"* "force"*');
    expect(ftsQuery("  ")).toBeUndefined();
  });
});
