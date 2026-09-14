import type { SessionSummary } from "@loom/protocol";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BoardService } from "../board/boardService.ts";
import type { LoomIntegration } from "../core/adapter.ts";
import type { SessionManager } from "../core/sessionManager.ts";
import { inProcessApi } from "./inProcess.ts";
import { COCKPIT_PROMPT, LOOM_INSTRUCTIONS, loomTools } from "./tools.ts";

/** How to run the CLI and the stdio MCP server: the source files in development, one bundled entry when packaged. */
let launcher = {
  cli: [fileURLToPath(new URL("./cli.ts", import.meta.url))],
  mcp: [fileURLToPath(new URL("./stdioServer.ts", import.meta.url))],
};

export function useSingleEntry(script: string): void {
  launcher = { cli: [script, "cli"], mcp: [script, "mcp"] };
}

const quoted = (args: string[]) => args.map((a) => `"${a}"`).join(" ");

/** Writes the `loom` command into `binDir` so sessions can run it from their shells. */
export function installLoomShim(binDir: string, platform: NodeJS.Platform = process.platform): void {
  mkdirSync(binDir, { recursive: true });
  if (platform === "win32") {
    writeFileSync(path.join(binDir, "loom.cmd"), `@echo off\r\n"${process.execPath}" ${quoted(launcher.cli)} %*\r\n`);
  } else {
    const file = path.join(binDir, "loom");
    writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" ${quoted(launcher.cli)} "$@"\n`);
    chmodSync(file, 0o755);
  }
}

export interface IntegrationOptions {
  manager: () => SessionManager;
  boards: () => BoardService | undefined;
  hubUrl: () => string;
  binDir: string;
}

/** Builds each launch's Loom tools and environment, bound to that session's token (ADR-0007). */
export function loomIntegration(opts: IntegrationOptions): (s: SessionSummary, token: string) => LoomIntegration {
  return (s, token) => {
    const role = s.cockpit ? "cockpit" : "session";
    const caller = { sessionId: s.id, name: s.name, role, cwd: s.cwd, projectRoot: s.projectRoot } as const;
    const sep = process.platform === "win32" ? ";" : ":";
    return {
      role,
      env: {
        LOOM_HUB_URL: opts.hubUrl(),
        LOOM_SESSION_ID: s.id,
        LOOM_SESSION_TOKEN: token,
        PATH: `${opts.binDir}${sep}${process.env.PATH ?? ""}`,
      },
      tools: loomTools(caller),
      api: inProcessApi(opts.manager(), opts.boards, { kind: "session", sessionId: s.id, role }),
      stdio: { command: process.execPath, args: [...launcher.mcp] },
      instructions: LOOM_INSTRUCTIONS,
      ...(s.cockpit ? { cockpitPrompt: COCKPIT_PROMPT } : {}),
    };
  };
}
