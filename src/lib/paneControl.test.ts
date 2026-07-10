import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

// paneControl is the frontend half of the inter-pane control bus (ADR-0007): it parses a relayed
// request line, does the routing (name→pane, registry writes, layout mutation) that must live in
// TS, and replies. The routing is the real product logic, so we exercise it through the public
// surface — initPaneControl registers a `listen` callback; we capture that, feed it requests, and
// read back what gets handed to `pane_cmd_reply`. Every collaborator (registry, workspace store,
// activity store, notify, settings) is stubbed so each test pins one routing decision.

// vi.mock is hoisted above any top-level const, so the mock fns live in vi.hoisted (which runs
// first) and are pulled into local names afterwards. `settings` is a plain mutable object so
// individual tests can flip the spawn-confirm gate.
const h = vi.hoisted(() => ({
  listen: vi.fn(),
  invoke: vi.fn(() => Promise.resolve()),
  countLive: vi.fn(),
  readPane: vi.fn(),
  writeToPanes: vi.fn(),
  activeWorkspace: vi.fn(),
  broadcastTargets: vi.fn(),
  listPanes: vi.fn(),
  resolvePaneByName: vi.fn(),
  resolvePanesByRole: vi.fn(),
  revealPane: vi.fn(),
  revealPaneByName: vi.fn(),
  setPaneRole: vi.fn(),
  spawnPane: vi.fn(),
  workspaceByName: vi.fn(),
  workspaceByPaneName: vi.fn(),
  noteAttention: vi.fn(),
  clearAttention: vi.fn(),
  setStatus: vi.fn(),
  notifyAttention: vi.fn(),
  noteSet: vi.fn(),
  ensureNotesLoaded: vi.fn(() => Promise.resolve()),
  noteGet: vi.fn(),
  noteList: vi.fn(),
  noteDel: vi.fn(),
  claimFile: vi.fn(),
  releaseFile: vi.fn(),
  listClaims: vi.fn(),
  createAsk: vi.fn(),
  awaitAsk: vi.fn(),
  replyAsk: vi.fn(),
  cancelAsk: vi.fn(),
  settings: { confirmExternalSpawn: false },
}));

