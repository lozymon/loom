import {
  applyEvent,
  type ApprovalDecision,
  type ApprovalRequest,
  checkLevelChange,
  clampLevel,
  createProjection,
  type HistoryHit,
  type SessionDiff,
  type HubEvent,
  type LevelActor,
  levelRank,
  type PermissionLevel,
  type Projection,
  type Resolver,
  type SessionEvent,
  type SessionId,
  SessionSpec,
  type SessionSummary,
  type SpokenLanguage,
  type UserMessageSource,
} from "@loom/protocol";
import { randomUUID } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { HubError } from "../errors.ts";
import { changeSummary, readDiff, revertChange } from "../git/diff.ts";
import { Heuristics } from "../heuristics/heuristics.ts";
import type { LoadedManifest } from "../heuristics/manifest.ts";
import { git } from "../git/git.ts";
import type { EventLog } from "../log/eventLog.ts";
import type { PolicyStore } from "../policy/store.ts";
import { projectRoot } from "../git/project.ts";
import { createWorktree, hasUncommittedChanges, removeWorktree } from "../git/worktrees.ts";
import type { AdapterFactory, AdapterHost, NewApproval, SessionAdapter } from "./adapter.ts";
import { ApprovalBroker } from "./broker.ts";
import { allocName } from "./names.ts";
import { TerminalBuffer, type TerminalListener } from "./terminalBuffer.ts";
import type { Steward } from "../steward/steward.ts";
import { SessionTokens } from "../control/tokens.ts";
import { Blackboard } from "../control/blackboard.ts";
import type { LoomIntegration } from "./adapter.ts";
import { buildReviewInput, diffStat } from "../steward/context.ts";

export interface SessionManagerOptions {
  log: EventLog;
  defaultLevel: PermissionLevel;
  maxLevel: PermissionLevel;
  adapters: Partial<Record<SessionSpec["adapter"], AdapterFactory>>;
  /** Rules and timeouts (ADR-0006 stage 1). Without it every approval goes to a person. */
  policy?: PolicyStore;
  /** Hub data directory; worktrees are created under it. Without it worktree sessions are refused. */
  dataDir?: string;
  /** Model review of approvals for Assisted sessions (ADR-0006 stage 2). */
  steward?: Steward;
  /** The board card a session works on, for Steward context. */
  cardFor?: (session: SessionSummary) => { title: string; prompt: string } | undefined;
  /** Loom tools and environment for a launch, given its session token (M6). */
  integration?: (session: SessionSummary, token: string) => LoomIntegration | undefined;
  /** Where the Cockpit runs. */
  cockpitDir?: string;
  now?: () => number;
  newId?: () => string;
  isDirectory?: (p: string) => boolean;
  /** Enabled screen manifests for terminal CLIs without hooks (ADR-0011, M12). */
  manifests?: readonly LoadedManifest[];
  /** Milliseconds between heuristic evaluations. */
  heuristicTickMs?: number;
}

export type HubListener = (event: HubEvent) => void;

interface LiveEntry {
  adapter: SessionAdapter;
  /** Cleared when this adapter instance is retired, so its late events are dropped. */
  current: boolean;
  /** Whether the adapter published a state while starting, so the manager does not override it. */
  statedDuringStart: boolean;
}

const RESTART_REASON = "The hub restarted before this was decided.";

/** Adapter kinds whose sessions end when their process exits, rather than pausing (ADR-0004). */
const PROCESS_ADAPTERS: ReadonlySet<SessionSpec["adapter"]> = new Set(["pty"]);

/**
 * Owns sessions on this hub: creates them, keeps their engines running, routes user input and
 * approvals, and writes everything to the event log (ADR-0001, ADR-0003).
 */
export class SessionManager {
  readonly projection: Projection = createProjection();
  readonly maxLevel: PermissionLevel;
  readonly defaultLevel: PermissionLevel;
  readonly policy: PolicyStore | undefined;

  #log: EventLog;
  /** Last recorded `files.changed` per session, to record only differences. */
  #lastChanges = new Map<SessionId, string>();
  readonly heuristics: Heuristics;
  #terminalSizes = new Map<SessionId, { cols: number; rows: number }>();
  #adapters: SessionManagerOptions["adapters"];
  #now: () => number;
  #newId: () => string;
  #isDirectory: (p: string) => boolean;
  #specs = new Map<SessionId, SessionSpec>();
  #live = new Map<SessionId, LiveEntry>();
  #starting = new Map<SessionId, Promise<LiveEntry>>();
  #blockers = new Map<SessionId, number>();
  #listeners = new Set<HubListener>();
  #terminals = new Map<SessionId, TerminalBuffer>();
  #dataDir: string | undefined;
  #steward: Steward | undefined;
  #cardFor: SessionManagerOptions["cardFor"];
  /** Approvals the Steward allowed, by id, so a person can override them. */
  #stewardAllowed = new Map<string, { sessionId: SessionId; summary: string }>();
  #requestSummaries = new Map<string, string>();
  #overridden = new Set<string>();
  #integration: SessionManagerOptions["integration"];
  #cockpitDir: string | undefined;
  readonly tokens = new SessionTokens();
  readonly blackboard = new Blackboard();
  #lastCost = new Map<SessionId, number>();
  #costByDay = new Map<string, number>();
  #broker: ApprovalBroker;

