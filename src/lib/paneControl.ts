// Frontend half of the inter-pane control bus (ADR-0007). Rust relays each socket request to
// the webview as a `loom://pane-cmd` event carrying an opaque JSON line; we parse it here,
// do the routing (the part that must live in TS — names, the pane registry, layout mutation),
// and hand the answer back through `pane_cmd_reply`. All product logic stays on this side; Rust
// is just transport.

import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import {
  Cmd,
  PANE_CMD_EVENT,
  PANE_CMD_ABORT_EVENT,
  type ControlEvent,
  type PaneCmdAbortEvent,
  type ControlRequest,
  type ControlResponse,
} from "../ipc/protocol";
import { countLive, readPane, writeToPanes, paneCwd } from "./paneRegistry";
import { isDestructiveCommand, sharedFolders } from "./guardrails";
import {
  activeWorkspace,
  broadcastTargets,
  listGatedPanes,
  listPanes,
  paneSpecById,
  resolvePaneByName,
  resolvePanesByRole,
  revealPane,
  revealPaneByName,
  setPaneRole,
  spawnPane,
  workspaceByName,
  workspaceByPaneName,
  type WorkspaceUI,
} from "../stores/workspace";
import { gatePane, isGated, releaseGate } from "../stores/inputHolds";
import { noteSet, noteGet, noteList, noteDel, ensureNotesLoaded } from "../stores/blackboard";
import { claimFile, holdClaim, releaseFile, listClaims } from "../stores/claims";
import { addCard, cards, setCardStatus, ensureBoardLoaded, setDrain, drainState } from "../stores/board";
import { createAsk, awaitAsk, replyAsk, cancelAsk } from "./askRegistry";
import {
  noteAttention,
  clearAttention,
  setStatus,
  clearStatus,
  paneStatus,
  paneAttention,
} from "../stores/activity";
import { recordAudit } from "../stores/audit";
import {
  sessionStart,
  sessionEnd,
  taskBegin,
  taskUpdate,
  taskEnd,
  approvalRequest,
  approvalResolve,
  paneSessionState,
} from "../stores/sessions";
import { detectAgent } from "./agents";
import type { AgentId, Origin, PaneId } from "../ipc/protocol";
import { notifyAttention } from "./notify";
import { settings } from "../stores/settings";
import { requestClearance, withdrawClearance } from "../stores/clearances";
import { remoteDisposition } from "./remotePolicy";
import { isRemoteTrusted } from "../stores/remoteTrust";

/** For a remote Clearance card: the pane/target the command names, if any. */
function remoteTargetOf(req: ControlRequest): string | undefined {
  const r = req as unknown as Record<string, unknown>;
  return typeof r.target === "string" ? r.target : undefined;
}

/** For a remote Clearance card: the text under review (the send payload; read has none). */
function remoteDetailOf(req: ControlRequest): string {
  const r = req as unknown as Record<string, unknown>;
  return typeof r.text === "string" ? r.text : "";
}

// Which Clearance (if any) a live request is currently parked on, keyed by the request's `reqId`.
// Requests run concurrently (each event is its own async dispatch), so a global signal can't tell
// them apart — an abort must target the right one. A request holds at most one *active* Clearance
// at a time (a broadcast can park twice, but sequentially), so last-write-wins is correct.
const parkedByReq = new Map<number, number>();

/** Subscribe to relayed requests. Call once at startup; returns a single unlisten fn covering both
 *  the request stream and the abort stream (ADR-0012 rule 3.4). */
