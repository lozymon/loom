import { z } from "zod";

/**
 * How much a session may do without a human (ADR-0006). Ordered from least to most autonomy.
 *
 * - `supervised`   every prompt that rules do not resolve goes to a human
 * - `accept-edits` file edits inside the workspace are auto-approved; everything else as supervised
 * - `assisted`     rules first, then the Steward model, humans see escalations only
 * - `full`         no prompts; deny rules still apply. Never reachable by the Cockpit.
 */
export const PERMISSION_LEVELS = ["supervised", "accept-edits", "assisted", "full"] as const;
export const PermissionLevel = z.enum(PERMISSION_LEVELS);
export type PermissionLevel = z.infer<typeof PermissionLevel>;

export function levelRank(level: PermissionLevel): number {
  return PERMISSION_LEVELS.indexOf(level);
}

/** The lower of `level` and `max`. Used whenever a hub or project maximum applies. */
export function clampLevel(level: PermissionLevel, max: PermissionLevel): PermissionLevel {
  return levelRank(level) <= levelRank(max) ? level : max;
}

/** Who is asking to change a running session's level. */
export type LevelActor = "human" | "cockpit";

export type LevelChangeCheck = { ok: true } | { ok: false; reason: string };

/**
 * Whether `actor` may move a session to `to`, given the hub's maximum.
 *
 * Humans may choose any level up to the hub maximum. The Cockpit may choose any level up to the
 * hub maximum except `full`, which always takes a human (decision 16 in PLAN.md). Lowering is
 * always allowed, for both.
 */
export function checkLevelChange(
  actor: LevelActor,
  from: PermissionLevel,
  to: PermissionLevel,
  hubMax: PermissionLevel,
): LevelChangeCheck {
  if (levelRank(to) <= levelRank(from)) return { ok: true };
  if (levelRank(to) > levelRank(hubMax)) {
    return { ok: false, reason: `level "${to}" is above this hub's maximum "${hubMax}"` };
  }
  if (actor === "cockpit" && to === "full") {
    return { ok: false, reason: `only a human may set level "full"` };
  }
  return { ok: true };
}
