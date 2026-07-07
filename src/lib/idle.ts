// Idle / stuck detection (AGENTIC-ENHANCEMENTS §1b). A pure predicate over pane *timing* metadata:
// a pane is "stuck" when it's a known agent that's running a foreground command (busy) yet has
// produced no output for the configured threshold — self-reported working but silent, so probably
// wedged on a prompt. It feeds the existing "needs you" pill (stores/activity.ts).
//
// Opacity-safe (ADR-0001): the only stream-derived input is `lastOutputAt` — *when* bytes last
// arrived, never *what* they said. `isAgent` comes from the pane's own launch command (metadata
// about our spec, via lib/agents.ts), and `busy` from the kernel foreground process group.

export interface StuckInputs {
  /** Foreground-command state from the PTY poll (true = a command is running, not the shell). */
  busy: boolean | null;
  /** Epoch-ms of the pane's most recent output (0 = none seen yet — no baseline to age from). */
  lastOutputAt: number;
  /** Whether the pane is a detected agent (Claude/Codex/…), from its launch command. */
  isAgent: boolean;
}

/**
 * Is this pane idle/stuck right now? True only for an agent pane that is busy, has emitted output
 * at least once, and has then been silent for at least `thresholdMs`. `thresholdMs <= 0` disables
 * detection (returns false). `now` is injected so this stays pure and testable.
 */
export function isPaneStuck(p: StuckInputs, now: number, thresholdMs: number): boolean {
  if (thresholdMs <= 0) return false; // detection off
  if (!p.isAgent) return false; // only self-reported-working agent panes, not arbitrary commands
  if (p.busy !== true) return false; // idle at a shell prompt isn't "stuck", it's just done
  if (!p.lastOutputAt) return false; // never produced output — no baseline to measure silence from
  return now - p.lastOutputAt >= thresholdMs;
}