export async function initPaneControl(): Promise<() => void> {
  // Rust signals that a parked caller left before we replied — withdraw its Clearance so an Approve
  // can't fire a command nobody is waiting for (the zombie-spawn this whole change kills).
  const unlistenAbort = await listen<PaneCmdAbortEvent>(PANE_CMD_ABORT_EVENT, (event) => {
    const clearanceId = parkedByReq.get(event.payload.reqId);
    if (clearanceId !== undefined) withdrawClearance(clearanceId);
  });

  const unlistenCmd = await listen<ControlEvent>(PANE_CMD_EVENT, async (event) => {
    const { reqId, request } = event.payload;
    // Origin is Rust-authored on the envelope (rule 3.1); never trust an `origin` in the body. A
    // legacy/absent field is treated as local.
    const origin: Origin = event.payload.origin ?? "local";
    let parsed: ControlRequest | null = null;
    let response: ControlResponse;
    try {
      parsed = JSON.parse(request) as ControlRequest;
      response = await dispatch(parsed, origin, {
        onPark: (clearanceId) => {
          parkedByReq.set(reqId, clearanceId);
          // Tell Rust to stop counting down its reply deadline — a human may take minutes.
          void invoke(Cmd.paneCmdParked, { reqId });
        },
      });
    } catch (err) {
      response = { ok: false, error: `bad request: ${String(err)}` };
    } finally {
      parkedByReq.delete(reqId);
    }
    // Record every relayed command on the audit timeline (ORCHESTRATION-IDEAS §3). Opacity-safe:
    // this logs the command, never pane output. A malformed request (no `parsed`) is skipped.
    if (parsed) recordAudit(parsed, response.ok, response.ok ? undefined : response.error, origin);
    void invoke(Cmd.paneCmdReply, { reqId, response: JSON.stringify(response) });
  });

  return () => {
    unlistenAbort();
    unlistenCmd();
  };
}

/** Prefix that turns a bus target into a role lookup: `role:reviewer` → every pane tagged reviewer.
 *  A role is a *group* target (several panes can share it), so a role-targeted `send` fans out. */
const ROLE_PREFIX = "role:";

/** Resolve a bus `target` to pane ids — a `role:<name>` target to every pane with that role, a plain
 *  name to the one pane it names (ambiguity or a miss is an error the CLI surfaces). */
function resolveTargets(target: string): { paneIds: PaneId[] } | { error: string } {
  if (target.toLowerCase().startsWith(ROLE_PREFIX)) {
    const role = target.slice(ROLE_PREFIX.length);
    const ids = resolvePanesByRole(role);
    if (ids.length === 0) return { error: `no pane with role "${role.trim()}"` };
    return { paneIds: ids };
  }
  const r = resolvePaneByName(target);
  return "error" in r ? r : { paneIds: [r.paneId] };
}

/** Per-request context threaded into the guardrails. `onPark` is called with a Clearance's id when
 *  one is created, so the bus layer can lift the reply deadline (`pane_cmd_parked`) and map the
 *  request's `reqId` to the Clearance for a later abort. Absent (e.g. in a direct unit-test call)
 *  means the guardrails still work; they just don't signal Rust. */
export interface DispatchCtx {
  onPark?: (clearanceId: number) => void;
}

