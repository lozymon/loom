// Minimal, self-contained markdown → HTML for the Docs panel's preview mode. We render our own
// (the project favours small purpose-built parsers — see the unified-diff parser — over a dep) and,
// crucially, each emitted block carries its *source line range* so the preview's block drag-select
// can still send the **raw** markdown: DocsPanel sends source, never rendered text. Inputs are the
// user's own local files, so innerHTML rendering is acceptable; text is still HTML-escaped before
// inline formatting so a stray "<…>" can't break the layout.

export interface MdBlock {
  /** Rendered HTML for this block. */
  html: string;
  /** 0-based source line range this block covers (inclusive) — for reconstructing raw markdown. */
  lo: number;
  hi: number;
}

// Unicode private-use chars used to fence off inline-code while other rules run; they never appear
// in real markdown, so the restore can't collide with literal text like "step 3 of".
const CODE_OPEN = String.fromCharCode(0xe000);
const CODE_CLOSE = String.fromCharCode(0xe001);

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Apply inline markdown (code, images, links, bold, italic) to an already HTML-escaped string. */
function inline(escaped: string): string {
  // Protect inline code spans first so other rules don't touch their contents.
  const codes: string[] = [];
  let s = escaped.replace(/`([^`]+)`/g, (_m, c: string) => {
    codes.push(`<code>${c}</code>`);
    return `${CODE_OPEN}${codes.length - 1}${CODE_CLOSE}`;
  });
  // Images → alt text only (the panel doesn't fetch remote images).
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  // Links → underlined text; the URL goes in the title. No href, so the webview can't navigate off.
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, t: string, u: string) => `<a class="docs-link" title="${u}">${t}</a>`);
  // Bold before italic so "**" isn't consumed by the single-"*" italic rule.
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  // Restore protected code spans.
  s = s.replace(new RegExp(`${CODE_OPEN}(\\d+)${CODE_CLOSE}`, "g"), (_m, i: string) => codes[Number(i)]);
  return s;
}

const RE_HEADING = /^(#{1,6})\s+(.*)$/;
const RE_FENCE = /^\s*(```|~~~)/;
const RE_QUOTE = /^\s*>/;
const RE_LIST = /^(\s*)([-*+]|\d+\.)\s+(.*)$/;
const RE_HR = /^\s*([-*_])(\s*\1){2,}\s*$/;

/** Parse markdown text into renderable blocks, each tagged with its source line span. */
export function parseMarkdownBlocks(text: string): MdBlock[] {
  const lines = text.split("\n");
  const blocks: MdBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") { i++; continue; }

    // Fenced code block — verbatim, no inline formatting.
    if (RE_FENCE.test(line)) {
      const marker = line.trimStart().slice(0, 3);
      const lo = i;
      i++;
      const code: string[] = [];
      while (i < lines.length && !lines[i].trimStart().startsWith(marker)) { code.push(lines[i]); i++; }
      let hi: number;
      if (i < lines.length) { hi = i; i++; } else { hi = i - 1; } // include/consume the closing fence
      blocks.push({ html: `<pre class="docs-pre"><code>${escapeHtml(code.join("\n"))}</code></pre>`, lo, hi });
      continue;
    }

    // ATX heading.
    const h = line.match(RE_HEADING);
    if (h) {
      const level = h[1].length;
      blocks.push({ html: `<h${level} class="docs-h docs-h${level}">${inline(escapeHtml(h[2].trim()))}</h${level}>`, lo: i, hi: i });
      i++; continue;
    }

    // Horizontal rule.
    if (RE_HR.test(line)) {
      blocks.push({ html: `<hr class="docs-hr" />`, lo: i, hi: i });
      i++; continue;
    }

    // Blockquote — consecutive ">" lines.
    if (RE_QUOTE.test(line)) {
      const lo = i;
      const quote: string[] = [];
      while (i < lines.length && RE_QUOTE.test(lines[i])) { quote.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
      const body = inline(escapeHtml(quote.join("\n"))).replace(/\n/g, "<br>");
      blocks.push({ html: `<blockquote class="docs-quote">${body}</blockquote>`, lo, hi: i - 1 });
      continue;
    }

    // List — consecutive item lines; ordered when the first marker is "N.".
    const first = line.match(RE_LIST);
    if (first) {
      const lo = i;
      const ordered = /\d+\./.test(first[2]);
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i].match(RE_LIST);
        if (!m) break;
        items.push(`<li>${inline(escapeHtml(m[3]))}</li>`);
        i++;
      }
      const tag = ordered ? "ol" : "ul";
      blocks.push({ html: `<${tag} class="docs-list">${items.join("")}</${tag}>`, lo, hi: i - 1 });
      continue;
    }

    // Paragraph — consecutive lines until a blank or a block-starting line.
    const lo = i;
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !RE_HEADING.test(lines[i]) &&
      !RE_FENCE.test(lines[i]) &&
      !RE_QUOTE.test(lines[i]) &&
      !RE_LIST.test(lines[i]) &&
      !RE_HR.test(lines[i])
    ) { para.push(lines[i]); i++; }
    const body = inline(escapeHtml(para.join("\n"))).replace(/\n/g, "<br>");
    blocks.push({ html: `<p class="docs-p">${body}</p>`, lo, hi: i - 1 });
  }

  return blocks;
}
