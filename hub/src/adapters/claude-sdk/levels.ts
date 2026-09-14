import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type { PermissionLevel } from "@loom/protocol";

/**
 * Loom permission level to Claude Code permission mode (ADR-0006).
 * `assisted` runs in `default` mode: prompts still reach Loom, and the Steward (M5) answers them.
 */
export function permissionModeFor(level: PermissionLevel): PermissionMode {
  switch (level) {
    case "supervised":
    case "assisted":
      return "default";
    case "accept-edits":
      return "acceptEdits";
    case "full":
      return "bypassPermissions";
  }
}