async function dispatch(
  req: ControlRequest,
  origin: Origin = "local",
  ctx: DispatchCtx = {},
): Promise<ControlResponse> {
  // Remote-origin commands are governed by the deny-by-default policy table (ADR-0012 rule 3), NOT
  // by the local guardrails. Local-origin (unix socket / pane / CLI) keeps ADR-0007's full authority.
  if (origin !== "local") {
    const disp = remoteDisposition(req.op);
    if (disp === "deny") {
      return { ok: false, error: `"${req.op}" is not permitted from a device` };
    }
    if (disp === "approve" && !isRemoteTrusted(origin)) {
      // Flow A Confirmation (rule 3.2): park a Clearance on the operator before executing. A
      // Confirmation stops typos, not a thief — its real security is pairing + this table + audit.
      // A *trusted* device (stores/remoteTrust — the operator's "drive it while I'm away" opt-in)
      // skips this one-time; it still passes the deny-by-default table above, and is still audited.
      const outcome = await requestClearance(
        {
          kind: "remote-command",
          summary: `${origin} wants to run "${req.op}"${remoteTargetOf(req) ? ` on ${remoteTargetOf(req)}` : ""}:`,
          detail: remoteDetailOf(req),
        },
        ctx.onPark,
      );
      if (outcome !== "approved") {
        return { ok: false, error: `"${req.op}" from ${origin} was ${outcome}` };
      }
    }
  }
  switch (req.op) {
    case "list":
      // Enrich the layout listing with the agent-pushed signals a remote fleet view needs (Plan 02
      // P0c): `status`/`attention` from the activity store and the ADR-0008 Session `state`. All are
      // *pushed* signals, never parsed from output (ADR-0001/0008) — opacity-safe. `FleetPanel` reads
      // these from the stores in-process; the bus `list` is the first consumer that needs them over
      // the wire, and it improves `loom list` locally too. Absent fields are omitted, not null.
      return {
        ok: true,
        data: listPanes().map((p) => ({
          name: p.name,
          workspace: p.workspace,
          focused: p.focused,
          live: countLive([p.paneId]) > 0,
          role: p.role,
          gated: p.gated,
          status: paneStatus(p.paneId) || undefined,
          attention: paneAttention(p.paneId) || undefined,
          sessionState: paneSessionState(p.paneId),
        })),
      };

    case "send": {
      const r = resolveTargets(req.target);
      if ("error" in r) return { ok: false, error: r.error };
      // Per-pane input gate (§4a): a gated target needs a human OK before input lands.
      const gate = await applyInputGates(r.paneIds, req.text ?? "", ctx);
      if (gate.deliver.length === 0) {
        return { ok: false, error: `"${req.target}" is gated — delivery declined by operator` };
      }
      // Default to pressing Enter (\r, matching the broadcast bar); --no-enter suppresses it.
      const text = (req.text ?? "") + (req.enter === false ? "" : "\r");
      const n = writeToPanes(gate.deliver, text);
      if (n === 0) return { ok: false, error: `target "${req.target}" has no live pane` };
      return { ok: true, data: { count: n, skipped: gate.skipped || undefined } };
    }

    case "spawn": {
      const command = (req.command ?? "").trim();
      if (!command) return { ok: false, error: "spawn needs a command" };
      // Trust boundary (ADR-0007 / SECURITY_REVIEW Vuln 2): any process in any pane can request a
      // spawn, and unlike send/broadcast it runs an arbitrary command in a fresh pane with no
      // visible keystrokes — i.e. a silent-RCE primitive if an untrusted/poisoned agent holds the
      // bus. Require explicit user consent before honouring it (toggleable in Settings → Safety).
      if (settings.confirmExternalSpawn && !(await clearExternalSpawn(command, ctx, req.cwd))) {
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
      const raw = req.text ?? "";
      const ids = broadcastTargets(ws);
      // Dry-run (§4a): report which panes it *would* reach — name/live/gated — without sending.
      if (req.dryRun) {
        const targets = ids.map((id) => ({
          name: paneSpecById(id)?.title ?? `Pane ${id}`,
          live: countLive([id]) > 0,
          gated: isGated(id),
        }));
        return { ok: true, data: { dryRun: true, workspace: ws.name, text: raw, targets } };
      }
      // Git-aware guardrail (§4b): a destructive command fanning out to several panes runs N× on
      // (or races) whatever they share. Warn the operator first — louder when panes share a folder.
      if (settings.confirmDestructiveBroadcast && ids.length >= 2 && isDestructiveCommand(raw)) {
        const cwds = await Promise.all(ids.map((id) => paneCwd(id).catch(() => null)));
        if (!(await clearDestructiveBroadcast(raw, ids, sharedFolders(cwds), ctx))) {
          return { ok: false, error: "destructive broadcast declined by user" };
        }
      }
      // Per-pane input gates (§4a): any gated pane in the fan-out needs a human OK; open panes
      // still receive the broadcast regardless.
      const gate = await applyInputGates(ids, raw, ctx);
      const text = raw + (req.enter === false ? "" : "\r");
      const n = writeToPanes(gate.deliver, text);
      return { ok: true, data: { count: n, skipped: gate.skipped || undefined } };
    }

    case "gate.set": {
      const r = resolvePaneByName(req.target);
      if ("error" in r) return { ok: false, error: r.error };
      if (req.on) {
        gatePane(r.paneId, req.target, req.reason);
        return { ok: true, data: { name: req.target, gated: true } };
      }
      const dropped = releaseGate(r.paneId);
      return { ok: true, data: { name: req.target, gated: false, cleared: dropped } };
    }

    case "gate.list":
      return { ok: true, data: { entries: listGatedPanes() } };

    case "focus": {
      // A role target reveals its first matching pane (a role can be held by several).
      if (req.target.toLowerCase().startsWith(ROLE_PREFIX)) {
        const role = req.target.slice(ROLE_PREFIX.length);
        const ids = resolvePanesByRole(role);
        if (ids.length === 0) return { ok: false, error: `no pane with role "${role.trim()}"` };
        revealPane(ids[0]);
        return { ok: true, data: { name: req.target } };
      }
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

    case "role.set": {
      const r = resolvePaneByName(req.target);
      if ("error" in r) return { ok: false, error: r.error };
      const role = (req.role ?? "").trim();
      setPaneRole(r.paneId, role);
      return { ok: true, data: { name: req.target, role, cleared: role === "" } };
    }

    // ---- Shared blackboard (§2b) — per-workspace key/value board. Scope resolves to the caller
    // pane's workspace (or an explicit --workspace); `action` is echoed so the CLI knows how to
    // print. Opacity-safe: values are agent-pushed, never read from pane output. ----
    case "note.set": {
      const scope = noteScope(req);
      if ("error" in scope) return scope;
      const key = (req.key ?? "").trim();
      if (!key) return { ok: false, error: "note set needs a key" };
      await ensureNotesLoaded(scope.ws.cwd);
      noteSet(scope.ws.cwd, key, req.value ?? "", req.pane ?? "?");
      return { ok: true, data: { action: "set", key, workspace: scope.ws.name } };
    }

    case "note.get": {
      const scope = noteScope(req);
      if ("error" in scope) return scope;
      const key = (req.key ?? "").trim();
      await ensureNotesLoaded(scope.ws.cwd);
      const e = noteGet(scope.ws.cwd, key);
      if (!e) return { ok: false, error: `no note "${key}" on the "${scope.ws.name}" board` };
      return { ok: true, data: { action: "get", key, value: e.value, by: e.by, at: e.at } };
    }

    case "note.list": {
      const scope = noteScope(req);
      if ("error" in scope) return scope;
      await ensureNotesLoaded(scope.ws.cwd);
      return { ok: true, data: { action: "list", workspace: scope.ws.name, entries: noteList(scope.ws.cwd) } };
    }

    case "note.del": {
      const scope = noteScope(req);
      if ("error" in scope) return scope;
      const key = (req.key ?? "").trim();
      await ensureNotesLoaded(scope.ws.cwd);
      if (!noteDel(scope.ws.cwd, key)) return { ok: false, error: `no note "${key}" to delete` };
      return { ok: true, data: { action: "del", key, workspace: scope.ws.name } };
    }

    // ---- File claims (§2c) — advisory locks, a sibling of the blackboard. claim/release need a
    // holder identity (the caller pane); a lost claim is an ok:false so `loom claim x || …` scripts
    // cleanly. Opacity-safe: cooperative metadata, nothing read from pane output. ----
    case "claim": {
      const ctx = claimContext(req);
      if ("error" in ctx) return ctx;
      const path = (req.path ?? "").trim();
      if (!path) return { ok: false, error: "claim needs a path" };
      const r = claimFile(ctx.ws.id, path, ctx.by);
      if (!r.ok) {
        return "held" in r
          ? { ok: false, error: `"${path}" is gated (held) — waiting on release` }
          : { ok: false, error: `"${path}" is held by ${r.by}` };
      }
      return { ok: true, data: { action: "claim", path, by: ctx.by, fresh: r.fresh } };
    }

    case "hold": {
      const ctx = claimContext(req);
      if ("error" in ctx) return ctx;
      const path = (req.path ?? "").trim();
      if (!path) return { ok: false, error: "hold needs a path" };
      const r = holdClaim(ctx.ws.id, path, ctx.by);
      return { ok: true, data: { action: "hold", path, by: ctx.by, fresh: r.fresh } };
    }

    case "release": {
      const ctx = claimContext(req);
      if ("error" in ctx) return ctx;
      const path = (req.path ?? "").trim();
      if (!path) return { ok: false, error: "release needs a path" };
      const r = releaseFile(ctx.ws.id, path, ctx.by, req.force === true);
      if (!r.ok) {
        return r.reason === "unheld"
          ? { ok: false, error: `no claim on "${path}"` }
          : { ok: false, error: `"${path}" is held by ${r.by} — use --force to override` };
      }
      return { ok: true, data: { action: "release", path } };
    }

    case "claims": {
      const scope = noteScope(req); // list needs only the workspace, no holder
      if ("error" in scope) return scope;
      return { ok: true, data: { action: "claims", workspace: scope.ws.name, entries: listClaims(scope.ws.id) } };
    }

    // ---- Task board (§1) — agents create/list/move cards in the project's .loom board. Load it
    // first so an agent's write can't clobber existing cards a panel never opened. ----
    case "card.add": {
      const scope = noteScope(req);
      if ("error" in scope) return scope;
      const title = (req.title ?? "").trim();
      if (!title) return { ok: false, error: "card add needs a title" };
      await ensureBoardLoaded(scope.ws.cwd);
      const id = addCard(scope.ws.cwd, { title, prompt: req.prompt, command: req.command });
      return { ok: true, data: { id, title, workspace: scope.ws.name } };
    }
    case "card.list": {
      const scope = noteScope(req);
      if ("error" in scope) return scope;
      await ensureBoardLoaded(scope.ws.cwd);
      const list = cards(scope.ws.cwd).map((c) => ({ id: c.id, title: c.title, status: c.status }));
      return { ok: true, data: { workspace: scope.ws.name, cards: list } };
    }
    case "card.move": {
      const scope = noteScope(req);
      if ("error" in scope) return scope;
      await ensureBoardLoaded(scope.ws.cwd);
      const ok = setCardStatus(scope.ws.cwd, req.id, req.status);
      if (!ok) return { ok: false, error: `no card "${req.id}"` };
      return { ok: true, data: { id: req.id, status: req.status } };
    }
    case "card.drain": {
      const scope = noteScope(req);
      if ("error" in scope) return scope;
      await ensureBoardLoaded(scope.ws.cwd);
      setDrain(scope.ws.cwd, req.on, req.cap);
      const cfg = drainState(scope.ws.cwd);
      return { ok: true, data: { workspace: scope.ws.name, draining: cfg.on, cap: cfg.cap } };
    }

    // ---- Ask/reply RPC (§2a) — `ask` injects the question + reply instructions into the callee
    // and returns a correlation id; the `loom ask` CLI long-polls `ask.await`; `reply` delivers.
    // Opacity-safe: the answer is agent-pushed via `reply`, never read from output. ----
    case "ask": {
      const r = resolvePaneByName(req.target);
      if ("error" in r) return { ok: false, error: r.error };
      const question = (req.question ?? "").trim();
      if (!question) return { ok: false, error: "ask needs a question" };
      const from = req.from?.trim() || "someone";
      const id = createAsk(req.target, from, question, req.timeoutMs ?? 300_000);
      // Type the question into the callee with a single-line instruction telling its agent how to
      // answer. Enter submits it (like `send`), so an agent pane receives it as a prompt.
      const line = `[loom ask #${id} from ${from} — reply with: loom reply ${id} "<answer>"] ${question}`;
      const n = writeToPanes([r.paneId], line + "\r");
      if (n === 0) {
        cancelAsk(id); // retire the just-created ask; the pane isn't live
        return { ok: false, error: `pane "${req.target}" is not live` };
      }
      return { ok: true, data: { id } };
    }

    case "ask.await": {
      const result = await awaitAsk(req.id, Math.min(req.waitMs ?? 8000, 9000));
      return { ok: true, data: result };
    }

    case "reply": {
      const answer = (req.answer ?? "").trim();
      const from = req.from?.trim() || undefined;
      if (!replyAsk(req.id, answer, from)) {
        return { ok: false, error: `no open ask #${req.id} (it expired or was already answered)` };
      }
      return { ok: true, data: { id: req.id } };
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

/** Resolve the workspace *and* the holder pane a claim/release acts as (§2c). Unlike a note, a
 *  claim needs an owner identity, so the caller pane (`$LOOM_PANE`) is required — no active-pane
 *  guess. Workspace scope is the pane's, or an explicit `--workspace`. */
function claimContext(
  req: { path?: string; pane?: string; workspace?: string },
): { ws: WorkspaceUI; by: string } | { ok: false; error: string } {
  const by = req.pane?.trim();
  if (!by) {
    return { ok: false, error: "claim needs a calling pane — run it from inside a pane (set $LOOM_PANE)" };
  }
  if (req.workspace) {
    const ws = workspaceByName(req.workspace);
    return ws ? { ws, by } : { ok: false, error: `no workspace named "${req.workspace}"` };
  }
  const ws = workspaceByPaneName(by) ?? activeWorkspace();
  return ws ? { ws, by } : { ok: false, error: "no active workspace" };
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

/** Apply per-pane input gates (§4a) to a bus delivery. Open panes always pass; gated panes pass
 *  only if the operator OKs them (one confirm for the whole set). With the honor-holds setting off,
 *  gates are ignored entirely. Returns the ids to actually write to + how many gated panes were
 *  dropped (skipped) on a decline. */
async function applyInputGates(
  ids: PaneId[],
  text: string,
  ctx: DispatchCtx,
): Promise<{ deliver: PaneId[]; skipped: number }> {
  if (!settings.honorInputHolds) return { deliver: ids, skipped: 0 };
  const gated = ids.filter((id) => isGated(id));
  if (gated.length === 0) return { deliver: ids, skipped: 0 };
  const names = gated.map((id) => paneSpecById(id)?.title ?? `Pane ${id}`);
  if (await clearHeldPaneInput(names, gated, text, ctx)) return { deliver: ids, skipped: 0 };
  return { deliver: ids.filter((id) => !isGated(id)), skipped: gated.length };
}

// ---- Guardrails (ADR-0012 rule 3.4) -------------------------------------------------------------
// These three park the command as a Clearance and await a decision, rather than calling
// `window.confirm`. The old `confirm` was synchronous: it blocked the webview thread, so an agent
// tripping a guardrail on an unattended laptop froze every Pane's rendering — and control.rs gave up
// on the caller at REPLY_TIMEOUT (10s) regardless, so a later click ran a command nobody awaited.
// Each returns true only on an explicit `approved`; `denied`/`withdrawn`/`expired` all decline.
//
// None of them can name the caller: the bus attaches no caller identity (ADR-0007), which is why
// the wording is "Another pane…" — see the note on `Clearance` in stores/clearances.ts.

/** Clear an external pane's request to spawn a command-running pane (SECURITY_REVIEW Vuln 2). */
async function clearExternalSpawn(command: string, ctx: DispatchCtx, cwd?: string): Promise<boolean> {
  const where = cwd ? ` in ${cwd}` : "";
  const outcome = await requestClearance(
    {
      kind: "spawn",
      summary: `Another pane wants to open a new terminal${where} and run:`,
      detail: command,
    },
    ctx.onPark,
  );
  return outcome === "approved";
}

/** Clear bus input reaching a gated pane (§4a). Names the gated pane(s) and shows what would be
 *  typed — the operator OK the whole standing-hold enforces. */
async function clearHeldPaneInput(
  names: string[],
  gated: PaneId[],
  text: string,
  ctx: DispatchCtx,
): Promise<boolean> {
  const which =
    names.length === 1 ? `gated pane "${names[0]}"` : `${names.length} gated panes: ${names.join(", ")}`;
  const outcome = await requestClearance(
    {
      kind: "gated-input",
      summary: `Bus input is held for ${which} (input gate). Let it through?`,
      detail: text.trim() ? text : "",
      targets: gated,
    },
    ctx.onPark,
  );
  return outcome === "approved";
}

/** Clear a destructive command fanning out to many panes (§4b). Names the shared folder(s) when
 *  panes overlap — that's the case that runs the command repeatedly on one worktree. */
async function clearDestructiveBroadcast(
  command: string,
  ids: PaneId[],
  shared: string[],
  ctx: DispatchCtx,
): Promise<boolean> {
  const note = shared.length
    ? `⚠ ${shared.length === 1 ? "These panes share the folder" : "Some panes share folders"}: ${shared.join(", ")} — the command would run on the same worktree more than once.`
    : undefined;
  const outcome = await requestClearance(
    {
      kind: "destructive-broadcast",
      summary: `A pane wants to broadcast a destructive command to all ${ids.length} live panes. Run it in every pane?`,
      detail: command,
      note,
      targets: ids,
    },
    ctx.onPark,
  );
  return outcome === "approved";
}
