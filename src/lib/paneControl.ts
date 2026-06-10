// Frontend half of the inter-pane control bus (ADR-0007). Rust relays each socket request to
// the webview as a `termhaus://pane-cmd` event carrying an opaque JSON line; we parse it here,
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
import { noteAttention, clearAttention } from "../stores/activity";

/** Subscribe to relayed requests. Call once at startup; returns the unlisten fn. */
export async function initPaneControl(): Promise<() => void> {
  return listen<ControlEvent>(PANE_CMD_EVENT, (event) => {
    const { reqId, request } = event.payload;
    let response: ControlResponse;
    try {
      response = dispatch(JSON.parse(request) as ControlRequest);
    } catch (err) {
      response = { ok: false, error: `bad request: ${String(err)}` };
    }
    void invoke(Cmd.paneCmdReply, { reqId, response: JSON.stringify(response) });
  });
}

function dispatch(req: ControlRequest): ControlResponse {
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
      else noteAttention(r.paneId);
      return { ok: true, data: { name: req.target, cleared: req.clear === true } };
    }

    default:
      return { ok: false, error: `unknown op "${(req as { op?: string }).op}"` };
  }
}
