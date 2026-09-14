import { levelRank, PERMISSION_LEVELS, type PermissionLevel } from "@loom/protocol";
import { For } from "solid-js";
import { LEVEL_LABELS } from "../lib/format.ts";

/** Permission level picker. Levels above the hub's maximum are shown but disabled. */
export function LevelSelect(props: {
  value: PermissionLevel;
  max: PermissionLevel;
  onChange(level: PermissionLevel): void;
  id?: string;
  /** False when this hub has no Steward, so Assisted behaves like Supervised. */
  stewardOn?: boolean;
}) {
  return (
    <select id={props.id} value={props.value} onChange={(e) => props.onChange(e.currentTarget.value as PermissionLevel)}>
      <For each={[...PERMISSION_LEVELS]}>
        {(level) => (
          <option value={level} disabled={levelRank(level) > levelRank(props.max)}>
            {LEVEL_LABELS[level]}
            {levelRank(level) > levelRank(props.max) ? " (above hub max)" : level === "assisted" && props.stewardOn === false ? " (Steward off on this hub)" : ""}
          </option>
        )}
      </For>
    </select>
  );
}
