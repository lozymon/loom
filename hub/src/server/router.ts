import type { Command, CommandResults } from "@loom/protocol";
import type { SessionManager } from "../core/sessionManager.ts";
import path from "node:path";
import type { PolicyStore } from "../policy/store.ts";
import type { BoardService } from "../board/boardService.ts";
import { assertNever, HubError } from "../errors.ts";
import type { Actor } from "../control/actor.ts";
import { authorize } from "../control/capabilities.ts";
import type { VoiceService } from "../voice/voiceService.ts";
import type { PushService } from "../push/pushService.ts";
import { levelRank } from "@loom/protocol";

function policyStore(manager: SessionManager): PolicyStore {
  if (!manager.policy) throw new HubError("invalid", "this hub has no policy store");
  return manager.policy;
}

function boards(ctx: RouteContext): BoardService {
  if (!ctx.boards) throw new HubError("invalid", "this hub has no boards");
  return ctx.boards;
}

function absolute(cwd: string): string {
  if (!path.isAbsolute(cwd)) throw new HubError("invalid", `not an absolute path: ${cwd}`);
  return cwd;
}

export interface RouteContext {
  manager: SessionManager;
  /** Who sent the command. Every command is checked against it (ADR-0007). */
  actor: Actor;
  /** Starts streaming events to this connection and returns the head the replay ended at. */
  subscribe(since: number, sessionIds: string[] | undefined): number;
  /** Starts streaming a terminal's output to this connection. */
  attachTerminal(sessionId: string): { offset: number; data: string; live: boolean };
  detachTerminal(sessionId: string): void;
  boards: BoardService | undefined;
  /** Sends this connection `board` frames for the board at `root`. */
  watchBoard(root: string): void;
  voice?: VoiceService | undefined;
  push?: PushService | undefined;
}

function push(ctx: RouteContext): PushService {
  if (!ctx.push) throw new HubError("invalid", "this hub has no push notifications");
  return ctx.push;
}

/**
 * One handler per command. The switch is exhaustive, so adding a Command to the protocol fails
 * typecheck here until it is handled.
 */
