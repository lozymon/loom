import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../src/core/sessionManager.ts";
import { EventLog } from "../src/log/eventLog.ts";
import { allowHash, PolicyStore, projectRoot } from "../src/policy/store.ts";
import { fakeFactory } from "./support/fakeAdapter.ts";
import { flush } from "./support/hub.ts";

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const base = mkdtempSync(path.join(os.tmpdir(), "loom-policy-"));
  dirs.push(base);
  const repo = path.join(base, "repo");
  mkdirSync(path.join(repo, ".git"), { recursive: true });
  mkdirSync(path.join(repo, "packages", "api"), { recursive: true });
  const store = new PolicyStore({ hubFile: path.join(base, "config", "policy.json"), trustFile: path.join(base, "data", "trust.json"), home: base });
  const fake = fakeFactory();
  const manager = new SessionManager({
    log: new EventLog(":memory:", "t"),
    defaultLevel: "supervised",
    maxLevel: "accept-edits",
    adapters: { "claude-sdk": fake.factory },
    policy: store,
  });
  manager.init();
  const writeProject = (policy: object) => {
    mkdirSync(path.join(repo, ".loom"), { recursive: true });
    writeFileSync(path.join(repo, ".loom", "policy.json"), JSON.stringify(policy));
  };
  const writeHub = (policy: object) => {
    mkdirSync(path.join(base, "config"), { recursive: true });
    writeFileSync(path.join(base, "config", "policy.json"), JSON.stringify(policy));
  };
  return { base, repo, store, fake, manager, writeProject, writeHub };
}

const bash = (command: string) => ({ kind: "permission" as const, summary: `Run: ${command}`, toolName: "Bash", input: { command }, canAlwaysAllow: true });

describe("projectRoot", () => {
  it("prefers the nearest .loom, then .git, then the directory itself", () => {
    const { repo, base } = setup();
    expect(projectRoot(path.join(repo, "packages", "api"))).toBe(repo);
    mkdirSync(path.join(repo, "packages", "api", ".loom"));
    expect(projectRoot(path.join(repo, "packages", "api"))).toBe(path.join(repo, "packages", "api"));
    const loose = path.join(base, "loose");
    mkdirSync(loose);
    expect(projectRoot(loose)).toBe(loose);
  });
});

