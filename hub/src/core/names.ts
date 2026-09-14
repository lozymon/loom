/** Short, distinct handles for sessions, carried over from v1 (`src/lib/grid.ts`). */
export const NAME_POOL = [
  "Faye", "Cleo", "Wade", "Iris", "Otto", "Nora",
  "Gus", "Vera", "Milo", "Edie", "Hugo", "Lena",
  "Remy", "Suki", "Cody", "Mira", "Zane", "Posy",
] as const;

/** First pool name not taken (case-insensitive), else the lowest free `Session N`. */
export function allocName(taken: Iterable<string>): string {
  const used = new Set([...taken].map((n) => n.toLowerCase()));
  for (const name of NAME_POOL) if (!used.has(name.toLowerCase())) return name;
  let i = 1;
  while (used.has(`session ${i}`)) i++;
  return `Session ${i}`;
}
