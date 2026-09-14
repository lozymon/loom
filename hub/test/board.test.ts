import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BoardService, specFor } from "../src/board/boardService.ts";
import { SessionManager } from "../src/core/sessionManager.ts";
import { EventLog } from "../src/log/eventLog.ts";
import { PolicyStore } from "../src/policy/store.ts";
import { fakeFactory } from "./support/fakeAdapter.ts";
import { makeRepo } from "./support/gitRepo.ts";
import { flush } from "./support/hub.ts";

const bases: string[] = [];
afterEach(() => {
  for (const b of bases.splice(0)) rmSync(b, { recursive: true, force: true });
});

function setup() {
  const r = makeRepo("loom-board-");
  bases.push(r.base);
  const base = realpathSync(r.base);
  const repo = realpathSync(r.repo);
  const fake = fakeFactory();
  let t = 1_700_000_000_000;
  const policy = new PolicyStore({ hubFile: path.join(base, "cfg", "policy.json"), trustFile: path.join(base, "data", "trust.json") });
  const manager = new SessionManager({
    log: new EventLog(":memory:", "t"),
    defaultLevel: "supervised",
    maxLevel: "accept-edits",
    adapters: { "claude-sdk": fake.factory },
    dataDir: path.join(base, "data"),
    policy,
    now: () => (t += 1000),
  });
  manager.init();
  let ids = 0;
  const boards = new BoardService({ manager, newId: () => `card${++ids}xyz`, now: () => t });
  const frames: string[] = [];
  boards.onChange((b) => frames.push(b.cards.map((c) => `${c.title}:${c.status}`).join(",")));
  return { base, repo, fake, manager, boards, frames, policy, run: r.run };
}

