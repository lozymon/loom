import { describe, expect, it } from "vitest";
import { TerminalStream } from "../src/lib/terminalStream.ts";

const b = (s: string) => new TextEncoder().encode(s);

describe("TerminalStream", () => {
  function setup() {
    let shown = "";
    let resets = 0;
    const stream = new TerminalStream(
      (bytes) => (shown += new TextDecoder().decode(bytes)),
      () => {
        shown = "";
        resets++;
      },
    );
    return { stream, shown: () => shown, resets: () => resets };
  }

  it("drops bytes it already showed and trims overlaps", () => {
    const { stream, shown } = setup();
    stream.snapshot(10, b("hello"));
    expect(stream.data(12, b("llo world"))).toBe(true);
    expect(stream.data(10, b("hello"))).toBe(true);
    expect(shown()).toBe("hello world");
    expect(stream.next).toBe(21);
  });

  it("reports a gap so the caller can resync", () => {
    const { stream } = setup();
    stream.snapshot(0, b("abc"));
    expect(stream.data(10, b("xyz"))).toBe(false);
  });

  it("resets the view on a new snapshot", () => {
    const { stream, shown, resets } = setup();
    stream.snapshot(0, b("old"));
    stream.snapshot(100, b("new screen"));
    expect(shown()).toBe("new screen");
    expect(resets()).toBe(2);
  });
});
