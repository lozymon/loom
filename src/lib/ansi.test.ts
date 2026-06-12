import { describe, expect, it } from "vitest";
import { stripAnsi } from "./ansi";

describe("stripAnsi", () => {
  it("removes SGR colour codes, keeping the text", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m text")).toBe("red text");
  });

  it("removes cursor-movement / erase CSI sequences", () => {
    expect(stripAnsi("a\x1b[2Kb\x1b[3Dc")).toBe("abc");
  });

  it("removes OSC title/clipboard sequences (BEL- and ST-terminated)", () => {
    expect(stripAnsi("\x1b]0;window title\x07hello")).toBe("hello");
    expect(stripAnsi("\x1b]52;c;Zm9v\x1b\\done")).toBe("done");
  });

  it("normalises CRLF and lone CR to newlines", () => {
    expect(stripAnsi("a\r\nb\rc")).toBe("a\nb\nc");
  });

  it("keeps tabs and newlines but drops other control bytes (e.g. bell)", () => {
    expect(stripAnsi("a\tb\nc\x07d\x00e")).toBe("a\tb\ncde");
  });

  it("leaves plain text untouched", () => {
    expect(stripAnsi("just normal output")).toBe("just normal output");
  });
});