async function until(check: () => boolean, what: string) {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("board", () => {
  it("adds, edits, moves, and removes cards in .loom/board.json", () => {
    const { repo, boards, frames } = setup();
    let view = boards.add(repo, { title: "Fix login", prompt: "fix it", kind: "chat" });
    const id = view.cards[0]!.id;
    view = boards.update(repo, id, { title: "Fix login flow", prompt: "fix it well", kind: "chat", model: "claude-sonnet-5" });
    view = boards.move(repo, id, "review");
    expect(view.cards[0]).toMatchObject({ title: "Fix login flow", model: "claude-sonnet-5", status: "review" });
    const file = JSON.parse(readFileSync(path.join(repo, ".loom", "board.json"), "utf8"));
    expect(file).toMatchObject({ version: 1, cards: [{ title: "Fix login flow" }] });
    boards.remove(repo, id);
    expect(boards.view(repo).cards).toEqual([]);
    expect(frames.length).toBe(4);
  });

  it("dispatches a card into a worktree session and follows it through review", async () => {
    const { repo, boards, manager, fake } = setup();
    const card = boards.add(repo, { title: "Add tests", prompt: "write tests", kind: "chat", worktree: {} }).cards[0]!;
    const session = await boards.dispatch(repo, card.id);

    expect(session).toMatchObject({ cardId: card.id, projectRoot: repo, branch: "loom/add-tests-card1x", worktree: { repoRoot: repo } });
    expect(session.cwd).not.toBe(repo);
    expect(fake.latest().sent).toEqual([{ text: "write tests", from: "card" }]);
    expect(boards.view(repo).cards[0]).toMatchObject({ status: "running", sessionId: session.id });

    fake.latest().reply("done", 0.1);
    await flush();
    expect(boards.view(repo).cards[0]!.status).toBe("review");

    await manager.send(session.id, "one more thing");
    expect(boards.view(repo).cards[0]!.status).toBe("running");
    fake.latest().host.exited("crash");
    fake.latest().host.ended?.("error", "boom");
    await flush();
  });

  it("marks a card failed when its session cannot start, and lets it be retried", async () => {
    const { repo, boards } = setup();
    const card = boards.add(repo, { title: "Bad", prompt: "", kind: "chat", worktree: { baseRef: "no-such-ref" } }).cards[0]!;
    await expect(boards.dispatch(repo, card.id)).rejects.toThrow();
    expect(boards.view(repo).cards[0]).toMatchObject({ status: "failed", lastError: expect.stringContaining("no-such-ref") });
    boards.update(repo, card.id, { title: "Bad", prompt: "", kind: "chat" });
    await expect(boards.dispatch(repo, card.id)).resolves.toMatchObject({ cardId: card.id });
  });

  it("refuses to dispatch a running card and to overwrite a board it cannot read", async () => {
    const { repo, boards } = setup();
    const card = boards.add(repo, { title: "One", prompt: "p", kind: "chat" }).cards[0]!;
    await boards.dispatch(repo, card.id);
    await expect(boards.dispatch(repo, card.id)).rejects.toThrow(/only to-do or failed/);

    await new Promise((r) => setTimeout(r, 15));
    writeFileSync(path.join(repo, ".loom", "board.json"), "{ broken");
    expect(boards.view(repo).loadError).toMatch(/not valid JSON/);
    expect(() => boards.add(repo, { title: "x", prompt: "", kind: "chat" })).toThrow(/will not overwrite/);
  });

  it("runs up to the cap, starting the next card as each one reaches review", async () => {
    const { repo, boards, fake } = setup();
    for (const title of ["A", "B", "C", "D", "E"]) boards.add(repo, { title, prompt: `do ${title}`, kind: "chat" });
    boards.run(repo, 2);
    await until(() => fake.instances.length === 2, "two sessions");
    expect(boards.view(repo).cards.map((c) => c.status)).toEqual(["running", "running", "todo", "todo", "todo"]);
    expect(boards.view(repo).runCap).toBe(2);

    fake.instances[0]!.reply("ok", 0);
    await until(() => fake.instances.length === 3, "third session");
    for (const i of [1, 2]) fake.instances[i]!.reply("ok", 0);
    await until(() => fake.instances.length === 5, "all sessions");
    for (const i of [3, 4]) fake.instances[i]!.reply("ok", 0);
    await until(() => boards.view(repo).runCap === undefined, "run to finish");
    expect(boards.view(repo).cards.map((c) => c.status)).toEqual(["review", "review", "review", "review", "review"]);
  });

  it("uses the main repository's board from inside a worktree", async () => {
    const { repo, boards } = setup();
    const card = boards.add(repo, { title: "WT", prompt: "", kind: "chat", worktree: {} }).cards[0]!;
    const session = await boards.dispatch(repo, card.id);
    expect(boards.view(session.cwd).root).toBe(repo);
  });

  it("maps card kinds to session specs", () => {
    const base = { id: "c1abcdef", status: "todo" as const, createdAt: 0, updatedAt: 0, title: "T" };
    expect(specFor({ ...base, kind: "chat", prompt: "hi", level: "accept-edits" }, "/r")).toEqual({ adapter: "claude-sdk", cwd: "/r", cardId: "c1abcdef", prompt: "hi", level: "accept-edits" });
    expect(specFor({ ...base, kind: "claude-terminal", prompt: "hi" }, "/r")).toMatchObject({ adapter: "pty", agent: "claude", prompt: "hi" });
    expect(specFor({ ...base, kind: "terminal", prompt: "npm test", worktree: {} }, "/r")).toMatchObject({ adapter: "pty", command: "npm test", worktree: { branch: "loom/t-c1abcd" } });
  });
});

describe("sessions across worktrees", () => {
  it("archives with worktree removal, refusing uncommitted work, and cannot restart a removed worktree", async () => {
    const { repo, manager } = setup();
    const s = await manager.create({ adapter: "claude-sdk", cwd: repo, worktree: { branch: "loom/archive-me" } });
    writeFileSync(path.join(s.cwd, "wip.txt"), "x");
    await expect(manager.archive(s.id, { removeWorktree: true })).rejects.toThrow(/uncommitted changes/);
    expect(manager.get(s.id).archived).toBe(false);

    await manager.archive(s.id, { removeWorktree: true, force: true });
    expect(manager.get(s.id)).toMatchObject({ archived: true, live: false, worktree: { removed: true } });
    await expect(manager.restart(s.id)).rejects.toThrow(/worktree was removed/);
    manager.unarchive(s.id);
    expect(manager.get(s.id).archived).toBe(false);
  });

  it("renames uniquely", async () => {
    const { repo, manager } = setup();
    const a = await manager.create({ adapter: "claude-sdk", cwd: repo });
    const b = await manager.create({ adapter: "claude-sdk", cwd: repo });
    manager.rename(a.id, "Planner");
    expect(() => manager.rename(b.id, "planner")).toThrow(/already called/);
    expect(manager.get(a.id).name).toBe("Planner");
  });

  it("counts cost today from session deltas, across resumes", async () => {
    const { repo, manager, fake } = setup();
    const s = await manager.create({ adapter: "claude-sdk", cwd: repo, prompt: "go" });
    fake.latest().reply("a", 0.1);
    fake.latest().reply("b", 0.25);
    await manager.stop(s.id);
    await manager.send(s.id, "again");
    fake.latest().reply("c", 0.4);
    const stats = manager.stats();
    expect(stats.costToday).toBeCloseTo(0.4);
    expect(stats.costTotal).toBeCloseTo(0.4);
    expect(stats.states).toMatchObject({ idle: 1 });
  });

  it("protects Loom policy files with built-in ask rules and passes them to the engine", async () => {
    const { repo, manager, fake, policy, base } = setup();
    const s = await manager.create({ adapter: "claude-sdk", cwd: repo, worktree: { branch: "loom/protect" } });
    expect(fake.latest().started!.protectedFiles).toEqual(
      expect.arrayContaining([path.join(repo, ".loom", "policy.json"), path.join(s.cwd, ".loom", "policy.json"), path.join(base, "cfg", "policy.json")]),
    );
    const verdict = policy.evaluate(s.cwd, { toolName: "Write", input: { file_path: path.join(s.cwd, ".loom", "policy.json") } });
    expect(verdict).toMatchObject({ kind: "ask", rule: { scope: "builtin" } });
    expect(policy.evaluate(repo, { toolName: "Bash", input: { command: "echo '{}' > .loom/policy.json" } }).kind).toBe("ask");
    mkdirSync(path.join(repo, ".loom"), { recursive: true });
    writeFileSync(path.join(repo, ".loom", "policy.json"), JSON.stringify({ allow: ["Edit"] }));
    policy.save("project", repo, { allow: ["Edit"], deny: [], ask: [] });
    expect(policy.evaluate(repo, { toolName: "Edit", input: { file_path: path.join(repo, ".loom", "policy.json") } }).kind).toBe("ask");
  });
});
