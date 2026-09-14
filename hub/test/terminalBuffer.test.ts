import { describe, expect, it } from "vitest";
import { TerminalBuffer } from "../src/core/terminalBuffer.ts";

describe("TerminalBuffer", () => {
  it("tracks absolute offsets and keeps only the tail", () => {
    const b = new TerminalBuffer(10);
    b.append(Buffer.from("hello "));
    b.append(Buffer.from("world"));
    b.append(Buffer.from("!!"));
    expect(b.end).toBe(13);
    const snap = b.snapshot();
    expect(snap.data.toString()).toBe("world!!");
    expect(snap.offset).toBe(6);
  });

  it("slices a single chunk larger than the limit", () => {
    const b = new TerminalBuffer(4);
    b.append(Buffer.from("abcdefgh"));
    expect(b.snapshot()).toEqual({ offset: 4, data: Buffer.from("efgh") });
  });

  it("attaches with a snapshot and then live bytes that continue exactly where it ended", () => {
    const b = new TerminalBuffer();
    b.append(Buffer.from("one"));
    const seen: Array<[number, string]> = [];
    const a = b.attach((offset, bytes) => seen.push([offset, bytes.toString()]));
    expect([a.offset, a.data.toString()]).toEqual([0, "one"]);
    b.append(Buffer.from("two"));
    a.detach();
    b.append(Buffer.from("three"));
    expect(seen).toEqual([[3, "two"]]);
  });
});
