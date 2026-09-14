import { existsSync } from "node:fs";
import path from "node:path";

/** What the sidecar should execute. */
export interface Launch {
  program: string;
  args: string[];
  /** Human-readable command line for the session summary. */
  display: string;
}

export interface LaunchEnv {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  exists?: (p: string) => boolean;
}

/** Quotes one argument for a POSIX shell. */
export function shQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Quotes one argument for cmd.exe running a .cmd or .bat file. */
function cmdQuote(arg: string): string {
  return /^[\w@%+=:,./\\-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`;
}

/** The user's login shell on POSIX: $SHELL if it exists, else bash, else sh (v1 resolve_shell). */
export function posixShell(le: LaunchEnv): string {
  const exists = le.exists ?? existsSync;
  const fromEnv = le.env.SHELL;
  if (fromEnv && exists(fromEnv)) return fromEnv;
  return exists("/bin/bash") ? "/bin/bash" : "/bin/sh";
}

/** Finds a program on PATH, honoring PATHEXT on Windows. */
export function resolveOnPath(program: string, le: LaunchEnv): string | undefined {
  const exists = le.exists ?? existsSync;
  const p = le.platform === "win32" ? path.win32 : path.posix;
  const exts =
    le.platform === "win32" ? (le.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((e) => e.toLowerCase()) : [""];
  const hasExt = le.platform === "win32" && exts.includes(p.extname(program).toLowerCase());
  const candidates = (dir: string) => (hasExt ? [p.join(dir, program)] : exts.map((e) => p.join(dir, program + e)));

  if (program.includes(p.sep) || (le.platform === "win32" && program.includes("/"))) {
    return (hasExt ? [program] : exts.map((e) => program + e)).find(exists);
  }
  const pathVar = le.env.PATH ?? le.env.Path ?? "";
  for (const dir of pathVar.split(le.platform === "win32" ? ";" : ":").filter(Boolean)) {
    const hit = candidates(dir).find(exists);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Splits a Windows command line into words, honoring double quotes. Backslashes are literal, which
 * is right for Windows paths.
 */
export function tokenizeWindows(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  let any = false;
  for (const ch of line) {
    if (ch === '"') {
      quoted = !quoted;
      any = true;
    } else if (!quoted && /\s/.test(ch)) {
      if (any) out.push(cur);
      cur = "";
      any = false;
    } else {
      cur += ch;
      any = true;
    }
  }
  if (any) out.push(cur);
  return out;
}

/**
 * Runs a program with arguments on Windows. `.cmd` and `.bat` files go through cmd.exe; everything
 * else is spawned directly, never through PowerShell, which deadlocks intermittently when several
 * TUIs start under ConPTY at once (v1 pty.rs).
 */
function windowsDirect(resolved: string, args: string[], le: LaunchEnv): Launch {
  const ext = path.win32.extname(resolved).toLowerCase();
  const display = [resolved, ...args].map(cmdQuote).join(" ");
  if (ext === ".cmd" || ext === ".bat") {
    const comspec = le.env.ComSpec ?? le.env.COMSPEC ?? "cmd.exe";
    return { program: comspec, args: ["/d", "/s", "/c", `"${display}"`], display };
  }
  return { program: resolved, args, display };
}

/**
 * A plain terminal: the login shell, or a command line run by it (v1 ADR-0004 carried forward in
 * ADR-0011). On Windows a command whose first word is a program on PATH is spawned directly.
 */
export function shellLaunch(command: string | undefined, le: LaunchEnv): Launch {
  const line = command?.trim();
  if (le.platform === "win32") {
    const shell = "powershell.exe";
    if (!line) return { program: shell, args: ["-NoLogo"], display: "PowerShell" };
    const [first, ...rest] = tokenizeWindows(line);
    const resolved = first ? resolveOnPath(first, le) : undefined;
    if (resolved) return windowsDirect(resolved, rest, le);
    return { program: shell, args: ["-NoLogo", "-NoProfile", "-Command", line], display: line };
  }
  const shell = posixShell(le);
  if (!line) return { program: shell, args: ["-l"], display: path.posix.basename(shell) };
  return { program: shell, args: ["-l", "-c", line], display: line };
}

/**
 * Runs a known program with exact arguments, found through the user's login environment on POSIX
 * so PATH additions from shell profiles apply.
 */
export function programLaunch(program: string, args: string[], le: LaunchEnv): Launch {
  if (le.platform === "win32") {
    const resolved = resolveOnPath(program, le);
    if (!resolved) throw new Error(`${program} was not found on PATH`);
    return windowsDirect(resolved, args, le);
  }
  const line = ["exec", program, ...args].map((a, i) => (i === 0 ? a : a === "--" ? a : shQuote(a))).join(" ");
  const shell = posixShell(le);
  return { program: shell, args: ["-l", "-c", line], display: [program, ...args.map(shQuote)].join(" ") };
}
