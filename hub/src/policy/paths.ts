import path from "node:path";
import { escapeRegex } from "./command.ts";

export interface PathContext {
  cwd: string;
  home: string;
  /** Where a `/path` pattern anchors: the policy file's project root, or the hub config directory. */
  sourceAnchor: string;
  platform: NodeJS.Platform;
}

/** Converts a native path to the POSIX form rules match against (`C:\\Users\\a` becomes `/c/Users/a`). */
export function toPosix(p: string, platform: NodeJS.Platform): string {
  if (platform !== "win32") return path.posix.normalize(p);
  const drive = /^([A-Za-z]):[\\/]?(.*)$/.exec(p);
  const rest = (drive ? drive[2]! : p).replace(/\\/g, "/");
  return path.posix.normalize(drive ? `/${drive[1]!.toLowerCase()}/${rest}` : rest);
}

/** gitignore-style glob to a regular expression over a POSIX relative path. */
export function globToRegex(glob: string, caseInsensitive: boolean): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "\\" && i + 1 < glob.length) {
      re += escapeRegex(glob[++i]!);
    } else if (ch === "*") {
      if (glob[i + 1] === "*") {
        const atStart = i === 0 || glob[i - 1] === "/";
        const atEnd = i + 2 === glob.length;
        if (atStart && glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else if (atEnd && i > 0 && glob[i - 1] === "/") {
          re = `${re.slice(0, -1)}(?:/.*)?`;
          i += 1;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else if (ch === "[") {
      const close = glob.indexOf("]", i + 2);
      if (close === -1) re += "\\[";
      else {
        const body = glob.slice(i + 1, close).replace(/\\/g, "\\\\");
        re += `[${body.startsWith("!") ? `^${body.slice(1)}` : body}]`;
        i = close;
      }
    } else {
      re += escapeRegex(ch);
    }
  }
  return new RegExp(`^${re}$`, caseInsensitive ? "i" : "");
}

/**
 * Whether a file path matches a Read or Edit path pattern (Claude Code semantics):
 * `//abs`, `~/home`, `/source-anchored`, and `rel` or `./rel` from the session directory; a bare name
 * matches at any depth; a relative pattern with one directory segment matches at any depth only in
 * deny and ask rules.
 */
export function pathPatternMatches(pattern: string, target: string, ctx: PathContext, forAllow: boolean): boolean {
  const ci = ctx.platform === "win32";
  let p = pattern;
  let anchor: string;
  if (p.startsWith("//")) {
    anchor = "/";
    p = p.slice(2);
  } else if (p === "~" || p.startsWith("~/")) {
    anchor = toPosix(ctx.home, ctx.platform);
    p = p.slice(2);
  } else if (p.startsWith("/")) {
    anchor = toPosix(ctx.sourceAnchor, ctx.platform);
    p = p.slice(1);
  } else {
    anchor = toPosix(ctx.cwd, ctx.platform);
    if (p.startsWith("./")) p = p.slice(2);
    const segments = p.replace(/\/$/, "").split("/");
    if (!p.includes("/")) p = `**/${p}`;
    else if (!forAllow && segments.length === 2 && !p.startsWith("**")) p = `**/${p}`;
  }
  if (p.endsWith("/")) p += "**";
  if (p === "") p = "**";

  const abs = toPosix(path.isAbsolute(target) || /^[A-Za-z]:/.test(target) ? target : path.resolve(ctx.cwd, target), ctx.platform);
  const rel = path.posix.relative(anchor, abs);
  if (rel.startsWith("..") || path.posix.isAbsolute(rel)) return false;

  const re = globToRegex(p, ci);
  if (re.test(rel)) return true;
  // A directory rule such as `secrets/**` also covers the directory itself (a Grep or Glob on it).
  if (!forAllow && p.endsWith("/**")) return globToRegex(p.slice(0, -3), ci).test(rel);
  return false;
}
