// Open the user's configured external code editor on a given folder — the action behind the
// per-pane "Open in editor" control. Builds an argv from the configured command and hands it to
// Rust's `open_editor`, which spawns it detached.
//
// The command is split on whitespace into program + args. A `{dir}` token in any argument is
// replaced with the folder; if no token is present, the folder is appended as the last argument.
// (No shell parsing — editors rarely need quoted args, and this keeps the launch predictable.)

import { invoke } from "@tauri-apps/api/core";
import { settings } from "../stores/settings";
import { activeWorkspace } from "../stores/workspace";
import { paneCwd } from "./paneRegistry";

/** Split `command` into program + args, substituting `{dir}` (or appending the folder). */
export function buildEditorArgv(
  command: string,
  dir: string,
): { program: string; args: string[] } | null {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const hasPlaceholder = tokens.some((t) => t.includes("{dir}"));
  const argv = tokens.map((t) => t.replace(/\{dir\}/g, dir));
  if (!hasPlaceholder && dir) argv.push(dir);
  return { program: argv[0], args: argv.slice(1) };
}

/** Launch the configured editor on `dir`. Surfaces a prompt if no editor is configured. */
export async function openEditorAt(dir: string): Promise<void> {
  const command = settings.editorCommand.trim();
  if (!command) {
    window.alert("No code editor configured.\n\nSet one in Settings → Terminal → External editor (e.g. code, subl, zed).");
    return;
  }
  const folder = dir.trim();
  const argv = buildEditorArgv(command, folder);
  if (!argv) return;
  try {
    await invoke("open_editor", { program: argv.program, args: argv.args, cwd: folder || null });
  } catch (e) {
    window.alert(`Couldn't open editor "${argv.program}":\n${e}`);
  }
}

/** Open the editor on the active workspace's focused pane folder — the global-keybinding path
 *  (App.tsx) used when focus isn't on a terminal. Resolves the focused pane's live cwd, falling
 *  back to the workspace folder, then the default folder. */
export async function openEditorForActivePane(): Promise<void> {
  const ws = activeWorkspace();
  let dir = "";
  const focused = ws?.focused ?? null;
  if (focused != null) dir = (await paneCwd(focused))?.trim() || "";
  if (!dir) dir = ws?.cwd?.trim() || settings.defaultCwd.trim();
  await openEditorAt(dir);
}
