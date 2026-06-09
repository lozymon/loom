// Agent identity from a pane's launch command. Panes are opaque (ADR-0001) — we never parse
// what a pane prints — but Termhaus owns each pane's PaneSpec.command, so deriving "this pane
// was launched as Claude / Codex / …" from that string is metadata about our own spec, not
// output inspection. The result drives a small title-bar badge (see Terminal.tsx).
//
// Detection is launch-command-only: if you open a plain shell and later type `claude` by hand,
// the spec is still the shell, so no badge appears. That's the deliberate, opacity-safe trade.

export interface AgentDef {
  /** Stable id (also the CSS modifier `agent-<id>`). */
  id: string;
  /** Human name, shown as the badge tooltip and in the wizard. */
  label: string;
  /** Short glyph/monogram rendered in the badge. */
  icon: string;
  /** Badge accent colour. */
  color: string;
  /** Canonical command to launch this agent (used by wizard quick-fill). */
  command: string;
  /** Matched against PaneSpec.command to identify a running pane. */
  match: RegExp;
}

// Order matters: first match wins. Keep `match` anchored on the program word so a flag or path
// (e.g. `npx claude`, `/usr/bin/codex --foo`) still resolves.
export const AGENTS: AgentDef[] = [
  { id: "claude",  label: "Claude Code",        icon: "✦",  color: "#d97757", command: "claude",     match: /(^|[\s/])claude($|\s)/ },
  { id: "codex",   label: "OpenAI Codex CLI",   icon: "ox", color: "#10a37f", command: "codex",      match: /(^|[\s/])codex($|\s)/ },
  { id: "gemini",  label: "Google Gemini CLI",  icon: "♊", color: "#4285f4", command: "gemini",     match: /(^|[\s/])gemini($|\s)/ },
  { id: "copilot", label: "GitHub Copilot CLI", icon: "co", color: "#8957e5", command: "copilot",    match: /(^|[\s/])(gh\s+)?copilot($|\s)/ },
  { id: "q",       label: "Amazon Q Developer", icon: "Q",  color: "#ec7211", command: "q chat",     match: /(^|[\s/])q\s+chat($|\s)/ },
  { id: "aider",   label: "Aider",              icon: "ai", color: "#14b8a6", command: "aider",      match: /(^|[\s/])aider($|\s)/ },
  { id: "cursor",  label: "Cursor (headless)",  icon: "cu", color: "#6b7280", command: "cursor-agent", match: /(^|[\s/])cursor-agent($|\s)/ },
];

/** The agent a pane is running, or null for a plain shell / unknown / empty command. */
export function detectAgent(command?: string | null): AgentDef | null {
  if (!command) return null;
  return AGENTS.find((a) => a.match.test(command)) ?? null;
}