vi.mock("@tauri-apps/api/event", () => ({ listen: h.listen }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("./paneRegistry", () => ({ countLive: h.countLive, readPane: h.readPane, writeToPanes: h.writeToPanes }));
vi.mock("../stores/workspace", () => ({
  activeWorkspace: h.activeWorkspace,
  broadcastTargets: h.broadcastTargets,
  listPanes: h.listPanes,
  resolvePaneByName: h.resolvePaneByName,
  resolvePanesByRole: h.resolvePanesByRole,
  revealPane: h.revealPane,
  revealPaneByName: h.revealPaneByName,
  setPaneRole: h.setPaneRole,
  spawnPane: h.spawnPane,
  workspaceByName: h.workspaceByName,
  workspaceByPaneName: h.workspaceByPaneName,
}));
vi.mock("../stores/activity", () => ({ noteAttention: h.noteAttention, clearAttention: h.clearAttention, setStatus: h.setStatus }));
vi.mock("../stores/blackboard", () => ({ noteSet: h.noteSet, noteGet: h.noteGet, noteList: h.noteList, noteDel: h.noteDel, ensureNotesLoaded: h.ensureNotesLoaded }));
vi.mock("../stores/claims", () => ({ claimFile: h.claimFile, releaseFile: h.releaseFile, listClaims: h.listClaims }));
vi.mock("./askRegistry", () => ({ createAsk: h.createAsk, awaitAsk: h.awaitAsk, replyAsk: h.replyAsk, cancelAsk: h.cancelAsk }));
vi.mock("./notify", () => ({ notifyAttention: h.notifyAttention }));
vi.mock("../stores/settings", () => ({ settings: h.settings }));

const {
  listen,
  invoke,
  countLive,
  readPane,
  writeToPanes,
  activeWorkspace,
  broadcastTargets,
  listPanes,
  resolvePaneByName,
  resolvePanesByRole,
  revealPane,
  revealPaneByName,
  setPaneRole,
  spawnPane,
  workspaceByName,
  workspaceByPaneName,
  noteAttention,
  clearAttention,
  setStatus,
  notifyAttention,
  noteSet,
  noteGet,
  noteList,
  noteDel,
  claimFile,
  releaseFile,
  listClaims,
  createAsk,
  awaitAsk,
  replyAsk,
  cancelAsk,
  settings,
} = h;

import { initPaneControl } from "./paneControl";
import { Cmd, PANE_CMD_EVENT, type ControlRequest, type ControlResponse } from "../ipc/protocol";

const replyInvoke = invoke as unknown as Mock;
let handler: (event: { payload: { reqId: number; request: string } }) => Promise<void>;

/** Drive one request through the captured listener and return the parsed reply. */
async function call(request: ControlRequest | string, reqId = 1): Promise<ControlResponse> {
  const raw = typeof request === "string" ? request : JSON.stringify(request);
  await handler({ payload: { reqId, request: raw } });
  const calls = replyInvoke.mock.calls;
  const args = calls[calls.length - 1][1] as { reqId: number; response: string };
  expect(args.reqId).toBe(reqId);
  return JSON.parse(args.response) as ControlResponse;
}

beforeEach(async () => {
  vi.clearAllMocks();
  settings.confirmExternalSpawn = false;
  vi.stubGlobal("window", { confirm: vi.fn(() => true) });
  listen.mockImplementation((_event: string, cb: typeof handler) => {
    handler = cb;
    return Promise.resolve(() => {});
  });
  await initPaneControl();
});

describe("initPaneControl", () => {
  it("subscribes to the relayed pane-cmd event", () => {
    expect(listen).toHaveBeenCalledWith(PANE_CMD_EVENT, expect.any(Function));
  });

  it("replies with an error (not a throw) on an unparseable request", async () => {
    const res = await call("{not json");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/bad request/);
  });

  it("rejects an unknown op", async () => {
    const res = await call({ op: "frobnicate" } as unknown as ControlRequest);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/unknown op/);
  });

  it("echoes the original reqId back on the reply", async () => {
    listPanes.mockReturnValue([]);
    await call({ op: "list" }, 99);
    const calls = replyInvoke.mock.calls;
    const args = calls[calls.length - 1][1] as { reqId: number };
    expect(args.reqId).toBe(99);
    expect(replyInvoke).toHaveBeenCalledWith(Cmd.paneCmdReply, expect.any(Object));
  });
});

describe("list", () => {
  it("maps each pane and derives `live` from the registry", async () => {
    listPanes.mockReturnValue([
      { name: "Cleo", workspace: "main", focused: true, paneId: 1 },
      { name: "Faye", workspace: "main", focused: false, paneId: 2 },
    ]);
    countLive.mockImplementation((ids: number[]) => (ids[0] === 1 ? 1 : 0));

    const res = await call({ op: "list" });
    expect(res).toEqual({
      ok: true,
      data: [
        { name: "Cleo", workspace: "main", focused: true, live: true },
        { name: "Faye", workspace: "main", focused: false, live: false },
      ],
    });
  });
});

