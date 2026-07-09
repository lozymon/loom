// Markdown → HTML for the Docs panel's preview mode, built on markdown-it (CommonMark + tables,
// strikethrough, nested lists — the things a real spec/README uses). The panel's whole
// trick is that selecting a *rendered* block still sends the **raw** markdown source, so each
// top-level block we emit carries its source line range [lo, hi]: markdown-it's block tokens expose
// a `.map` ([startLine, endLineExclusive]) which we translate to an inclusive 0-based span.
//
// Safety: the output is mounted via innerHTML and a doc may come from a cloned repo, so it is NOT
// trusted. We run with `html: false` (raw HTML in the source is escaped, never rendered) and we
// render links *without* an href (the webview must never navigate away) — the destination URL goes
// in a `title="…"`, HTML-escaped via escapeAttr() so a stray quote can't break out of the attribute.

import MarkdownIt from "markdown-it";

export interface MdBlock {
  /** Rendered HTML for this block. */
  html: string;
  /** 0-based source line range this block covers (inclusive) — for reconstructing raw markdown. */
  lo: number;
  hi: number;
}

/** Escape text destined for an HTML attribute value (quotes included). */
function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// `html: false` → embedded raw HTML is escaped, not executed. `linkify` turns bare URLs into links
// (still rendered non-navigating below). `breaks: false` → a single newline is a soft break (a
// space), so hard-wrapped prose reflows instead of rendering as a ragged column. Tables and
// strikethrough are on in the default preset.
const md = new MarkdownIt({ html: false, linkify: true, breaks: false, typographer: false });

// Links: keep the link text, drop the href so a click can never navigate the webview off the app;
// stash the destination in the title for hover. (escapeAttr guards the attribute.)
md.renderer.rules.link_open = (tokens, idx) => {
  const href = tokens[idx].attrGet("href") ?? "";
  return `<a class="docs-link" title="${escapeAttr(href)}">`;
};
md.renderer.rules.link_close = () => "</a>";
// Images: render the alt text only — the panel never fetches remote images.
md.renderer.rules.image = (tokens, idx) => escapeAttr(tokens[idx].content ?? "");

/**
 * Parse markdown into renderable top-level blocks, each tagged with its source line span.
 *
 * markdown-it returns a flat token stream; a top-level block is a run of tokens whose nesting
 * depth opens and returns to zero (e.g. paragraph_open … paragraph_close), or a single self-
 * contained token (a fence, hr, code block). We render each run on its own and read the source
 * range off the opening token's `.map`.
 */
/** Render a whole Markdown document to HTML with the same safe renderer as the Docs preview
 *  (`html: false`, links stripped of their href). For trusted-enough previews (a card description a
 *  user typed) mounted via innerHTML. */
export function renderMarkdown(text: string): string {
  return md.render(text);
}

/** Flatten Markdown to a one-line plain-text snippet for compact previews (a card's summary line).
 *  Strips fences/inline code, images, link syntax (keeping the text), headings, list/quote markers
 *  and emphasis, then collapses whitespace. Not a parser — a good-enough de-marker for a preview. */
export function mdToPlainText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")          // fenced code blocks
    .replace(/`([^`]+)`/g, "$1")               // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")      // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")    // links → their text
    .replace(/^#{1,6}\s+/gm, "")                // ATX headings
    .replace(/^\s{0,3}>\s?/gm, "")              // blockquotes
    .replace(/^\s*[-*+]\s+/gm, "")              // bullet markers
    .replace(/^\s*\d+\.\s+/gm, "")              // ordered markers
    .replace(/(\*\*|__)(.*?)\1/g, "$2")         // bold
    .replace(/(\*|_)(.*?)\1/g, "$2")            // italic
    .replace(/~~(.*?)~~/g, "$1")                // strikethrough
    .replace(/\s+/g, " ")
    .trim();
}

export function parseMarkdownBlocks(text: string): MdBlock[] {
  const tokens = md.parse(text, {});
  const blocks: MdBlock[] = [];
  let i = 0;
  while (i < tokens.length) {
    // Consume one top-level block: walk until the nesting depth returns to zero.
    let j = i;
    let depth = 0;
    do {
      depth += tokens[j].nesting;
      j++;
    } while (j < tokens.length && depth > 0);
    const map = tokens[i].map;
    if (map) {
      const html = md.renderer.render(tokens.slice(i, j), md.options, {}).trim();
      blocks.push({ html, lo: map[0], hi: map[1] - 1 });
    }
    i = j;
  }
  return blocks;
}
