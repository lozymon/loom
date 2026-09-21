// Turn an agent's markdown reply into something worth listening to.
//
// This is the whole reason read-aloud is usable: a raw Claude reply is written to be *read* —
// fenced code, backticked identifiers, bullet markers, `[label](url)` links, ASCII rules. Fed
// straight to a TTS engine it comes out as a stream of punctuation names and URL characters. So we
// strip it to prose first, here in TS, because deciding what gets spoken is product logic (Rust
// only shells out to piper — see src-tauri/src/speech.rs).
//
// Pure and unit-tested: no DOM, no IPC.

/** Longest utterance we hand to the engine. A very long reply is truncated at a sentence boundary
 *  rather than mid-word — you can always re-trigger for the rest. */
const MAX_CHARS = 4000;

/** What a fenced code block is spoken as — you want to know one was there, not to hear it. */
const CODE_MARKER = "(code block)";

/** Markdown link `[label](url)` → its label. URLs are unlistenable and the label carries the sense. */
const LINK = /\[([^\]]*)\]\(([^)]*)\)/g;
/** A fenced code block, with or without a language tag. */
const FENCE = /^[ \t]*```[^\n]*\n[\s\S]*?^[ \t]*```[ \t]*$/gm;
/** An unterminated fence — a reply still streaming in mid-block. */
const OPEN_FENCE = /^[ \t]*```[^\n]*\n[\s\S]*$/m;
/** A bare URL left over after link-stripping. */
const BARE_URL = /\bhttps?:\/\/\S+/g;

/**
 * Reduce a markdown reply to speakable prose. Code blocks become a spoken "code block" marker
 * (you want to know one was there, not to hear it); inline code keeps its text; structural markers
 * (headings, bullets, quotes, emphasis, rules, table pipes) are dropped, with a full stop inserted
 * where one is needed so the engine pauses between what were visually separate lines.
 *
 * Returns "" when nothing speakable is left, which callers treat as "don't start speaking".
 */
export function speakableText(markdown: string): string {
  let t = markdown ?? "";

  // Order matters: fences first, so backticks inside them never reach the inline-code pass.
  t = t.replace(FENCE, `\n${CODE_MARKER}\n`);
  t = t.replace(OPEN_FENCE, `\n${CODE_MARKER}\n`);
  t = t.replace(/<!--[\s\S]*?-->/g, " "); // HTML comments
  t = t.replace(LINK, "$1");
  t = t.replace(BARE_URL, "a link");
  t = t.replace(/`+([^`]*)`+/g, "$1"); // inline code → its text

  t = t
    .split("\n")
    .map((line) => {
      let l = line.trim();
      if (/^([-*_])\1{2,}$/.test(l)) return ""; // horizontal rule
      l = l.replace(/^#{1,6}\s*/, ""); // heading marker
      l = l.replace(/^>\s?/, ""); // blockquote marker
      l = l.replace(/^[-*+]\s+/, ""); // bullet
      l = l.replace(/^\d+[.)]\s+/, ""); // numbered item
      l = l.replace(/^\|/, "").replace(/\|$/, "").replace(/\s*\|\s*/g, ", ").trim(); // table row
      if (/^[\s:,-]*$/.test(l)) return ""; // table separator / leftover punctuation
      // A line that reads as its own statement needs terminal punctuation, or the engine runs it
      // into the next one. Headings and list items almost never carry it. The code-block marker is
      // already a self-contained aside, so it's left alone.
      if (l && l !== CODE_MARKER && !/[.!?:;,]$/.test(l)) l += ".";
      return l;
    })
    .join("\n");

  t = t.replace(/\*\*([^*]+)\*\*/g, "$1"); // bold
  t = t.replace(/(^|\W)[*_]([^*_\n]+)[*_](?=\W|$)/g, "$1$2"); // italic
  t = t.replace(/~~([^~]+)~~/g, "$1"); // strikethrough
  // Decorative glyphs an agent sprinkles through prose: box-drawing, arrows, check/cross marks,
  // and the emoji planes. They either read as nothing or as a mouthful of Unicode names.
  t = t.replace(/[─-╿←-⇿✓✔✗✘•·]/g, " ");
  t = t.replace(/[\u{1f000}-\u{1ffff}\u{2600}-\u{27bf}\u{fe00}-\u{fe0f}]/gu, " ");

  t = t
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n{3,} */g, "\n\n")
    .replace(/ *\n */g, "\n")
    .trim();

  return truncateAtSentence(t, MAX_CHARS);
}

/** Cut `text` to at most `max` characters, preferring the last sentence end in the final quarter
 *  so an utterance stops on a complete thought instead of mid-word. */
function truncateAtSentence(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const cut = Math.max(head.lastIndexOf(". "), head.lastIndexOf("!\n"), head.lastIndexOf("?\n"));
  return (cut > max * 0.75 ? head.slice(0, cut + 1) : head).trim();
}