describe("send", () => {
  it("appends a carriage return by default and reports the write count", async () => {
    resolvePaneByName.mockReturnValue({ paneId: 3 });
    writeToPanes.mockReturnValue(1);

    const res = await call({ op: "send", target: "Cleo", text: "hello" });
    expect(writeToPanes).toHaveBeenCalledWith([3], "hello\r");
    expect(res).toEqual({ ok: true, data: { count: 1 } });
  });

  it("suppresses the carriage return when enter is false", async () => {
    resolvePaneByName.mockReturnValue({ paneId: 3 });
    writeToPanes.mockReturnValue(1);

    await call({ op: "send", target: "Cleo", text: "hello", enter: false });
    expect(writeToPanes).toHaveBeenCalledWith([3], "hello");
  });

  it("surfaces a name-resolution error without writing", async () => {
    resolvePaneByName.mockReturnValue({ error: 'no pane named "Ghost"' });
    const res = await call({ op: "send", target: "Ghost", text: "hi" });
    expect(writeToPanes).not.toHaveBeenCalled();
    expect(res).toEqual({ ok: false, error: 'no pane named "Ghost"' });
  });

  it("reports a dead pane when zero writes land", async () => {
    resolvePaneByName.mockReturnValue({ paneId: 3 });
    writeToPanes.mockReturnValue(0);
    const res = await call({ op: "send", target: "Cleo", text: "hi" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/no live pane/);
  });

  it("fans a send to every pane with a role via a role: target", async () => {
    resolvePanesByRole.mockReturnValue([3, 8]);
    writeToPanes.mockReturnValue(2);
    const res = await call({ op: "send", target: "role:reviewer", text: "look" });
    expect(resolvePanesByRole).toHaveBeenCalledWith("reviewer");
    expect(writeToPanes).toHaveBeenCalledWith([3, 8], "look\r");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toEqual({ count: 2 });
  });

  it("errors when a role: target matches no pane", async () => {
    resolvePanesByRole.mockReturnValue([]);
    const res = await call({ op: "send", target: "role:ghost", text: "x" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/no pane with role "ghost"/);
    expect(writeToPanes).not.toHaveBeenCalled();
  });
});

describe("role.set", () => {
  it("resolves the pane and persists its role", async () => {
    resolvePaneByName.mockReturnValue({ paneId: 5 });
    const res = await call({ op: "role.set", target: "Cleo", role: " reviewer " });
    expect(setPaneRole).toHaveBeenCalledWith(5, "reviewer");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toMatchObject({ name: "Cleo", role: "reviewer", cleared: false });
  });

  it("clears a role when empty", async () => {
    resolvePaneByName.mockReturnValue({ paneId: 5 });
    const res = await call({ op: "role.set", target: "Cleo", role: "" });
    expect(setPaneRole).toHaveBeenCalledWith(5, "");
    if (res.ok) expect(res.data).toMatchObject({ cleared: true });
  });
});

describe("focus by role", () => {
  it("reveals the first pane holding the role", async () => {
    resolvePanesByRole.mockReturnValue([9, 4]);
    const res = await call({ op: "focus", target: "role:builder" });
    expect(resolvePanesByRole).toHaveBeenCalledWith("builder");
    expect(revealPane).toHaveBeenCalledWith(9);
    expect(res.ok).toBe(true);
  });
});

describe("spawn", () => {
  it("rejects an empty command before touching the store", async () => {
    const res = await call({ op: "spawn", command: "   " });
    expect(spawnPane).not.toHaveBeenCalled();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/needs a command/);
  });

  it("spawns directly when the confirm gate is off", async () => {
    spawnPane.mockReturnValue({ name: "Wade" });
    const res = await call({ op: "spawn", command: "htop", name: "Wade", cwd: "/work" });
    expect(spawnPane).toHaveBeenCalledWith({ title: "Wade", command: "htop", cwd: "/work" });
    expect(res).toEqual({ ok: true, data: { name: "Wade" } });
  });

  it("asks for consent when the gate is on and honours a yes", async () => {
    settings.confirmExternalSpawn = true;
    const confirm = vi.fn(() => true);
    vi.stubGlobal("window", { confirm });
    spawnPane.mockReturnValue({ name: "Wade" });

    const res = await call({ op: "spawn", command: "htop" });
    expect(confirm).toHaveBeenCalled();
    expect(res.ok).toBe(true);
  });

  it("declines the spawn when the gate is on and the user says no", async () => {
    settings.confirmExternalSpawn = true;
    vi.stubGlobal("window", { confirm: vi.fn(() => false) });

    const res = await call({ op: "spawn", command: "rm -rf /" });
    expect(spawnPane).not.toHaveBeenCalled();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/declined/);
  });

  it("propagates a spawn store error", async () => {
    spawnPane.mockReturnValue({ error: "no active workspace" });
    const res = await call({ op: "spawn", command: "htop" });
    expect(res).toEqual({ ok: false, error: "no active workspace" });
  });
});