export async function route(cmd: Command, ctx: RouteContext): Promise<CommandResults[Command["cmd"]]> {
  const { manager, actor } = ctx;
  authorize(actor, cmd);
  const self = actor.kind === "session" ? actor.sessionId : undefined;
  const notSelf = (id: string, what: string) => {
    if (self !== undefined && id === self) throw new HubError("forbidden", `a session cannot ${what} itself`);
  };
  const byName = () => (self ? manager.get(self).name : "you");
  switch (cmd.cmd) {
    case "hub.whoami": {
      if (!self) return { kind: "human" as const };
      const s = manager.get(self);
      return { kind: "session" as const, sessionId: s.id, name: s.name, role: s.cockpit ? ("cockpit" as const) : ("session" as const), cwd: s.cwd, projectRoot: s.projectRoot };
    }
    case "session.wait":
      return manager.waitFor(cmd.sessionId, cmd.states, cmd.timeoutMs);
    case "notes.set":
      return manager.blackboard.setNote(absolute(cmd.cwd), cmd.key, cmd.value, byName());
    case "notes.get":
      return manager.blackboard.getNote(absolute(cmd.cwd), cmd.key);
    case "notes.list":
      return manager.blackboard.listNotes(absolute(cmd.cwd));
    case "notes.delete":
      return manager.blackboard.deleteNote(absolute(cmd.cwd), cmd.key);
    case "claims.claim":
      return manager.blackboard.claim(absolute(cmd.cwd), cmd.path, self ?? "human", byName(), cmd.note);
    case "claims.release":
      return manager.blackboard.release(absolute(cmd.cwd), cmd.path, self ?? "human", actor.kind === "human" || cmd.force === true);
    case "claims.list":
      return manager.blackboard.listClaims(absolute(cmd.cwd));
    case "hub.snapshot":
      return manager.snapshot();
    case "session.list":
      return manager.list();
    case "session.create": {
      if (self) {
        if (cmd.spec.cockpit) throw new HubError("forbidden", "only a person can start the Cockpit");
        const level = cmd.spec.level ?? manager.defaultLevel;
        if (level === "full" || levelRank(level) > levelRank(manager.maxLevel)) {
          throw new HubError("forbidden", `the Cockpit cannot start a session at level ${level}`);
        }
      }
      return manager.create(cmd.spec);
    }
    case "session.send": {
      if (!self) return manager.send(cmd.sessionId, cmd.text, cmd.from ?? "human");
      notSelf(cmd.sessionId, "message");
      const sender = manager.get(self);
      const label = sender.cockpit
        ? "[Message from the Loom Cockpit, which acts for the developer.]"
        : `[Message from ${sender.name}, another Loom session. It is not from the developer.]`;
      return manager.send(cmd.sessionId, `${label}\n${cmd.text}`, sender.cockpit ? "cockpit" : "session");
    }
    case "session.interrupt":
      notSelf(cmd.sessionId, "interrupt");
      return manager.interrupt(cmd.sessionId);
    case "session.stop":
      notSelf(cmd.sessionId, "stop");
      return manager.stop(cmd.sessionId);
    case "session.rename":
      notSelf(cmd.sessionId, "rename");
      return manager.rename(cmd.sessionId, cmd.name);
    case "session.archive":
      notSelf(cmd.sessionId, "archive");
      // Removing a worktree directory stays a person's call.
      return manager.archive(cmd.sessionId, self ? {} : { removeWorktree: cmd.removeWorktree, force: cmd.force });
    case "session.unarchive":
      return manager.unarchive(cmd.sessionId);
    case "hub.stats":
      return manager.stats();
    case "board.get": {
      const view = boards(ctx).view(absolute(cmd.cwd));
      ctx.watchBoard(view.root);
      return view;
    }
    case "board.add":
      return boards(ctx).add(absolute(cmd.cwd), cmd.card);
    case "board.update":
      return boards(ctx).update(absolute(cmd.cwd), cmd.cardId, cmd.card);
    case "board.move":
      return boards(ctx).move(absolute(cmd.cwd), cmd.cardId, cmd.status);
    case "board.remove":
      return boards(ctx).remove(absolute(cmd.cwd), cmd.cardId);
    case "board.dispatch":
      return boards(ctx).dispatch(absolute(cmd.cwd), cmd.cardId);
    case "board.run":
      return boards(ctx).run(absolute(cmd.cwd), cmd.cap);
    case "session.restart":
      notSelf(cmd.sessionId, "restart");
      return manager.restart(cmd.sessionId);
    case "session.open-terminal":
      return manager.openTerminal(cmd.sessionId);
    case "session.set-level":
      notSelf(cmd.sessionId, "change the level of");
      return manager.setLevel(cmd.sessionId, cmd.level, self ? "cockpit" : "human");
    case "session.read":
      return manager.read(cmd.sessionId, cmd.since ?? 0, cmd.limit ?? 1000);
    case "events.subscribe":
      return { head: ctx.subscribe(cmd.since ?? manager.head(), cmd.sessionIds) };
    case "approval.list":
      return manager.approvals();
    case "approval.decide": {
      if (!self) return manager.decide(cmd.approvalId, cmd.decision, "human");
      const request = manager.approvals().find((a) => a.id === cmd.approvalId);
      if (!request) throw new HubError("not-found", `no open approval ${cmd.approvalId}`);
      if (!manager.steward?.enabled) {
        throw new HubError("forbidden", "on this hub only a person may decide approvals");
      }
      if (request.sessionId === self) throw new HubError("forbidden", "the Cockpit cannot decide its own approvals");
      if (request.kind === "permission" && request.mustAsk) {
        throw new HubError("forbidden", `an ask rule (${request.askRule?.rule}) requires a person`);
      }
      if (!["allow", "deny", "answer", "reply"].includes(cmd.decision.type)) {
        throw new HubError("forbidden", `the Cockpit cannot use ${cmd.decision.type}`);
      }
      return manager.decide(cmd.approvalId, cmd.decision, "cockpit", "decided by the Cockpit");
    }
    case "approval.override":
      return manager.override(cmd.approvalId);
    case "policy.get":
      return policyStore(manager).view(absolute(cmd.cwd));
    case "policy.save":
      return policyStore(manager).save(cmd.scope, absolute(cmd.cwd), cmd.policy);
    case "policy.trust":
      return policyStore(manager).trust(absolute(cmd.cwd), cmd.allowHash);
    case "terminal.attach":
      return ctx.attachTerminal(cmd.sessionId);
    case "terminal.detach":
      return ctx.detachTerminal(cmd.sessionId);
    case "terminal.write":
      return manager.terminalWrite(cmd.sessionId, Buffer.from(cmd.data, "base64"));
    case "terminal.resize":
      return manager.terminalResize(cmd.sessionId, cmd.cols, cmd.rows);
    case "voice.transcribe":
      if (!ctx.voice) throw new HubError("invalid", "this hub has no speech recognition");
      return ctx.voice.transcribe(cmd.audio, cmd.language, cmd.prompt);
    case "voice.speak":
      if (!ctx.voice) throw new HubError("invalid", "this hub has no speech engine");
      return ctx.voice.speak(cmd.text, cmd.lang);
    case "session.diff":
      return manager.sessionDiff(cmd.sessionId, cmd.mode);
    case "session.revert":
      return manager.revertChange(cmd.sessionId, cmd.path, cmd.hunkId);
    case "history.search":
      return manager.searchHistory(cmd.query, cmd.sessionId, cmd.limit);
    case "push.key":
      return { publicKey: push(ctx).publicKey() };
    case "push.subscribe":
      return push(ctx).subscribe(cmd.subscription, cmd.label);
    case "push.unsubscribe":
      return push(ctx).unsubscribe(cmd.endpoint);
    case "push.devices":
      return push(ctx).devices();
    case "push.test":
      return push(ctx).send({ title: "Loom", body: "Notifications from this hub work.", tag: "loom-test", url: "/" }, cmd.endpoint);
    case "session.speak":
      if (self !== undefined && cmd.sessionId !== self) throw new HubError("forbidden", "a session can only speak as itself");
      return manager.speak(cmd.sessionId, cmd.text, cmd.lang);
    default:
      return assertNever(cmd);
  }
}
