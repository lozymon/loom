import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

// ptyClient is the thin seam over the Rust PTY commands. The two things worth pinning down
// are (1) the base64 → bytes decode that feeds xterm (it must survive high/binary bytes), and
// (2) the exact argument shape each function hands `invoke` — the contract Rust mirrors. We
// stub `@tauri-apps/api/core` with a capturing `invoke` and a fake `Channel` whose `onmessage`
// we can fire to simulate Rust emitting output/exit.
vi.mock("@tauri-apps/api/core", () => {
  class FakeChannel {
    onmessage?: (v: unknown) => void;
    emit(v: unknown) {
      this.onmessage?.(v);
    }
  }
  return { invoke: vi.fn(() => Promise.resolve(7)), Channel: FakeChannel };
});

import { invoke } from "@tauri-apps/api/core";
import {
  spawnPty,
  writePty,
  resizePty,
  killPty,
  cwdPty,
  busyPty,
  foregroundPty,
  retargetPty,
  listWslDistros,
} from "./ptyClient";
import { Cmd } from "../ipc/protocol";

const mockInvoke = invoke as unknown as Mock;

/** Encode bytes the same way Rust does (base64 of the raw octets) for the decode round-trip. */
function bytesToB64(bytes: number[]): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** The arg object from the most recent invoke call. */
function lastArgs(): Record<string, unknown> {
  const calls = mockInvoke.mock.calls;
  return calls[calls.length - 1][1] as Record<string, unknown>;
}

beforeEach(() => {
  mockInvoke.mockClear();
  mockInvoke.mockResolvedValue(7);
});

describe("spawnPty", () => {
  it("defaults every optional spec field to null and passes the channels through", async () => {
    const handle = await spawnPty({ cols: 80, rows: 24 }, () => {}, () => {});

    expect(handle).toBe(7);
    expect(mockInvoke).toHaveBeenCalledWith(Cmd.spawn, expect.any(Object));
    const args = lastArgs();
    expect(args.cols).toBe(80);
    expect(args.rows).toBe(24);
    // Omitted optionals must be explicit nulls, not undefined — Rust deserializes Option<T>.
    expect(args.command).toBeNull();
    expect(args.cwd).toBeNull();
    expect(args.shell).toBeNull();
    expect(args.name).toBeNull();
    expect(args.logPath).toBeNull();
    expect(args.onOutput).toBeDefined();
    expect(args.onExit).toBeDefined();
  });

  it("forwards every provided spec field verbatim", async () => {
    await spawnPty(
      { cols: 120, rows: 40, command: "claude --resume", cwd: "/work", shell: "/bin/zsh", name: "Cleo", logPath: "/tmp/cleo.log" },
      () => {},
      () => {},
    );
    const args = lastArgs();
    expect(args.command).toBe("claude --resume");
    expect(args.cwd).toBe("/work");
    expect(args.shell).toBe("/bin/zsh");
    expect(args.name).toBe("Cleo");
    expect(args.logPath).toBe("/tmp/cleo.log");
  });

  it("decodes base64 output frames into bytes for onOutput — including high/binary bytes", async () => {
    const seen: Uint8Array[] = [];
    await spawnPty({ cols: 80, rows: 24 }, (b) => seen.push(b), () => {});
    const outChannel = lastArgs().onOutput as { emit: (v: string) => void };

    const payload = [0, 65, 66, 127, 128, 200, 255];
    outChannel.emit(bytesToB64(payload));

    expect(seen).toHaveLength(1);
    expect(Array.from(seen[0])).toEqual(payload);
  });

  it("handles an empty output frame as an empty byte array", async () => {
    const seen: Uint8Array[] = [];
    await spawnPty({ cols: 80, rows: 24 }, (b) => seen.push(b), () => {});
    (lastArgs().onOutput as { emit: (v: string) => void }).emit("");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveLength(0);
  });

  it("passes the exit code straight through to onExit", async () => {
    let code: number | undefined;
    await spawnPty({ cols: 80, rows: 24 }, () => {}, (c) => (code = c));
    (lastArgs().onExit as { emit: (v: number) => void }).emit(137);
    expect(code).toBe(137);
  });
});

describe("retargetPty", () => {
  it("targets the live handle and rewires decode/exit onto fresh channels", async () => {
    const seen: Uint8Array[] = [];
    let code: number | undefined;
    await retargetPty(42, (b) => seen.push(b), (c) => (code = c));

    expect(mockInvoke).toHaveBeenCalledWith(Cmd.retarget, expect.objectContaining({ id: 42 }));
    const args = lastArgs();
    (args.onOutput as { emit: (v: string) => void }).emit(bytesToB64([1, 2, 3]));
    (args.onExit as { emit: (v: number) => void }).emit(0);
    expect(Array.from(seen[0])).toEqual([1, 2, 3]);
    expect(code).toBe(0);
  });
});

describe("the command wrappers each invoke the right Rust command", () => {
  it("writePty forwards text by handle id", () => {
    void writePty(5, "ls\r");
    expect(mockInvoke).toHaveBeenCalledWith(Cmd.write, { id: 5, data: "ls\r" });
  });

  it("resizePty sends cols and rows", () => {
    void resizePty(5, 100, 30);
    expect(mockInvoke).toHaveBeenCalledWith(Cmd.resize, { id: 5, cols: 100, rows: 30 });
  });

  it("killPty targets the handle", () => {
    void killPty(5);
    expect(mockInvoke).toHaveBeenCalledWith(Cmd.kill, { id: 5 });
  });

  it("cwdPty / busyPty / foregroundPty are metadata reads keyed by handle", () => {
    void cwdPty(5);
    expect(mockInvoke).toHaveBeenCalledWith(Cmd.cwd, { id: 5 });
    void busyPty(5);
    expect(mockInvoke).toHaveBeenCalledWith(Cmd.busy, { id: 5 });
    void foregroundPty(5);
    expect(mockInvoke).toHaveBeenCalledWith(Cmd.foreground, { id: 5 });
  });

  it("listWslDistros takes no args", () => {
    void listWslDistros();
    expect(mockInvoke).toHaveBeenCalledWith(Cmd.wslDistros);
  });
});
