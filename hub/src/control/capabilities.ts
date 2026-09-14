import type { Command, CommandName } from "@loom/protocol";
import { HubError } from "../errors.ts";
import type { Actor } from "./actor.ts";

/** What any session may do: look around, talk to others, coordinate, and add cards. */
const SESSION: ReadonlySet<CommandName> = new Set<CommandName>([
  "hub.whoami",
  "hub.stats",
  "session.list",
  "session.read",
  "session.wait",
  "session.send",
  "session.speak",
  "history.search",
  "session.diff",
  "board.get",
  "board.add",
  "notes.set",
  "notes.get",
  "notes.list",
  "notes.delete",
  "claims.claim",
  "claims.release",
  "claims.list",
]);

/** What the Cockpit may do on top: run sessions and the board, and act on approvals where allowed. */
const COCKPIT: ReadonlySet<CommandName> = new Set<CommandName>([
  ...SESSION,
  "session.create",
  "session.interrupt",
  "session.stop",
  "session.restart",
  "session.rename",
  "session.archive",
  "session.set-level",
  "approval.list",
  "approval.decide",
  "board.update",
  "board.move",
  "board.remove",
  "board.dispatch",
  "board.run",
]);

/**
 * The capability table (ADR-0007). Commands never available to a session include policy changes,
 * trust, overrides, terminal input, and event streams. Finer checks that need hub state (not your own
 * approvals, not `full`) are made where the command is handled.
 */
export function authorize(actor: Actor, cmd: Command): void {
  if (actor.kind === "human") return;
  const allowed = actor.role === "cockpit" ? COCKPIT : SESSION;
  if (!allowed.has(cmd.cmd)) {
    throw new HubError("forbidden", `${actor.role === "cockpit" ? "the Cockpit" : "a session"} cannot use ${cmd.cmd}`);
  }
}

export function canUse(role: "session" | "cockpit", name: CommandName): boolean {
  return (role === "cockpit" ? COCKPIT : SESSION).has(name);
}
