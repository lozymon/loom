// Frontend half of the inter-pane control bus (ADR-0007). Rust relays each socket request to
// the webview as a `loom://pane-cmd` event carrying an opaque JSON line; we parse it here,
// do the routing (the part that must live in TS — names, the pane registry, layout mutation),
// and hand the answer back through `pane_cmd_reply`. All product logic stays on this side; Rust
// is just transport.

import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { Cmd, PANE_CMD_EVENT, type ControlEvent, type ControlRequest, type ControlResponse } from "../ipc/protocol";
import { countLive, readPane, writeToPanes } from "./paneRegistry";
import {
  activeWorkspace,
  broadcastTargets,
  listPanes,
  resolvePaneByName,
  revealPaneByName,
  spawnPane,
  workspaceByName,
} from "../stores/workspace";
import { noteAttention, clearAttention, setStatus } from "../stores/activity";
import { notifyAttention } from "./notify";
import { settings } from "../stores/settings";

/** Subscribe to relayed requests. Call once at startup; returns the unlisten fn. */
export async function initPaneControl(): Promise<() => void> {
  return listen<ControlEvent>(PANE_CMD_EVENT, async (event) => {
    const { reqId, request } = event.payload;
    let response: ControlResponse;
    try {
      response = await dispatch(JSON.parse(request) as ControlRequest);
    } catch (err) {
      response = { ok: false, error: `bad request: ${String(err)}` };
    }
    void invoke(Cmd.paneCmdReply, { reqId, response: JSON.stringify(response) });
  });
}

async function dispatch(req: ControlRequest): Promise<ControlResponse> {
  switch (req.op) {
    case "list":
      return {
        ok: true,
        data: listPanes().map((p) => ({
          name: p.name,
          workspace: p.workspace,
          focused: p.focused,
          live: countLive([p.paneId]) > 0,
        })),
      };

    case "send": {
      const r = resolvePaneByName(req.target);
      if ("error" in r) return { ok: false, error: r.error };
      // Default to pressing Enter (\r, matching the broadcast bar); --no-enter suppresses it.
      const text = (req.text ?? "") + (req.enter === false ? "" : "\r");
      const n = writeToPanes([r.paneId], text);
      if (n === 0) return { ok: false, error: `pane "${req.target}" is not live` };
      return { ok: true, data: { count: n } };
    }

    case "spawn": {
      const command = (req.command ?? "").trim();
      if (!command) return { ok: false, error: "spawn needs a command" };
      // Trust boundary (ADR-0007 / SECURITY_REVIEW Vuln 2): any process in any pane can request a
      // spawn, and unlike send/broadcast it runs an arbitrary command in a fresh pane with no
      // visible keystrokes — i.e. a silent-RCE primitive if an untrusted/poisoned agent holds the
      // bus. Require explicit user consent before honouring it (toggleable in Settings → Safety).
      if (settings.confirmExternalSpawn && !confirmExternalSpawn(command, req.cwd)) {
        return { ok: false, error: "spawn declined by user" };
      }
      const r = spawnPane({ title: req.name, command, cwd: req.cwd });
      if ("error" in r) return { ok: false, error: r.error };
      return { ok: true, data: { name: r.name } };
    }

    case "read": {
      const r = resolvePaneByName(req.target);
      if ("error" in r) return { ok: false, error: r.error };
      const lines = Math.max(1, Math.min(req.lines ?? 50, 2000));
      const text = readPane(r.paneId, lines);
      if (text === null) return { ok: false, error: `pane "${req.target}" is not available` };
      return { ok: true, data: { text } };
    }

    case "broadcast": {
      const ws = req.workspace ? workspaceByName(req.workspace) : activeWorkspace();
      if (!ws) return { ok: false, error: `no workspace named "${req.workspace}"` };
      const text = (req.text ?? "") + (req.enter === false ? "" : "\r");
      const n = writeToPanes(broadcastTargets(ws), text);
      return { ok: true, data: { count: n } };
    }

    case "focus": {
      const r = revealPaneByName(req.target);
      if ("error" in r) return { ok: false, error: r.error };
      return { ok: true, data: { name: r.name } };
    }

    case "attention": {
      const r = resolvePaneByName(req.target);
      if ("error" in r) return { ok: false, error: r.error };
      if (req.clear) clearAttention(r.paneId);
      // Only a fresh raise fires the OS notification (an agent flagging itself while you're away).
      else if (noteAttention(r.paneId)) void notifyAttention(req.target, "");
      return { ok: true, data: { name: req.target, cleared: req.clear === true } };
    }

    case "status": {
      const r = resolvePaneByName(req.target);
      if ("error" in r) return { ok: false, error: r.error };
      const text = (req.text ?? "").trim();
      setStatus(r.paneId, text);
      return { ok: true, data: { name: req.target, text, cleared: text === "" } };
    }

    default:
      return { ok: false, error: `unknown op "${(req as { op?: string }).op}"` };
  }
}

/** Block on a native confirm before letting an external pane spawn a command-running pane. Uses
 *  `window.confirm` (as the close-confirm path does) — synchronous, so dispatch's reply waits on
 *  the user's choice and the requesting `loom spawn` only returns once they've decided. */
function confirmExternalSpawn(command: string, cwd?: string): boolean {
  const where = cwd ? `\nin: ${cwd}` : "";
  return window.confirm(
    `Another pane wants to open a new terminal and run:\n\n${command}${where}\n\nAllow it?`,
  );
}
