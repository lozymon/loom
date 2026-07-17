// Loom's own tokens (src/App.css frameless palette), so the app reads as part of Loom. Dark-first,
// matching Loom's default. The semantic --state-* colours carry constant meaning across the product;
// the amber "needs you" is what the fleet + clearance surfaces lean on.

export const C = {
  canvas: "#0e0f12",
  surface: "#191b20",
  surfaceDead: "#141518",
  textBright: "#e7e7ea",
  textMid: "#9a9da3",
  textDim: "#7b7e84",
  textFaint: "#5f6268",
  accent: "#22d3ee",
  accentText: "#67e8f9",
  hairline: "rgba(255,255,255,0.08)",
  working: "#5fb389",
  idle: "#6b6e74",
  needs: "#c89244",
  dead: "#9a6b6b",
} as const;

/** Dot colour for a pane's state (P0c signals). */
export function stateColor(p: {
  live: boolean;
  attention?: boolean;
  sessionState?: string;
}): string {
  if (!p.live) return C.dead;
  if (p.attention || p.sessionState === "blocked") return C.needs;
  if (p.sessionState === "running") return C.working;
  return C.idle;
}
