// Agent identity from a pane's launch command. Panes are opaque (ADR-0001) — we never parse
// what a pane prints — but Loom owns each pane's PaneSpec.command, so deriving "this pane
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
  /**
   * ADR-0011 opt-in: may the labeled *heuristic* output-observer run against this kind? On for
   * hookless agents whose kernel/pushed floor is thin (Codex, Aider, Gemini, …), so a scraped
   * "looks like it's waiting on you" floor adds real value; off (undefined) for kinds that push
   * rich lifecycle signals (Claude Code), where a guess would only ever be noise below the truth.
   * This is the per-agent-kind gate ADR-0011 §22 calls out — the tier's default-off mechanism.
   */
  heuristics?: boolean;
}

// Order matters: first match wins. Keep `match` anchored on the program word so a flag or path
// (e.g. `npx claude`, `/usr/bin/codex --foo`) still resolves.
export const AGENTS: AgentDef[] = [
  { id: "claude",  label: "Claude Code",        icon: "✦",  color: "#d97757", command: "claude",     match: /(^|[\s/])claude($|\s)/ },
  { id: "codex",   label: "OpenAI Codex CLI",   icon: "ox", color: "#10a37f", command: "codex",      match: /(^|[\s/])codex($|\s)/, heuristics: true },
  { id: "gemini",  label: "Google Gemini CLI",  icon: "♊", color: "#4285f4", command: "gemini",     match: /(^|[\s/])gemini($|\s)/, heuristics: true },
  { id: "copilot", label: "GitHub Copilot CLI", icon: "co", color: "#8957e5", command: "copilot",    match: /(^|[\s/])(gh\s+)?copilot($|\s)/, heuristics: true },
  { id: "q",       label: "Amazon Q Developer", icon: "Q",  color: "#ec7211", command: "q chat",     match: /(^|[\s/])q\s+chat($|\s)/, heuristics: true },
  { id: "aider",   label: "Aider",              icon: "ai", color: "#14b8a6", command: "aider",      match: /(^|[\s/])aider($|\s)/, heuristics: true },
  { id: "cursor",  label: "Cursor (headless)",  icon: "cu", color: "#6b7280", command: "cursor-agent", match: /(^|[\s/])cursor-agent($|\s)/, heuristics: true },
];

/** The agent a pane is running, or null for a plain shell / unknown / empty command. */
export function detectAgent(command?: string | null): AgentDef | null {
  if (!command) return null;
  return AGENTS.find((a) => a.match.test(command)) ?? null;
}

/** Is the ADR-0011 heuristic observer allowed to inspect this pane's output? True only for a
 *  detected agent kind that opts in (hookless kinds). Claude / plain shells / unknowns → false,
 *  so their bytes are never content-inspected. This is the registry gate; a global settings
 *  kill-switch and the pushed-beats-scraped suppression sit on top of it (see stores/heuristics). */
export function agentUsesHeuristics(command?: string | null): boolean {
  return detectAgent(command)?.heuristics === true;
}

// A resume/continue/session flag the user wrote themselves — then conversation lifecycle is their
// call and we leave the command untouched (no managed session id, no rewrite).
const CLAUDE_SESSION_FLAG = /(^|\s)(--session-id|--resume|-r|--continue|-c|--fork-session)(\s|=|$)/;

/**
 * Rewrite a Claude Code pane's launch command so it resumes its own conversation across app
 * restarts. Claude already persists every conversation under `~/.claude` keyed by session id;
 * Loom just relaunches with a *stable* id — pinning one on the pane's first run via `--session-id`,
 * then reattaching on every later run via `--resume`. Each pane gets its own id, so any number of
 * Claude panes can share a folder and still resume their own thread (unlike bare `claude -c`).
 *
 * `sessionExists` says whether a transcript for the pinned id is actually on disk. A session can be
 * pinned but never conversed in (blocked at the trust dialog, or closed before typing) — then there
 * is nothing to resume, so we re-pin the *same* id with `--session-id` and start it, rather than
 * `--resume` failing with "No conversation found". Once it's been used, the file exists → resume.
 *
 * This is opacity-safe (ADR-0001): Loom only ever constructs a launch command from its own spec and
 * Claude's own on-disk session store — it never reads what the pane prints. Only Claude panes are
 * touched, and only when the user hasn't already put a resume/continue/session flag in their command.
 *
 * Pure (the caller supplies the id factory + the disk check). Returns the effective command plus the
 * session id to persist back onto the spec — both unchanged when nothing applies.
 */
export function resumeClaudeCommand(
  spec: { command?: string; sessionId?: string },
  opts: { enabled: boolean; newId: () => string; sessionExists?: boolean },
): { command?: string; sessionId?: string } {
  const command = spec.command;
  if (!opts.enabled || !command) return { command, sessionId: spec.sessionId };
  if (detectAgent(command)?.id !== "claude") return { command, sessionId: spec.sessionId };
  if (CLAUDE_SESSION_FLAG.test(command)) return { command, sessionId: spec.sessionId };
  if (spec.sessionId) {
    const flag = opts.sessionExists ? `--resume ${spec.sessionId}` : `--session-id ${spec.sessionId}`;
    return { command: `${command} ${flag}`, sessionId: spec.sessionId };
  }
  const id = opts.newId();
  return { command: `${command} --session-id ${id}`, sessionId: id };
}
