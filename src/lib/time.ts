// Tiny time-formatting helpers shared across the UI (history search, command palette, reopen
// history). Pure functions of an epoch-ms timestamp — `Date.now()` is read at call time.

/** Compact relative age, e.g. "8s ago" / "3m ago" / "2h ago" / "5d ago". */
export function ago(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