describe("read", () => {
  it("clamps the line count into [1, 2000] and returns the text", async () => {
    resolvePaneByName.mockReturnValue({ paneId: 4 });
    readPane.mockReturnValue("tail output");

    await call({ op: "read", target: "Cleo", lines: 99999 });
    expect(readPane).toHaveBeenCalledWith(4, 2000);

    await call({ op: "read", target: "Cleo", lines: 0 });
    expect(readPane).toHaveBeenCalledWith(4, 1);

    const res = await call({ op: "read", target: "Cleo" });
    expect(readPane).toHaveBeenCalledWith(4, 50);
    expect(res).toEqual({ ok: true, data: { text: "tail output" } });
  });

  it("errors when the pane has no readable scrollback", async () => {
    resolvePaneByName.mockReturnValue({ paneId: 4 });
    readPane.mockReturnValue(null);
    const res = await call({ op: "read", target: "Cleo" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/not available/);
  });
});

describe("broadcast", () => {
  it("targets the active workspace by default", async () => {
    activeWorkspace.mockReturnValue({ id: "w1" });
    broadcastTargets.mockReturnValue([1, 2]);
    writeToPanes.mockReturnValue(2);

    const res = await call({ op: "broadcast", text: "go" });
    expect(broadcastTargets).toHaveBeenCalledWith({ id: "w1" });
    expect(writeToPanes).toHaveBeenCalledWith([1, 2], "go\r");
    expect(res).toEqual({ ok: true, data: { count: 2 } });
  });

  it("resolves a named workspace and honours enter:false", async () => {
    workspaceByName.mockReturnValue({ id: "w2" });
    broadcastTargets.mockReturnValue([3]);
    writeToPanes.mockReturnValue(1);

    await call({ op: "broadcast", text: "go", workspace: "other", enter: false });
    expect(workspaceByName).toHaveBeenCalledWith("other");
    expect(writeToPanes).toHaveBeenCalledWith([3], "go");
  });

  it("errors when the named workspace is unknown", async () => {
    workspaceByName.mockReturnValue(undefined);
    const res = await call({ op: "broadcast", text: "go", workspace: "ghost" });
    expect(writeToPanes).not.toHaveBeenCalled();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/no workspace named/);
  });
});

describe("focus", () => {
  it("reveals the pane and returns its name", async () => {
    revealPaneByName.mockReturnValue({ name: "Cleo" });
    const res = await call({ op: "focus", target: "Cleo" });
    expect(res).toEqual({ ok: true, data: { name: "Cleo" } });
  });

  it("propagates a reveal error", async () => {
    revealPaneByName.mockReturnValue({ error: "gone" });
    const res = await call({ op: "focus", target: "Ghost" });
    expect(res).toEqual({ ok: false, error: "gone" });
  });
});

describe("attention", () => {
  it("fires an OS notification only on a fresh raise", async () => {
    resolvePaneByName.mockReturnValue({ paneId: 5 });
    noteAttention.mockReturnValue(true);

    const res = await call({ op: "attention", target: "Cleo" });
    expect(noteAttention).toHaveBeenCalledWith(5);
    expect(notifyAttention).toHaveBeenCalledWith("Cleo", "");
    expect(res).toEqual({ ok: true, data: { name: "Cleo", cleared: false } });
  });

  it("does not re-notify when attention was already raised", async () => {
    resolvePaneByName.mockReturnValue({ paneId: 5 });
    noteAttention.mockReturnValue(false);
    await call({ op: "attention", target: "Cleo" });
    expect(notifyAttention).not.toHaveBeenCalled();
  });

  it("clears attention without notifying", async () => {
    resolvePaneByName.mockReturnValue({ paneId: 5 });
    const res = await call({ op: "attention", target: "Cleo", clear: true });
    expect(clearAttention).toHaveBeenCalledWith(5);
    expect(noteAttention).not.toHaveBeenCalled();
    expect(res).toEqual({ ok: true, data: { name: "Cleo", cleared: true } });
  });
});

