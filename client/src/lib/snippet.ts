const START = String.fromCharCode(1);
const END = String.fromCharCode(2);

/** Splits a snippet at the hub's match markers (U+0001 before a match, U+0002 after). */
export function snippetParts(snippet: string): Array<{ text: string; hit: boolean }> {
  const parts: Array<{ text: string; hit: boolean }> = [];
  let hit = false;
  let text = "";
  for (const ch of snippet) {
    if (ch === START || ch === END) {
      if (text) parts.push({ text, hit });
      text = "";
      hit = ch === START;
    } else {
      text += ch;
    }
  }
  if (text) parts.push({ text, hit });
  return parts;
}
