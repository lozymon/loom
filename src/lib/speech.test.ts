import { describe, it, expect } from "vitest";
import { speakableText } from "./speech";

describe("speakableText", () => {
  it("replaces fenced code with a spoken marker instead of reading it out", () => {
    const out = speakableText("Here is the fix:\n\n```ts\nconst x = a ?? b;\n```\n\nThat's all.");
    expect(out).toContain("(code block)");
    expect(out).not.toContain("const x");
    expect(out).not.toContain("```");
  });

  it("handles a reply still streaming mid-code-block", () => {
    const out = speakableText("Working on it:\n\n```rust\nfn main() {");
    expect(out).toContain("(code block)");
    expect(out).not.toContain("fn main");
  });

  it("keeps inline code as its text and drops the backticks", () => {
    expect(speakableText("Call `spawnPty` first.")).toBe("Call spawnPty first.");
  });

  it("reads a link's label, never its URL", () => {
    expect(speakableText("See [the ADR](https://example.com/adr/0001-opacity.md).")).toBe(
      "See the ADR.",
    );
    expect(speakableText("Docs: https://example.com/x?y=1")).toBe("Docs: a link.");
  });

  it("strips structure markers and terminates each line so the voice pauses", () => {
    const out = speakableText("## The fix\n\n- first thing\n- second thing\n");
    // The blank line after the heading survives as a paragraph break — the engine pauses there.
    expect(out).toBe("The fix.\n\nfirst thing.\nsecond thing.");
  });

  it("drops emphasis, rules and decorative glyphs", () => {
    expect(speakableText("**Bold** and *italic* and ~~gone~~.")).toBe("Bold and italic and gone.");
    expect(speakableText("done\n\n---\n\nnext")).toBe("done.\n\nnext.");
    expect(speakableText("✓ passed → shipped")).toBe("passed shipped.");
  });

  it("flattens a table row into a readable clause", () => {
    expect(speakableText("| a | b |")).toBe("a, b.");
  });

  it("returns empty for nothing speakable", () => {
    expect(speakableText("")).toBe("");
    expect(speakableText("```\ncode\n```")).toBe("(code block)");
    expect(speakableText("---")).toBe("");
  });

  it("truncates a very long reply on a sentence boundary", () => {
    const long = "This is a sentence. ".repeat(500); // ~10k chars
    const out = speakableText(long);
    expect(out.length).toBeLessThanOrEqual(4000);
    expect(out.endsWith(".")).toBe(true);
  });
});
