import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * Finds the loom-pty binary: `LOOM_PTY_BIN`, then a release or debug build in the repo, then next to
 * the running executable (how a packaged hub ships it).
 */
export function locatePtySidecar(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  const exe = platform === "win32" ? "loom-pty.exe" : "loom-pty";
  const candidates = [
    env.LOOM_PTY_BIN,
    path.join(REPO_ROOT, "sidecars", "pty", "target", "release", exe),
    path.join(REPO_ROOT, "sidecars", "pty", "target", "debug", exe),
    path.join(path.dirname(process.execPath), exe),
  ];
  return candidates.find((c): c is string => typeof c === "string" && c !== "" && existsSync(c));
}

/**
 * Variables Claude Code sets for its own child processes. A hub started from inside a Claude Code
 * session would otherwise pass them to terminals, and `claude` run there would think it is nested.
 */
const INHERITED_SESSION_VARS = [
  "CLAUDECODE",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SSE_PORT",
];

/** The environment terminals inherit: the hub's, minus another Claude session's private variables. */
export function terminalBaseEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && !INHERITED_SESSION_VARS.includes(k)) out[k] = v;
  }
  return out;
}