  constructor(opts: SessionManagerOptions) {
    this.#log = opts.log;
    this.heuristics = new Heuristics({
      manifests: opts.manifests ?? [],
      ...(opts.heuristicTickMs ? { tickMs: opts.heuristicTickMs } : {}),
      summary: (id) => this.projection.sessions.get(id),
      emit: (id, event) => {
        if (this.#live.has(id)) this.#append(id, event);
      },
    });
    this.#adapters = opts.adapters;
    this.policy = opts.policy;
    this.#dataDir = opts.dataDir;
    this.#steward = opts.steward;
    this.#cardFor = opts.cardFor;
    this.#integration = opts.integration;
    this.#cockpitDir = opts.cockpitDir;
    this.maxLevel = opts.maxLevel;
    this.defaultLevel = clampLevel(opts.defaultLevel, opts.maxLevel);
    this.#now = opts.now ?? Date.now;
    this.#newId = opts.newId ?? randomUUID;
    this.#isDirectory = opts.isDirectory ?? isDirectory;
    this.#broker = new ApprovalBroker({
      emit: (sessionId, event) => this.#append(sessionId, event),
      now: this.#now,
      newId: this.#newId,
    });
  }

  /**
   * Rebuilds state from the log and settles anything the previous hub process left open: no
   * engine survives a hub restart, so running sessions become idle and open approvals are
   * cancelled.
   */
  init(): void {
    this.#log.forEach((e) => {
      applyEvent(this.projection, e);
      this.#countCost(e);
      this.#trackSteward(e);
      if (e.event.type === "session.created") this.#specs.set(e.sessionId, e.event.spec);
    });

    for (const request of [...this.projection.pending.values()]) {
      this.#append(request.sessionId, {
        type: "approval.resolved",
        approvalId: request.id,
        decision: { type: "deny", message: RESTART_REASON },
        resolver: "hub",
        detail: RESTART_REASON,
      });
    }
    for (const s of [...this.projection.sessions.values()]) {
      const running = s.live || s.state === "starting" || s.state === "working" || s.state === "blocked";
      if (PROCESS_ADAPTERS.has(s.adapter)) {
        // A terminal's process does not survive the hub. Restart relaunches it.
        if (running || s.state === "idle") {
          this.#append(s.id, { type: "session.ended", outcome: "stopped", message: "The hub restarted." });
        }
        continue;
      }
      if (s.live) this.#append(s.id, { type: "session.live", live: false });
      if (running) this.#append(s.id, { type: "session.state", state: "idle", provenance: "hub" });
    }
  }

  subscribe(listener: HubListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  head(): number {
    return this.#log.head();
  }

  /** Cost today in hub local time, total cost, and non-archived sessions by state. */
  get steward(): Steward | undefined {
    return this.#steward;
  }

  stats(): { costToday: number; costTotal: number; stewardCostToday: number; states: Record<string, number>; pendingApprovals: number } {
    const states: Record<string, number> = {};
    let costTotal = 0;
    for (const s of this.projection.sessions.values()) {
      costTotal += s.costUsd;
      if (!s.archived) states[s.state] = (states[s.state] ?? 0) + 1;
    }
    return {
      costToday: this.#costByDay.get(dayKey(this.#now())) ?? 0,
      costTotal,
      stewardCostToday: this.#steward?.spendToday ?? 0,
      states,
      pendingApprovals: this.projection.pending.size,
    };
  }

  snapshot(): { head: number; sessions: SessionSummary[]; approvals: ApprovalRequest[] } {
    return { head: this.#log.head(), sessions: this.list(), approvals: this.approvals() };
  }

  list(): SessionSummary[] {
    return [...this.projection.sessions.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  approvals(): ApprovalRequest[] {
    return [...this.projection.pending.values()].sort((a, b) => a.requestedAt - b.requestedAt);
  }

  get(id: SessionId): SessionSummary {
    const s = this.projection.sessions.get(id);
    if (!s) throw new HubError("not-found", `no session ${id}`);
    return s;
  }

  /** Log events after `since` across sessions, for subscription replay. */
  replay(since: number, sessionIds: readonly SessionId[] | undefined, limit: number): HubEvent[] {
    return this.#log.readSince(since, { sessionIds, limit });
  }

  read(id: SessionId, since = 0, limit = 1000): HubEvent[] {
    this.get(id);
    return this.#log.readSince(since, { sessionIds: [id], limit });
  }

  async create(input: SessionSpec): Promise<SessionSummary> {
    let spec = SessionSpec.parse(input);
    if (spec.cockpit) {
      if (!this.#cockpitDir) throw new HubError("invalid", "this hub has no Cockpit");
      if (spec.adapter !== "claude-sdk") throw new HubError("invalid", "the Cockpit is a Claude chat session");
      const existing = [...this.projection.sessions.values()].find((s) => s.cockpit && !s.archived);
      if (existing) throw new HubError("invalid", `this hub already has a Cockpit (${existing.name})`);
      mkdirSync(this.#cockpitDir, { recursive: true });
      const { worktree: _ignored, ...rest } = spec;
      spec = { ...rest, cwd: this.#cockpitDir };
    }
    if (!this.#adapters[spec.adapter]) {
      throw new HubError("invalid", `adapter "${spec.adapter}" is not available on this hub yet`);
    }
    if (!path.isAbsolute(spec.cwd) || !this.#isDirectory(spec.cwd)) {
      throw new HubError("invalid", `working directory does not exist: ${spec.cwd}`);
    }
    const level = spec.level ?? this.defaultLevel;
    if (levelRank(level) > levelRank(this.maxLevel)) {
      throw new HubError("forbidden", `level "${level}" is above this hub's maximum "${this.maxLevel}"`);
    }
    if (spec.linkedSessionId) this.get(spec.linkedSessionId);

    let worktree: SessionSummary["worktree"];
    if (spec.worktree) {
      if (!this.#dataDir) throw new HubError("invalid", "this hub cannot create worktrees");
      worktree = await createWorktree({ cwd: spec.cwd, dataDir: this.#dataDir, branch: spec.worktree.branch, baseRef: spec.worktree.baseRef });
      spec = { ...spec, cwd: worktree.path };
    }

    const id = this.#newId();
    const now = this.#now();
    const summary: SessionSummary = {
      id,
      name: allocName([...this.projection.sessions.values()].map((s) => s.name)),
      adapter: spec.adapter,
      cwd: spec.cwd,
      projectRoot: projectRoot(spec.cwd),
      archived: false,
      ...(worktree ? { worktree, branch: worktree.branch } : {}),
      ...(spec.cardId !== undefined ? { cardId: spec.cardId } : {}),
      state: "starting",
      stateProvenance: "hub",
      level,
      costUsd: 0,
      pinned: spec.cockpit === true,
      cockpit: spec.cockpit === true,
      live: false,
      createdAt: now,
      updatedAt: now,
      ...(spec.model !== undefined ? { model: spec.model } : {}),
      ...(spec.agent !== undefined ? { agent: spec.agent } : {}),
      ...(spec.command !== undefined ? { command: spec.command } : {}),
      ...(spec.linkedSessionId !== undefined ? { linkedSessionId: spec.linkedSessionId } : {}),
      ...(spec.resumeEngineSessionId !== undefined ? { engineSessionId: spec.resumeEngineSessionId } : {}),
    };
    this.#specs.set(id, spec);
    this.#append(id, { type: "session.created", summary, spec });

    try {
      await this.#ensureLive(id);
    } catch (err) {
      this.#append(id, { type: "session.ended", outcome: "error", message: messageOf(err) });
      throw new HubError("engine", `could not start session: ${messageOf(err)}`);
    }
    // Terminal sessions take their first prompt at launch (a Claude terminal passes it to claude).
    if (spec.prompt && spec.adapter !== "pty") await this.send(id, spec.prompt, spec.cardId ? "card" : "human");
    return this.get(id);
  }

  async send(id: SessionId, text: string, from: UserMessageSource = "human"): Promise<void> {
    const s = this.get(id);
    if (PROCESS_ADAPTERS.has(s.adapter) && !this.#live.has(id)) {
      throw new HubError("invalid", `${s.name} is not running. Restart it first.`);
    }
    if (s.state === "done" && !PROCESS_ADAPTERS.has(s.adapter)) throw new HubError("invalid", `session ${s.name} has ended`);
    if (s.archived) throw new HubError("invalid", `${s.name} is archived`);
    this.#assertNotOpenElsewhere(s);
    const entry = await this.#ensureLive(id).catch((err: unknown) => {
      throw err instanceof HubError ? err : new HubError("engine", `could not resume session: ${messageOf(err)}`);
    });
    this.#append(id, { type: "user.message", text, from });
    await entry.adapter.send(text, from);
  }

  async interrupt(id: SessionId): Promise<void> {
    this.get(id);
    await this.#live.get(id)?.adapter.interrupt();
  }

  /** What a session changed (M12). Branch mode needs a worktree session. */
  async sessionDiff(id: SessionId, mode: "uncommitted" | "branch" = "uncommitted"): Promise<SessionDiff> {
    const s = this.get(id);
    if (mode === "branch" && !s.worktree) throw new HubError("invalid", "only worktree sessions have a branch to compare");
    // Older worktrees did not record where their branch started: compare with the main checkout's branch.
    const base = s.worktree?.baseCommit ?? s.worktree?.baseRef ?? (s.worktree ? (await git(["rev-parse", "--abbrev-ref", "HEAD"], s.worktree.repoRoot)).trim() : undefined);
    return readDiff(s.worktree && !s.worktree.removed ? s.worktree.path : s.cwd, mode, mode === "branch" ? base : undefined);
  }

  /** A person undoes uncommitted changes in a session's folder; never while the session works. */
  async revertChange(id: SessionId, filePath: string, hunkId?: string): Promise<SessionDiff> {
    const s = this.get(id);
    if (s.state === "working" || s.state === "starting") throw new HubError("invalid", `${s.name} is working; revert when it is idle`);
    const diff = await revertChange(s.worktree && !s.worktree.removed ? s.worktree.path : s.cwd, filePath, hunkId);
    this.#recordChanges(id);
    return diff;
  }

  /** Records which files changed, when that differs from the last record (after a turn, after a revert). */
  #recordChanges(id: SessionId): void {
    const s = this.projection.sessions.get(id);
    if (!s || s.archived) return;
    void changeSummary(s.worktree && !s.worktree.removed ? s.worktree.path : s.cwd).then((files) => {
      if (!files) return;
      const key = JSON.stringify(files);
      if (this.#lastChanges.get(id) === key || (files.length === 0 && !this.#lastChanges.has(id))) return;
      this.#lastChanges.set(id, key);
      if (this.projection.sessions.has(id)) this.#append(id, { type: "files.changed", files });
    });
  }

  /** History search across the log, with session names attached. Unknown sessions are skipped. */
  searchHistory(query: string, sessionId?: SessionId, limit?: number): HistoryHit[] {
    return this.#log
      .search(query, { sessionId, ...(limit ? { limit } : {}) })
      .flatMap((h) => {
        const s = this.projection.sessions.get(h.sessionId);
        return s ? [{ ...h, sessionName: s.name }] : [];
      });
  }

  /** The session says something to the person (the `speak` tool). Clients may read it aloud. */
  speak(id: SessionId, text: string, lang?: SpokenLanguage): void {
    const s = this.get(id);
    if (s.archived) throw new HubError("invalid", `${s.name} is archived`);
    const clean = text.trim();
    if (!clean) throw new HubError("invalid", "nothing to say");
    this.#append(id, { type: "speech", text: clean, ...(lang ? { lang } : {}) });
  }

  rename(id: SessionId, name: string): void {
    const s = this.get(id);
    const clean = name.trim();
    if (!clean) throw new HubError("invalid", "a name cannot be empty");
    for (const other of this.projection.sessions.values()) {
      if (other.id !== id && other.name.toLowerCase() === clean.toLowerCase()) {
        throw new HubError("invalid", `another session is already called ${other.name}`);
      }
    }
    if (clean !== s.name) this.#append(id, { type: "session.renamed", name: clean });
  }

  /**
   * Hides a session and stops it. With `removeWorktree`, deletes its worktree directory, refusing
   * uncommitted changes unless `force`. Branches are never deleted.
   */
  async archive(id: SessionId, opts: { removeWorktree?: boolean | undefined; force?: boolean | undefined } = {}): Promise<void> {
    const s = this.get(id);
    const removing = opts.removeWorktree === true && s.worktree !== undefined && s.worktree.removed !== true;
    if (removing && !opts.force) {
      if (this.#isDirectory(s.worktree!.path) && (await hasUncommittedChanges(s.worktree!.path))) {
        throw new HubError("invalid", `the worktree for ${s.worktree!.branch} has uncommitted changes; commit them or remove it with force`);
      }
    }
    if (this.#live.has(id) || this.#starting.has(id)) await this.stop(id);
    if (removing) await removeWorktree(s.worktree!, opts.force === true);
    this.#append(id, { type: "session.archived", archived: true, ...(removing ? { worktreeRemoved: true } : {}) });
  }

  unarchive(id: SessionId): void {
    const s = this.get(id);
    if (s.archived) this.#append(id, { type: "session.archived", archived: false });
  }

  /** Resolves when the session reaches one of `states`, or at the timeout with its state then. */
  waitFor(id: SessionId, states: readonly string[], timeoutMs: number): Promise<SessionSummary> {
    const current = this.get(id);
    if (states.includes(current.state)) return Promise.resolve(current);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        unsubscribe();
        resolve(this.get(id));
      };
      const timer = setTimeout(done, timeoutMs);
      const unsubscribe = this.subscribe((e) => {
        if (e.sessionId === id && states.includes(this.get(id).state)) done();
      });
    });
  }

  /** Starts a session's engine again: relaunches an ended terminal, or resumes a paused chat. */
  async restart(id: SessionId): Promise<void> {
    const s = this.get(id);
    if (this.#live.has(id) || this.#starting.has(id)) throw new HubError("invalid", `${s.name} is already running`);
    this.#assertNotOpenElsewhere(s);
    const buffer = this.#terminals.get(id);
    if (buffer && buffer.end > 0) buffer.append(Buffer.from("\r\n\x1b[2m── restarted ──\x1b[0m\r\n"));
    try {
      await this.#ensureLive(id);
    } catch (err) {
      throw err instanceof HubError ? err : new HubError("engine", `could not restart ${s.name}: ${messageOf(err)}`);
    }
  }

  /**
   * Continues a chat session in its engine's own terminal UI: stops the chat engine and starts a
   * terminal session linked to it, resuming the same conversation (ADR-0005).
   */
  async openTerminal(id: SessionId): Promise<SessionSummary> {
    const s = this.get(id);
    if (s.adapter !== "claude-sdk") throw new HubError("invalid", `${s.name} is not a chat session`);
    if (!s.engineSessionId) throw new HubError("invalid", `${s.name} has no conversation to continue yet. Send a message first.`);
    if (!this.#adapters.pty) throw new HubError("invalid", "terminal sessions are not available on this hub");
    const existing = this.#liveLinkedTo(id);
    if (existing) return existing;
    await this.stop(id);
    return this.create({
      adapter: "pty",
      agent: "claude",
      cwd: s.cwd,
      level: s.level,
      linkedSessionId: id,
      resumeEngineSessionId: s.engineSessionId,
      ...(s.model !== undefined ? { model: s.model.replace(/\[.*\]$/, "") } : {}),
    });
  }

  // ---- terminals ----------------------------------------------------------

  terminalAttach(id: SessionId, listener: TerminalListener): { offset: number; data: Buffer; live: boolean; detach: () => void } {
    const s = this.get(id);
    if (!PROCESS_ADAPTERS.has(s.adapter)) throw new HubError("invalid", `${s.name} is not a terminal session`);
    return { ...this.#terminal(id).attach(listener), live: this.#live.has(id) };
  }

  terminalWrite(id: SessionId, bytes: Uint8Array): void {
    this.#terminalAdapter(id).write?.(bytes);
  }

  terminalResize(id: SessionId, cols: number, rows: number): void {
    this.#terminalAdapter(id).resize?.(cols, rows);
    this.#terminalSizes.set(id, { cols, rows });
    this.heuristics.resize(id, cols, rows);
  }

  /** Delivers an integration callback (e.g. a Claude Code hook) to a live session's adapter. */
  async hook(id: SessionId, token: string | undefined, payload: unknown, signal: AbortSignal): Promise<object | undefined> {
    const entry = this.#live.get(id) ?? (await this.#starting.get(id)?.catch(() => undefined));
    if (!entry?.adapter.hook) throw new HubError("not-found", `no running session ${id} accepts hooks`);
    return entry.adapter.hook(token, payload, signal);
  }

  /** Stops the engine. The session stays resumable; sending to it starts the engine again. */
  async stop(id: SessionId): Promise<void> {
    const s = this.get(id);
    const starting = this.#starting.get(id);
    if (starting) await starting.catch(() => undefined);
    const entry = this.#live.get(id);
    if (!entry) return;

    this.#retire(id, entry);
    this.#broker.cancelSession(id, "The session was stopped.");
    await entry.adapter.stop();
    if (entry.adapter.endsWithProcess) {
      this.#append(id, { type: "session.ended", outcome: "stopped", message: "Stopped." });
      return;
    }
    this.#append(id, { type: "session.live", live: false });
    if (s.state !== "done" && s.state !== "error") {
      this.#append(id, { type: "session.state", state: "idle", provenance: "hub" });
    }
  }

  async setLevel(id: SessionId, level: PermissionLevel, actor: LevelActor): Promise<void> {
    const s = this.get(id);
    const check = checkLevelChange(actor, s.level, level, this.maxLevel);
    if (!check.ok) throw new HubError("forbidden", check.reason);
    if (level === s.level) return;
    this.#append(id, { type: "session.level", level, by: actor });
    await this.#live.get(id)?.adapter.setLevel(level);
  }

  decide(approvalId: string, decision: ApprovalDecision, resolver: Resolver = "human", detail?: string): void {
    const request = this.#broker.check(approvalId, decision);
    if (decision.type === "allow-rule") {
      if (!this.policy) throw new HubError("invalid", "this hub has no policy store");
      const saved = this.policy.appendAllow(decision.scope, this.get(request.sessionId).cwd, decision.rule);
      this.#broker.decide(approvalId, decision, resolver, `Saved ${saved.rule} to ${saved.path}.`, saved);
      return;
    }
    this.#broker.decide(approvalId, decision, resolver, detail);
  }

  /**
   * A person rejects an action the Steward allowed. The action may already have run, so the session is
   * lowered to Supervised and the agent is told to undo it where it can.
   */
  async override(approvalId: string): Promise<void> {
    const allowed = this.#stewardAllowed.get(approvalId);
    if (!allowed) throw new HubError("not-found", "only an action the Steward allowed can be overridden");
    if (this.#overridden.has(approvalId)) return;
    const s = this.get(allowed.sessionId);
    const note = `The developer did not approve "${allowed.summary}", which Loom's Steward had allowed.`;
    this.#append(s.id, { type: "approval.overridden", approvalId, note });
    if (s.level !== "supervised") {
      this.#append(s.id, { type: "session.level", level: "supervised", by: "hub" });
      await this.#live.get(s.id)?.adapter.setLevel("supervised");
    }
    if (this.#live.has(s.id) && s.state !== "done" && s.state !== "error") {
      await this.send(
        s.id,
        `${note} If it changed anything, undo that where you can, then continue, and expect to ask before similar actions.`,
        "human",
      ).catch(() => undefined);
    }
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.#live.keys()].map((id) => this.stop(id)));
  }

  // -------------------------------------------------------------------------

  #append(sessionId: SessionId, event: SessionEvent): HubEvent {
    const before = this.projection.sessions.get(sessionId)?.state;
    const e = this.#log.append(sessionId, event, this.#now());
    applyEvent(this.projection, e);
    this.#countCost(e);
    this.#trackSteward(e);
    this.#watchScreen(sessionId, event);
    // After a turn: a session that was working is idle again.
    if (event.type === "session.state" && event.state === "idle" && before === "working") this.#recordChanges(sessionId);
    for (const listener of this.#listeners) {
      try {
        listener(e);
      } catch (err) {
        console.error("hub listener failed:", err);
      }
    }
    return e;
  }

  #ensureLive(id: SessionId): Promise<LiveEntry> {
    const live = this.#live.get(id);
    if (live) return Promise.resolve(live);
    const pending = this.#starting.get(id);
    if (pending) return pending;

    const start = (async () => {
      const s = this.get(id);
      const spec = this.#specs.get(id);
      const factory = this.#adapters[s.adapter];
      if (!spec || !factory) throw new HubError("internal", `cannot start session ${s.name}`);

      if (!this.#isDirectory(s.cwd)) {
        throw new HubError("invalid", s.worktree?.removed ? `${s.name}'s worktree was removed` : `${s.cwd} no longer exists`);
      }
      const entry = { current: true, statedDuringStart: false } as LiveEntry;
      entry.adapter = factory(this.#hostFor(id, entry));
      const token = this.tokens.issue(id, s.cockpit ? "cockpit" : "session");
      await entry.adapter.start({
        spec,
        level: s.level,
        hubMax: this.maxLevel,
        resumeEngineSessionId: s.engineSessionId,
        costBase: s.costUsd,
        protectedFiles: this.policy?.protectedFiles(s.cwd) ?? [],
        loom: this.#integration?.(s, token),
      });
      this.#live.set(id, entry);
      this.#append(id, { type: "session.live", live: true });
      const now = this.get(id).state;
      if (!entry.statedDuringStart && (now === "starting" || now === "error" || now === "done")) {
        this.#append(id, { type: "session.state", state: "idle", provenance: "hub" });
      }
      return entry;
    })();

    this.#starting.set(id, start);
    start.finally(() => this.#starting.delete(id)).catch(() => undefined);
    return start;
  }

  #hostFor(id: SessionId, entry: LiveEntry): AdapterHost {
    return {
      sessionId: id,
      emit: (event) => {
        if (!entry.current) return;
        if (event.type === "session.state" && !this.#live.has(id)) entry.statedDuringStart = true;
        this.#append(id, event);
      },
      terminalOutput: (bytes) => {
        if (entry.current) this.#terminal(id).append(bytes);
      },
      ended: (outcome, message) => {
        if (!entry.current) return;
        this.#retire(id, entry);
        this.#broker.cancelSession(id, "The session's process exited.");
        this.#append(id, { type: "session.ended", outcome, ...(message !== undefined ? { message } : {}) });
      },
      requestApproval: (request, signal) => this.#requestApproval(id, entry, request, signal),
      exited: (error) => {
        if (!entry.current) return;
        this.#retire(id, entry);
        this.#broker.cancelSession(id, "The engine exited.");
        if (error) this.#append(id, { type: "error", message: error });
        this.#append(id, { type: "session.live", live: false });
        this.#append(id, { type: "session.state", state: "idle", provenance: "hub" });
      },
    };
  }

  async #requestApproval(
    id: SessionId,
    entry: LiveEntry,
    initial: NewApproval,
    signal?: AbortSignal,
  ): Promise<ApprovalDecision> {
    let request = initial;
    if (!entry.current) return { type: "deny", message: "The session is no longer running." };
    const s = this.get(id);
    const spec = this.#specs.get(id);

    // Stage 1: rules. Deny and allow resolve without a person; ask forces one.
    if (request.kind === "permission" && this.policy) {
      const call = { toolName: request.toolName, input: request.input };
      const verdict = this.policy.evaluate(s.cwd, call);
      if (verdict.kind === "deny") {
        const where = verdict.rule.scope === "hub" ? "hub policy" : "project policy";
        return this.#broker.resolveNow(
          id,
          request,
          { type: "deny", message: `Denied by the ${where} rule ${verdict.rule.rule}.` },
          "rule",
          `${verdict.rule.rule} in ${verdict.rule.path}`,
          verdict.rule,
        );
      }
      if (verdict.kind === "allow") {
        return this.#broker.resolveNow(id, request, { type: "allow" }, "rule", `${verdict.rule.rule} in ${verdict.rule.path}`, verdict.rule);
      }
      if (verdict.kind === "ask") {
        request = { ...request, mustAsk: true, askRule: verdict.rule };
      } else if (!request.suggestedRule) {
        const suggested = this.policy.suggest(s.cwd, call);
        if (suggested) request = { ...request, suggestedRule: suggested };
      }
    }
    const timeout = spec?.approvalTimeout ?? this.policy?.timeoutFor(s.cwd);
    const stewardReviews =
      request.kind === "permission" && !request.mustAsk && this.#steward?.enabled === true && s.level === "assisted";
    if (stewardReviews) request = { ...request, steward: this.#steward!.reviewing() };

    this.#blockers.set(id, (this.#blockers.get(id) ?? 0) + 1);
    this.#append(id, {
      type: "session.state",
      state: "blocked",
      blockedOn: request.kind === "question" ? "question" : "approval",
      provenance: "pushed",
    });
    try {
      return await this.#broker.request(id, request, {
        signal,
        timeoutMs: timeout ? timeout.minutes * 60_000 : undefined,
        onOpen: stewardReviews ? (open) => void this.#runSteward(id, open, false).catch((err) => console.error("steward:", err)) : undefined,
        onTimeout:
          timeout?.then === "steward" && this.#steward?.enabled && request.kind === "permission" && !request.mustAsk
            ? (open) => void this.#runSteward(id, open, true).catch(() => {
                if (this.#broker.isOpen(open.id)) this.#broker.decide(open.id, { type: "deny", message: "No decision in time." }, "timeout");
              })
            : undefined,
      });
    } finally {
      const left = (this.#blockers.get(id) ?? 1) - 1;
      if (left > 0) this.#blockers.set(id, left);
      else this.#blockers.delete(id);
      if (left === 0 && entry.current && this.get(id).state === "blocked") {
        this.#append(id, { type: "session.state", state: "working", provenance: "pushed" });
      }
    }
  }

  #trackSteward(e: HubEvent): void {
    const ev = e.event;
    if (ev.type === "approval.requested") this.#requestSummaries.set(ev.request.id, ev.request.summary);
    else if (ev.type === "approval.resolved" && ev.resolver === "steward" && ev.decision.type === "allow") {
      this.#stewardAllowed.set(ev.approvalId, { sessionId: e.sessionId, summary: this.#requestSummaries.get(ev.approvalId) ?? "an action" });
    } else if (ev.type === "approval.overridden") this.#overridden.add(ev.approvalId);
  }

  async #runSteward(sessionId: SessionId, request: ApprovalRequest, forceDecide: boolean): Promise<void> {
    const steward = this.#steward;
    if (!steward || request.kind !== "permission") return;
    const s = this.get(sessionId);
    const view = this.policy?.view(s.cwd);
    const input = buildReviewInput({
      request,
      session: s,
      events: this.#log.readTail(sessionId, 80),
      card: this.#cardFor?.(s),
      rules: {
        deny: [...(view?.hub.policy.deny ?? []), ...(view?.project.policy.deny ?? [])],
        ask: [...(view?.hub.policy.ask ?? []), ...(view?.project.policy.ask ?? [])],
      },
      diffStat: await diffStat(s.cwd),
    });
    const outcome = await steward.review(input, { sessionId, terminal: s.adapter === "pty", forceDecide });
    if (!this.#broker.isOpen(request.id)) return;

    this.#broker.update(request.id, outcome.review);
    const r = outcome.review;
    if (outcome.act === "hold") {
      if (forceDecide) {
        const message = `Nobody decided in time, and the Steward would not decide: ${r.reason ?? r.heldBecause ?? "no verdict"}`;
        this.#broker.decide(request.id, { type: "deny", message }, "timeout", message);
      }
      return;
    }
    const pct = Math.round((r.confidence ?? 0) * 100);
    const detail = `${pct}% confident, ${r.risk} risk: ${r.reason}`;
    if (outcome.act === "allow") this.#broker.decide(request.id, { type: "allow" }, "steward", detail);
    else this.#broker.decide(request.id, { type: "deny", message: `Loom's Steward denied this: ${r.reason}` }, "steward", detail);
  }

  #countCost(e: HubEvent): void {
    if (e.event.type !== "cost.update") return;
    const before = this.#lastCost.get(e.sessionId) ?? 0;
    this.#lastCost.set(e.sessionId, e.event.costUsd);
    const delta = e.event.costUsd - before;
    if (delta > 0) {
      const day = dayKey(e.at);
      this.#costByDay.set(day, (this.#costByDay.get(day) ?? 0) + delta);
    }
  }

  /** Starts or stops heuristic state for terminal sessions as their events arrive (ADR-0011). */
  #watchScreen(id: SessionId, event: SessionEvent): void {
    if (!this.heuristics.enabled) return;
    switch (event.type) {
      case "session.created":
        if (event.spec.terminal) this.#terminalSizes.set(id, event.spec.terminal);
        break;
      case "session.process": {
        const s = this.projection.sessions.get(id);
        if (s?.adapter !== "pty") break;
        this.heuristics.track(id, { agent: event.agent, command: event.command }, this.#terminal(id), this.#terminalSizes.get(id) ?? { cols: 100, rows: 30 });
        break;
      }
      case "session.state":
        if (event.provenance === "pushed") this.heuristics.sawPushed(id);
        break;
      case "session.ended":
      case "session.archived":
        this.heuristics.untrack(id);
        break;
      case "session.live":
        if (!event.live) this.heuristics.untrack(id);
        break;
      default:
        break;
    }
  }

  #terminal(id: SessionId): TerminalBuffer {
    let buffer = this.#terminals.get(id);
    if (!buffer) {
      buffer = new TerminalBuffer();
      this.#terminals.set(id, buffer);
    }
    return buffer;
  }

  #terminalAdapter(id: SessionId): SessionAdapter {
    const s = this.get(id);
    const adapter = this.#live.get(id)?.adapter;
    if (!adapter?.write) throw new HubError("invalid", `${s.name} has no running terminal`);
    return adapter;
  }

  #liveLinkedTo(id: SessionId): SessionSummary | undefined {
    for (const other of this.projection.sessions.values()) {
      if (other.linkedSessionId === id && (this.#live.has(other.id) || this.#starting.has(other.id))) return other;
    }
    return undefined;
  }

  /** A chat session must not drive the same conversation while its terminal twin is running. */
  #assertNotOpenElsewhere(s: SessionSummary): void {
    const twin = this.#liveLinkedTo(s.id);
    if (twin) {
      throw new HubError("invalid", `this conversation is open in terminal session ${twin.name}. Stop that session first.`);
    }
  }

  #retire(id: SessionId, entry: LiveEntry): void {
    entry.current = false;
    this.tokens.revoke(id);
    this.blackboard.releaseAll(id);
    if (this.#live.get(id) === entry) this.#live.delete(id);
    this.#blockers.delete(id);
  }
}

function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
