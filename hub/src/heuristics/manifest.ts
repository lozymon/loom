import { BlockedOn } from "@loom/protocol";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";

/**
 * A screen manifest (ADR-0011): data that says how a CLI without hooks looks when it works, waits,
 * or is done. The hub code never names a CLI; manifests do.
 */
export const ScreenManifest = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/),
    name: z.string().min(1).max(80).optional(),
    /** Program names this manifest applies to: a session's agent, or the first word of its command. */
    programs: z.array(z.string().min(1).max(80)).min(1),
    /** How many of the screen's last non-empty lines the patterns see. */
    tail_lines: z.number().int().min(1).max(200).default(12),
    rule: z
      .array(
        z
          .object({
            state: z.enum(["working", "blocked", "idle"]),
            blocked_on: BlockedOn.optional(),
            /** Regular expressions (JavaScript syntax), any of which matches a line of the tail. */
            any: z.array(z.string().min(1).max(500)).min(1),
            ignore_case: z.boolean().default(false),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type ScreenManifest = z.infer<typeof ScreenManifest>;

export interface CompiledRule {
  state: "working" | "blocked" | "idle";
  blockedOn?: BlockedOn | undefined;
  patterns: RegExp[];
}

export interface LoadedManifest {
  manifest: ScreenManifest;
  rules: CompiledRule[];
  file: string;
}

/** Reads `*.toml` in `dir` and keeps the enabled ones. Problems are reported, never thrown. */
export function loadManifests(dir: string, enabled: readonly string[]): { manifests: LoadedManifest[]; problems: string[] } {
  const problems: string[] = [];
  const manifests: LoadedManifest[] = [];
  if (!existsSync(dir)) {
    if (enabled.length) problems.push(`heuristics: no manifests folder at ${dir}`);
    return { manifests, problems };
  }
  const seen = new Set<string>();
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".toml")).sort()) {
    const file = path.join(dir, name);
    try {
      const parsed = ScreenManifest.safeParse(parseToml(readFileSync(file, "utf8")));
      if (!parsed.success) {
        problems.push(`heuristics: ${name} is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
        continue;
      }
      const m = parsed.data;
      seen.add(m.id);
      if (!enabled.includes(m.id)) continue;
      const rules = m.rule.map((r) => ({
        state: r.state,
        ...(r.blocked_on ? { blockedOn: r.blocked_on } : {}),
        patterns: r.any.map((p) => new RegExp(p, r.ignore_case ? "i" : "")),
      }));
      manifests.push({ manifest: m, rules, file });
    } catch (err) {
      problems.push(`heuristics: ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  for (const id of enabled) if (!seen.has(id)) problems.push(`heuristics: "${id}" is enabled but no manifest has that id`);
  return { manifests, problems };
}

/** The manifest for a session's program, by agent name or the command's first word (without path or extension). */
export function manifestFor(manifests: readonly LoadedManifest[], session: { agent?: string | undefined; command?: string | undefined }): LoadedManifest | undefined {
  const program = session.agent ?? session.command?.trim().split(/\s+/)[0];
  if (!program) return undefined;
  const base = path.basename(program.replace(/\\/g, "/")).replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
  return manifests.find((m) => m.manifest.programs.some((p) => p.toLowerCase() === base));
}
