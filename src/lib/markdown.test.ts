import { describe, expect, it } from "vitest";
import { parseMarkdownBlocks } from "./markdown";

// The DocsPanel preview relies on each block's [lo, hi] source-line range to reconstruct the RAW
// markdown for sending — so these tests focus on the range mapping as much as the rendered HTML.
const md = (s: string) => parseMarkdownBlocks(s);
/** Reconstruct the raw source a block covers, the way DocsPanel's send does. */
const raw = (text: string, lo: number, hi: number) => text.split("\n").slice(lo, hi + 1).join("\n");

describe("parseMarkdownBlocks", () => {
  it("maps a heading to a single source line", () => {
    const text = "# Title\n\nBody text.";
    const b = md(text);
    expect(b[0].html).toContain("<h1");
    expect([b[0].lo, b[0].hi]).toEqual([0, 0]);
    expect(raw(text, b[0].lo, b[0].hi)).toBe("# Title");
  });

  it("groups a paragraph's lines and round-trips its raw source", () => {
    const text = "first line\nsecond line\n\n# Next";
    const b = md(text);
    expect(b[0].html).toContain("<p");
    expect([b[0].lo, b[0].hi]).toEqual([0, 1]);
    expect(raw(text, b[0].lo, b[0].hi)).toBe("first line\nsecond line");
    expect(b[1].lo).toBe(3);
  });

  it("keeps a fenced code block verbatim and spans the fences", () => {
    const text = "```ts\nconst x = 1 < 2;\n```";
    const b = md(text);
    expect(b).toHaveLength(1);
    expect(b[0].html).toContain("<pre");
    // Fence content is escaped, not inline-formatted.
    expect(b[0].html).toContain("const x = 1 &lt; 2;");
    expect([b[0].lo, b[0].hi]).toEqual([0, 2]);
  });

  it("renders a list as one block over all item lines", () => {
    const text = "- a\n- b\n- c";
    const b = md(text);
    expect(b).toHaveLength(1);
    expect(b[0].html).toContain("<ul");
    expect((b[0].html.match(/<li>/g) ?? []).length).toBe(3);
    expect([b[0].lo, b[0].hi]).toEqual([0, 2]);
  });

  it("uses <ol> when the first marker is numbered", () => {
    expect(md("1. one\n2. two")[0].html).toContain("<ol");
  });

  it("applies inline formatting without letting code spans collide with digits", () => {
    // "step 3 of" must survive — the code-span placeholder must not match bare digits.
    const html = md("see `code` at step 3 of `x`")[0].html;
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<code>x</code>");
    expect(html).toContain("step 3 of");
  });

  it("renders bold and italic, escaping HTML first", () => {
    const html = md("**bold** and *it* and <tag>")[0].html;
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>it</em>");
    expect(html).toContain("&lt;tag&gt;");
  });

  it("links keep their text but carry no href (no navigation)", () => {
    const html = md("[docs](https://x.test)")[0].html;
    expect(html).toContain(">docs</a>");
    expect(html).not.toContain("href");
    expect(html).toContain('title="https://x.test"');
  });
});
