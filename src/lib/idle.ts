// Idle / stuck detection (AGENTIC-ENHANCEMENTS §1b). A pure predicate over pane *timing* metadata:
// an agent pane that's been silent for the configured threshold is probably wedged on a prompt.
// It feeds the existing "needs you" pill (stores/activity.ts).
//
// Opacity-safe (ADR-0001): the only stream-derived input is `lastOutputAt` — *when* bytes last
// arrived, never *what* they said. `runningAgent` is decided from the pane's own launch command
// (metadata about our spec, via lib/agents.ts) plus its lifecycle (alive, not dropped to a shell).
//
// NB: we deliberately do NOT gate on the kernel `busy` flag. Command panes launch `$SHELL -lc
// "<cmd>"` and the shell exec's the command in place, so an agent's pid *is* the pane's child pid
// — making Loom's `busy` (foreground-leader != child-pid) always false for agent panes. Gating on
// it meant the detector never fired. "Is the agent process still the live one" is the right gate.

export interface StuckInputs {
  /** The pane is a live agent: a detected agent (Claude/Codex/…) whose process is still running —
   *  not dead, and not dropped to a fallback shell after the agent exited. */
  runningAgent: boolean;
  /** Epoch-ms of the pane's most recent output (0 = none seen yet — no baseline to age from). */
  lastOutputAt: number;
}

/**
 * Is this pane idle/stuck right now? True only for a running agent pane that has emitted output at
 * least once and then been silent for at least `thresholdMs`. `thresholdMs <= 0` disables detection
 * (returns false). `now` is injected so this stays pure and testable.
 */
export function isPaneStuck(p: StuckInputs, now: number, thresholdMs: number): boolean {
  if (thresholdMs <= 0) return false; // detection off
  if (!p.runningAgent) return false; // only live agent panes, not shells or exited agents
  if (!p.lastOutputAt) return false; // never produced output — no baseline to measure silence from
  return now - p.lastOutputAt >= thresholdMs;
}
