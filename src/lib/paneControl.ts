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
  paneSpecById,
  resolvePaneByName,
  revealPaneByName,
  spawnPane,
  workspaceByName,
  workspaceByPaneName,
  type WorkspaceUI,
} from "../stores/workspace";
import { noteSet, noteGet, noteList, noteDel } from "../stores/blackboard";
import { noteAttention, clearAttention, setStatus, clearStatus } from "../stores/activity";
import {
  sessionStart,
  sessionEnd,
  taskBegin,
  taskUpdate,
  taskEnd,
  approvalRequest,
  approvalResolve,
} from "../stores/sessions";
import { detectAgent } from "./agents";
import type { AgentId, PaneId } from "../ipc/protocol";
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

    // ---- Shared blackboard (§2b) — per-workspace key/value board. Scope resolves to the caller
    // pane's workspace (or an explicit --workspace); `action` is echoed so the CLI knows how to
    // print. Opacity-safe: values are agent-pushed, never read from pane output. ----
    case "note.set": {
      const scope = noteScope(req);
      if ("error" in scope) return scope;
      const key = (req.key ?? "").trim();
      if (!key) return { ok: false, error: "note set needs a key" };
      noteSet(scope.ws.id, key, req.value ?? "", req.pane ?? "?");
      return { ok: true, data: { action: "set", key, workspace: scope.ws.name } };
    }

    case "note.get": {
      const scope = noteScope(req);
      if ("error" in scope) return scope;
      const key = (req.key ?? "").trim();
      const e = noteGet(scope.ws.id, key);
      if (!e) return { ok: false, error: `no note "${key}" on the "${scope.ws.name}" board` };
      return { ok: true, data: { action: "get", key, value: e.value, by: e.by, at: e.at } };
    }

    case "note.list": {
      const scope = noteScope(req);
      if ("error" in scope) return scope;
      return { ok: true, data: { action: "list", workspace: scope.ws.name, entries: noteList(scope.ws.id) } };
    }

    case "note.del": {
      const scope = noteScope(req);
      if ("error" in scope) return scope;
      const key = (req.key ?? "").trim();
      if (!noteDel(scope.ws.id, key)) return { ok: false, error: `no note "${key}" to delete` };
      return { ok: true, data: { action: "del", key, workspace: scope.ws.name } };
    }

    // ---- Agent lifecycle (ADR-0008) — feed the entity store, and bridge to the coarse floor
    // (attention/status) so existing UI keeps reflecting state until the fleet board lands. ----
    case "session.start": {
      const r = resolvePaneByName(req.target);
      if ("error" in r) return { ok: false, error: r.error };
      sessionStart(r.paneId, paneAgentId(r.paneId, req.agent), req.sessionId, req.cwd);
      clearStatus(r.paneId);
      return { ok: true, data: { name: req.target } };
    }

    case "session.end": {
      const r = resolvePaneByName(req.target);
      if ("error" in r) return { ok: false, error: r.error };
      sessionEnd(r.paneId, req.outcome ?? "done");
      clearStatus(r.paneId);
      return { ok: true, data: { name: req.target } };
    }

    case "task.begin": {
      const r = resolvePaneByName(req.target);
      if ("error" in r) return { ok: false, error: r.error };
      const title = (req.title ?? "").trim();
      taskBegin(r.paneId, paneAgentId(r.paneId), title);
      setStatus(r.paneId, floorLabel(title));
      return { ok: true, data: { name: req.target } };
    }

    case "task.update": {
      const r = resolvePaneByName(req.target);
      if ("error" in r) return { ok: false, error: r.error };
      taskUpdate(r.paneId, paneAgentId(r.paneId), req.files, req.note);
      return { ok: true, data: { name: req.target } };
    }

    case "task.end": {
      const r = resolvePaneByName(req.target);
      if ("error" in r) return { ok: false, error: r.error };
      taskEnd(r.paneId, req.outcome ?? "done");
      clearStatus(r.paneId);
      return { ok: true, data: { name: req.target } };
    }

    case "approval.request": {
      const r = resolvePaneByName(req.target);
      if ("error" in r) return { ok: false, error: r.error };
      const prompt = (req.prompt ?? "").trim();
      approvalRequest(r.paneId, paneAgentId(r.paneId), prompt, req.kind ?? "question");
      // A fresh raise fires the OS notification (mirrors the `attention` op).
      if (noteAttention(r.paneId)) void notifyAttention(req.target, prompt.slice(0, 80));
      return { ok: true, data: { name: req.target } };
    }

    case "approval.resolve": {
      const r = resolvePaneByName(req.target);
      if ("error" in r) return { ok: false, error: r.error };
      approvalResolve(r.paneId);
      clearAttention(r.paneId);
      return { ok: true, data: { name: req.target } };
    }

    default:
      return { ok: false, error: `unknown op "${(req as { op?: string }).op}"` };
  }
}

/** Resolve which workspace's blackboard a `loom note` op targets (§2b): an explicit `workspace`
 *  name wins, else the caller pane's workspace, else the active one. Returns an error response the
 *  case can hand straight back. */
function noteScope(req: { pane?: string; workspace?: string }): { ws: WorkspaceUI } | { ok: false; error: string } {
  if (req.workspace) {
    const ws = workspaceByName(req.workspace);
    return ws ? { ws } : { ok: false, error: `no workspace named "${req.workspace}"` };
  }
  if (req.pane) {
    const ws = workspaceByPaneName(req.pane);
    if (ws) return { ws };
  }
  const ws = activeWorkspace();
  return ws ? { ws } : { ok: false, error: "no active workspace" };
}

/** The Agent *kind* for a pane: the op's explicit hint (the hook knows it's Claude), else detected
 *  from the pane's launch command, else a generic fallback. Used only to label a Session. */
function paneAgentId(paneId: PaneId, hint?: string): AgentId {
  return hint?.trim() || detectAgent(paneSpecById(paneId)?.command)?.id || "agent";
}

/** A pane's coarse status label from a Task title — short enough for the title bar; "working" if empty. */
function floorLabel(title: string): string {
  const t = title.trim();
  if (!t) return "working";
  return t.length > 48 ? `${t.slice(0, 47)}…` : t;
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
