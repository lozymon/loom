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
  revealPaneByName: vi.fn(),
  spawnPane: vi.fn(),
  workspaceByName: vi.fn(),
  noteAttention: vi.fn(),
  clearAttention: vi.fn(),
  setStatus: vi.fn(),
  notifyAttention: vi.fn(),
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
  revealPaneByName: h.revealPaneByName,
  spawnPane: h.spawnPane,
  workspaceByName: h.workspaceByName,
}));
vi.mock("../stores/activity", () => ({ noteAttention: h.noteAttention, clearAttention: h.clearAttention, setStatus: h.setStatus }));
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
  revealPaneByName,
  spawnPane,
  workspaceByName,
  noteAttention,
  clearAttention,
  setStatus,
  notifyAttention,
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
    if (!res.ok) expect(res.error).toMatch(/not live/);
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
