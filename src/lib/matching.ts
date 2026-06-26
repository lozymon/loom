// Small pure string-matching helper for the command palette (fuzzy). Kept dependency-free and
// side-effect-free so it's unit-tested directly (matching.test.ts).

/**
 * Score `text` against a fuzzy `query` (subsequence match, case-insensitive). Returns a
 * number where higher is better, or `null` when `query` isn't a subsequence of `text`.
 * An empty query matches everything with score 0. Rewards contiguous runs and matches at
 * word starts so "nw" ranks "New Workspace" above an incidental scatter match.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (q === "") return 0;
  let score = 0;
  let ti = 0;
  let prevMatch = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    const found = t.indexOf(ch, ti);
    if (found === -1) return null;
    score += 1;
    if (found === prevMatch + 1) score += 3; // contiguous run
    const before = found === 0 ? "" : t[found - 1];
    if (found === 0 || before === " " || before === "-" || before === "/" || before === ":") {
      score += 2; // word-boundary hit
    }
    prevMatch = found;
    ti = found + 1;
  }
  // Slight preference for shorter targets (a tighter match overall).
  return score - t.length * 0.01;
}