describe("status", () => {
  it("trims and sets the label", async () => {
    resolvePaneByName.mockReturnValue({ paneId: 6 });
    const res = await call({ op: "status", target: "Cleo", text: "  building  " });
    expect(setStatus).toHaveBeenCalledWith(6, "building");
    expect(res).toEqual({ ok: true, data: { name: "Cleo", text: "building", cleared: false } });
  });

  it("treats empty text as a clear", async () => {
    resolvePaneByName.mockReturnValue({ paneId: 6 });
    const res = await call({ op: "status", target: "Cleo", text: "   " });
    expect(setStatus).toHaveBeenCalledWith(6, "");
    expect(res).toEqual({ ok: true, data: { name: "Cleo", text: "", cleared: true } });
  });
});

describe("note (blackboard)", () => {
  // Notes are project-scoped now (keyed by folder), so the store is addressed by cwd, not id.
  const ws = { id: "w1", name: "Home", cwd: "/proj" };

  it("scopes set to the caller pane's workspace and records the writer", async () => {
    workspaceByPaneName.mockReturnValue(ws);
    const res = await call({ op: "note.set", key: "plan.api", value: "Cleo — wip", pane: "Faye" });
    expect(workspaceByPaneName).toHaveBeenCalledWith("Faye");
    expect(noteSet).toHaveBeenCalledWith("/proj", "plan.api", "Cleo — wip", "Faye");
    expect(res).toEqual({ ok: true, data: { action: "set", key: "plan.api", workspace: "Home" } });
  });

  it("prefers an explicit --workspace over the caller pane", async () => {
    workspaceByName.mockReturnValue({ id: "w2", name: "Infra", cwd: "/infra" });
    await call({ op: "note.set", key: "k", value: "v", pane: "Faye", workspace: "Infra" });
    expect(workspaceByName).toHaveBeenCalledWith("Infra");
    expect(workspaceByPaneName).not.toHaveBeenCalled();
    expect(noteSet).toHaveBeenCalledWith("/infra", "k", "v", "Faye");
  });

  it("falls back to the active workspace when no pane/workspace resolves", async () => {
    workspaceByPaneName.mockReturnValue(undefined);
    activeWorkspace.mockReturnValue(ws);
    await call({ op: "note.set", key: "k", value: "v", pane: "ghost" });
    expect(noteSet).toHaveBeenCalledWith("/proj", "k", "v", "ghost");
  });

  it("errors when --workspace names nothing", async () => {
    workspaceByName.mockReturnValue(undefined);
    const res = await call({ op: "note.set", key: "k", value: "v", workspace: "nope" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/no workspace named "nope"/);
    expect(noteSet).not.toHaveBeenCalled();
  });

  it("rejects a set with a blank key", async () => {
    activeWorkspace.mockReturnValue(ws);
    const res = await call({ op: "note.set", key: "   ", value: "v" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/needs a key/);
    expect(noteSet).not.toHaveBeenCalled();
  });

  it("get returns the entry (value, writer, timestamp)", async () => {
    activeWorkspace.mockReturnValue(ws);
    noteGet.mockReturnValue({ value: "lucia-auth", by: "Cleo", at: 123 });
    const res = await call({ op: "note.get", key: "auth.lib" });
    expect(noteGet).toHaveBeenCalledWith("/proj", "auth.lib");
    expect(res).toEqual({ ok: true, data: { action: "get", key: "auth.lib", value: "lucia-auth", by: "Cleo", at: 123 } });
  });

  it("get errors on a missing key", async () => {
    activeWorkspace.mockReturnValue(ws);
    noteGet.mockReturnValue(undefined);
    const res = await call({ op: "note.get", key: "absent" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/no note "absent" on the "Home" board/);
  });

  it("list returns the board entries", async () => {
    activeWorkspace.mockReturnValue(ws);
    const entries = [{ key: "a", value: "1", by: "Faye", at: 1 }];
    noteList.mockReturnValue(entries);
    const res = await call({ op: "note.list" });
    expect(noteList).toHaveBeenCalledWith("/proj");
    expect(res).toEqual({ ok: true, data: { action: "list", workspace: "Home", entries } });
  });

  it("del reports a hit", async () => {
    activeWorkspace.mockReturnValue(ws);
    noteDel.mockReturnValue(true);
    const res = await call({ op: "note.del", key: "a" });
    expect(noteDel).toHaveBeenCalledWith("/proj", "a");
    expect(res).toEqual({ ok: true, data: { action: "del", key: "a", workspace: "Home" } });
  });

  it("del errors when the key wasn't set", async () => {
    activeWorkspace.mockReturnValue(ws);
    noteDel.mockReturnValue(false);
    const res = await call({ op: "note.del", key: "gone" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/no note "gone" to delete/);
  });
});

describe("claim / release / claims", () => {
  const ws = { id: "w1", name: "Home" };

  it("claim takes the lock as the caller pane, scoped to its workspace", async () => {
    workspaceByPaneName.mockReturnValue(ws);
    claimFile.mockReturnValue({ ok: true, fresh: true });
    const res = await call({ op: "claim", path: "src/auth.ts", pane: "Faye" });
    expect(claimFile).toHaveBeenCalledWith("w1", "src/auth.ts", "Faye");
    expect(res).toEqual({ ok: true, data: { action: "claim", path: "src/auth.ts", by: "Faye", fresh: true } });
  });

  it("claim reports fresh=false when it's already yours", async () => {
    workspaceByPaneName.mockReturnValue(ws);
    claimFile.mockReturnValue({ ok: true, fresh: false });
    const res = await call({ op: "claim", path: "src/auth.ts", pane: "Faye" });
    expect(res).toEqual({ ok: true, data: { action: "claim", path: "src/auth.ts", by: "Faye", fresh: false } });
  });

  it("claim held by another pane is an error naming the holder", async () => {
    workspaceByPaneName.mockReturnValue(ws);
    claimFile.mockReturnValue({ ok: false, by: "Cleo", at: 1 });
    const res = await call({ op: "claim", path: "src/auth.ts", pane: "Faye" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/"src\/auth.ts" is held by Cleo/);
  });

  it("claim requires a calling pane", async () => {
    const res = await call({ op: "claim", path: "src/auth.ts" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/needs a calling pane/);
    expect(claimFile).not.toHaveBeenCalled();
  });

  it("release drops your own lock", async () => {
    workspaceByPaneName.mockReturnValue(ws);
    releaseFile.mockReturnValue({ ok: true });
    const res = await call({ op: "release", path: "src/auth.ts", pane: "Faye" });
    expect(releaseFile).toHaveBeenCalledWith("w1", "src/auth.ts", "Faye", false);
    expect(res).toEqual({ ok: true, data: { action: "release", path: "src/auth.ts" } });
  });

  it("release passes --force through", async () => {
    workspaceByPaneName.mockReturnValue(ws);
    releaseFile.mockReturnValue({ ok: true });
    await call({ op: "release", path: "src/auth.ts", pane: "Faye", force: true });
    expect(releaseFile).toHaveBeenCalledWith("w1", "src/auth.ts", "Faye", true);
  });

  it("release of an unheld path errors", async () => {
    workspaceByPaneName.mockReturnValue(ws);
    releaseFile.mockReturnValue({ ok: false, reason: "unheld" });
    const res = await call({ op: "release", path: "x", pane: "Faye" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/no claim on "x"/);
  });

  it("release of another pane's lock errors with a --force hint", async () => {
    workspaceByPaneName.mockReturnValue(ws);
    releaseFile.mockReturnValue({ ok: false, reason: "other", by: "Cleo" });
    const res = await call({ op: "release", path: "x", pane: "Faye" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/held by Cleo — use --force/);
  });

  it("claims lists the workspace's locks (no holder pane needed)", async () => {
    activeWorkspace.mockReturnValue(ws);
    const entries = [{ path: "src/a.ts", by: "Faye", at: 1 }];
    listClaims.mockReturnValue(entries);
    const res = await call({ op: "claims" });
    expect(listClaims).toHaveBeenCalledWith("w1");
    expect(res).toEqual({ ok: true, data: { action: "claims", workspace: "Home", entries } });
  });
});

describe("ask / reply", () => {
  it("ask registers a correlation id and types the question + reply instructions into the pane", async () => {
    resolvePaneByName.mockReturnValue({ paneId: 7 });
    createAsk.mockReturnValue(42);
    writeToPanes.mockReturnValue(1);
    const res = await call({ op: "ask", target: "Cleo", question: "which auth lib?", from: "Faye" });
    expect(createAsk).toHaveBeenCalledWith("Cleo", "Faye", "which auth lib?", 300_000);
    // one write to the pane, carrying the id + the reply recipe, submitted with Enter
    const [ids, text] = writeToPanes.mock.calls[0];
    expect(ids).toEqual([7]);
    expect(text).toContain("loom ask #42 from Faye");
    expect(text).toContain("loom reply 42");
    expect(text).toContain("which auth lib?");
    expect(text.endsWith("\r")).toBe(true);
    expect(res).toEqual({ ok: true, data: { id: 42 } });
  });

  it("ask cancels the registration and errors if the pane isn't live", async () => {
    resolvePaneByName.mockReturnValue({ paneId: 7 });
    createAsk.mockReturnValue(42);
    writeToPanes.mockReturnValue(0); // not live
    const res = await call({ op: "ask", target: "Cleo", question: "q", from: "Faye" });
    expect(cancelAsk).toHaveBeenCalledWith(42);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/not live/);
  });

  it("ask rejects a blank question", async () => {
    resolvePaneByName.mockReturnValue({ paneId: 7 });
    const res = await call({ op: "ask", target: "Cleo", question: "   " });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/needs a question/);
    expect(createAsk).not.toHaveBeenCalled();
  });

  it("ask errors on an unknown target", async () => {
    resolvePaneByName.mockReturnValue({ error: 'no pane named "Ghost"' });
    const res = await call({ op: "ask", target: "Ghost", question: "q" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/no pane named "Ghost"/);
  });

  it("ask.await forwards the poll result and clamps waitMs under the relay cap", async () => {
    awaitAsk.mockResolvedValue({ state: "answered", answer: "lucia-auth", by: "Cleo" });
    const res = await call({ op: "ask.await", id: 42, waitMs: 100000 });
    expect(awaitAsk).toHaveBeenCalledWith(42, 9000); // clamped from 100000
    expect(res).toEqual({ ok: true, data: { state: "answered", answer: "lucia-auth", by: "Cleo" } });
  });

  it("reply delivers the answer and records the replier", async () => {
    replyAsk.mockReturnValue(true);
    const res = await call({ op: "reply", id: 42, answer: "  lucia-auth  ", from: "Cleo" });
    expect(replyAsk).toHaveBeenCalledWith(42, "lucia-auth", "Cleo");
    expect(res).toEqual({ ok: true, data: { id: 42 } });
  });

  it("reply errors when the ask is gone (expired or already answered)", async () => {
    replyAsk.mockReturnValue(false);
    const res = await call({ op: "reply", id: 99, answer: "x" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/no open ask #99/);
  });
});