describe("approval pipeline with rules", () => {
  it("denies by rule without asking anyone, and records why", async () => {
    const { manager, fake, repo, writeHub } = setup();
    writeHub({ deny: ["Bash(rm *)"] });
    const s = await manager.create({ adapter: "claude-sdk", cwd: repo, prompt: "go" });

    const decision = await fake.latest().ask(bash("cd build && rm -rf dist"));
    expect(decision).toMatchObject({ type: "deny", message: expect.stringContaining("Bash(rm *)") });
    expect(manager.approvals()).toEqual([]);
    expect(manager.get(s.id).state).toBe("working");
    const resolved = manager.read(s.id).find((e) => e.event.type === "approval.resolved")!.event;
    expect(resolved).toMatchObject({ resolver: "rule", rule: { list: "deny", rule: "Bash(rm *)", scope: "hub" } });
  });

  it("allows by a trusted rule, and ignores the same rule until the project list is trusted", async () => {
    const { manager, fake, repo, writeProject, store } = setup();
    writeProject({ allow: ["Bash(npm test *)"] });
    await manager.create({ adapter: "claude-sdk", cwd: repo, prompt: "go" });

    const pending = fake.latest().ask(bash("npm test -- --ci"));
    await flush();
    expect(manager.approvals()).toHaveLength(1);
    const view = store.view(repo);
    expect(view.project).toMatchObject({ trusted: false, root: repo });
    manager.decide(manager.approvals()[0]!.id, { type: "deny", message: "later" });
    await pending;

    store.trust(repo, view.project.allowHash);
    await expect(fake.latest().ask(bash("npm test -- --ci"))).resolves.toEqual({ type: "allow" });
    expect(manager.approvals()).toEqual([]);
  });

  it("refuses to trust an allow list that changed after it was shown", () => {
    const { repo, writeProject, store } = setup();
    writeProject({ allow: ["Bash(npm test)"] });
    const shown = store.view(repo).project.allowHash;
    writeProject({ allow: ["Bash(npm test)", "Bash(curl *)"] });
    expect(() => store.trust(repo, shown)).toThrow(/changed since they were shown/);
  });

  it("forces a person for ask rules and rejects always-allow on them", async () => {
    const { manager, fake, repo, writeHub } = setup();
    writeHub({ allow: ["Bash(git *)"], ask: ["Bash(git push *)"] });
    await manager.create({ adapter: "claude-sdk", cwd: repo, prompt: "go" });
    void fake.latest().ask(bash("git push origin main"));
    await flush();
    const [req] = manager.approvals();
    expect(req).toMatchObject({ mustAsk: true, askRule: { rule: "Bash(git push *)" } });
    expect(() => manager.decide(req!.id, { type: "allow-rule", rule: "Bash(git push *)", scope: "project" })).toThrow(/requires a decision every time/);
    expect(() => manager.decide(req!.id, { type: "allow-always" })).toThrow(/every time/);
  });

  it("offers a narrow suggested rule and saves it on allow-rule, trusted", async () => {
    const { manager, fake, repo, store } = setup();
    await manager.create({ adapter: "claude-sdk", cwd: repo, prompt: "go" });
    const first = fake.latest().ask(bash("npm run lint"));
    await flush();
    const [req] = manager.approvals();
    expect(req).toMatchObject({ suggestedRule: "Bash(npm run lint)" });

    manager.decide(req!.id, { type: "allow-rule", rule: "Bash(npm run lint)", scope: "project" });
    await expect(first).resolves.toMatchObject({ type: "allow-rule" });
    const saved = JSON.parse(readFileSync(path.join(repo, ".loom", "policy.json"), "utf8"));
    expect(saved.allow).toEqual(["Bash(npm run lint)"]);
    expect(store.view(repo).project.trusted).toBe(true);

    await expect(fake.latest().ask(bash("npm run lint"))).resolves.toEqual({ type: "allow" });
  });

  it("refuses to save an invalid rule and leaves the approval open", async () => {
    const { manager, fake, repo } = setup();
    await manager.create({ adapter: "claude-sdk", cwd: repo, prompt: "go" });
    void fake.latest().ask(bash("npm run lint"));
    await flush();
    const [req] = manager.approvals();
    expect(() => manager.decide(req!.id, { type: "allow-rule", rule: "Bash(command:npm)", scope: "project" })).toThrow(/cannot save rule/);
    expect(manager.approvals()).toHaveLength(1);
  });

  it("keeps a saved rule untrusted when the existing project list was untrusted", async () => {
    const { manager, fake, repo, writeProject, store } = setup();
    writeProject({ allow: ["Bash(curl *)"] });
    await manager.create({ adapter: "claude-sdk", cwd: repo, prompt: "go" });
    void fake.latest().ask(bash("npm run lint"));
    await flush();
    manager.decide(manager.approvals()[0]!.id, { type: "allow-rule", rule: "Bash(npm run lint)", scope: "project" });
    expect(store.view(repo).project).toMatchObject({ trusted: false, policy: { allow: ["Bash(curl *)", "Bash(npm run lint)"] } });
  });

  it("never applies rules to clarifying questions", async () => {
    const { manager, fake, repo, writeHub } = setup();
    writeHub({ deny: ["*"] });
    await manager.create({ adapter: "claude-sdk", cwd: repo, prompt: "go" });
    void fake.latest().ask({ kind: "question", summary: "?", questions: [{ question: "?", options: [{ label: "a" }, { label: "b" }], multiSelect: false }] });
    await flush();
    expect(manager.approvals()).toHaveLength(1);
  });

  it("denies when the timeout runs out, preferring the session's timeout over policy", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { manager, fake, repo, writeProject } = setup();
    writeProject({ approvalTimeout: { minutes: 10, then: "deny" } });
    const s = await manager.create({ adapter: "claude-sdk", cwd: repo, prompt: "go", approvalTimeout: { minutes: 2, then: "deny" } });
    const decision = fake.latest().ask(bash("make"));
    await Promise.resolve();
    const [req] = manager.approvals();
    expect(req!.expiresAt! - req!.requestedAt).toBe(2 * 60_000);

    vi.advanceTimersByTime(2 * 60_000);
    await expect(decision).resolves.toMatchObject({ type: "deny", message: "No decision within 2 minutes." });
    const resolved = manager.read(s.id).find((e) => e.event.type === "approval.resolved")!.event;
    expect(resolved).toMatchObject({ resolver: "timeout" });
  });

  it("uses the project timeout, then the hub timeout", () => {
    const { repo, writeProject, writeHub, store } = setup();
    writeHub({ approvalTimeout: { minutes: 30, then: "deny" } });
    expect(store.timeoutFor(repo)).toEqual({ minutes: 30, then: "deny" });
    writeProject({ approvalTimeout: { minutes: 5, then: "deny" } });
    expect(store.timeoutFor(repo)).toEqual({ minutes: 5, then: "deny" });
  });
});

describe("policy files", () => {
  it("reports load errors and rule problems in the view", () => {
    const { repo, writeHub, store } = setup();
    writeHub({ allow: ["Write(x)"], surprise: 1 });
    const view = store.view(repo);
    expect(view.hub.loadError).toMatch(/surprise/);
    writeHub({ allow: ["Write(x)"] });
    expect(store.view(repo).hub).toMatchObject({ problems: [{ list: "allow", rule: "Write(x)" }] });
  });

  it("keeps the last good deny rules when a policy file becomes invalid", async () => {
    const { repo, writeHub, store, base } = setup();
    writeHub({ deny: ["Bash(rm *)"] });
    expect(store.evaluate(repo, { toolName: "Bash", input: { command: "rm x" } }).kind).toBe("deny");
    await new Promise((r) => setTimeout(r, 15));
    writeFileSync(path.join(base, "config", "policy.json"), "{ not json");
    expect(store.evaluate(repo, { toolName: "Bash", input: { command: "rm x" } }).kind).toBe("deny");
    expect(store.view(repo).hub.loadError).toMatch(/not valid JSON/);
  });

  it("saves project policy with trust and reads edits made on disk", async () => {
    const { repo, store } = setup();
    const view = store.save("project", repo, { allow: ["Bash(npm ci)"], deny: [], ask: [] });
    expect(view.project).toMatchObject({ exists: true, trusted: true, allowHash: allowHash(["Bash(npm ci)"]) });
    await new Promise((r) => setTimeout(r, 15));
    writeFileSync(path.join(repo, ".loom", "policy.json"), JSON.stringify({ allow: ["Bash(npm ci)", "Bash(curl *)"] }));
    expect(store.view(repo).project.trusted).toBe(false);
  });

  it("trusts an allow list regardless of order", () => {
    expect(allowHash(["b", "a", "a"])).toBe(allowHash(["a", "b"]));
  });
});
