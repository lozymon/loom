import type { SessionState } from "@loom/protocol";

export function formatCost(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

export function stateLabel(state: SessionState, blockedOn?: string): string {
  if (state === "blocked") return blockedOn === "question" ? "has a question" : "needs approval";
  if (state === "done") return "ended";
  return state;
}

export function shortPath(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? p : `…/${parts.slice(-2).join("/")}`;
}

export const MODEL_CHOICES: Array<{ id: string; label: string }> = [
  { id: "", label: "Default" },
  { id: "claude-opus-5", label: "Opus 5" },
  { id: "claude-sonnet-5", label: "Sonnet 5" },
  { id: "claude-fable-5-1", label: "Fable 5.1" },
  { id: "claude-haiku-4-5", label: "Haiku 4.5" },
];

export const LEVEL_LABELS = {
  supervised: "Supervised",
  "accept-edits": "Accept edits",
  assisted: "Assisted",
  full: "Full",
} as const;
