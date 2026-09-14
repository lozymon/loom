import {
  type ApprovalDecision,
  type BoardView,
  type CardInput,
  type CardStatus,
  type HubStats,
  type ApprovalRequest,
  type HubEvent,
  type PermissionLevel,
  type PolicyFile,
  type PolicyScope,
  reduceSummary,
  type SessionSpec,
  type SessionSummary,
  type SpokenLanguage,
  type PushSubscriptionJson,
  type TermFrame,
  type UserMessageSource,
  type Welcome,
} from "@loom/protocol";
import { createContext, useContext } from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";
import { mergeEvents } from "../lib/timeline.ts";
import { type ConnectionStatus, HubConnection } from "./connection.ts";

export type Screen = { kind: "overview" } | { kind: "session" } | { kind: "board"; root: string };

export interface HubState {
  screen: Screen;
  /** Boards this client has opened, by project root. */
  boards: Record<string, BoardView>;
  stats: HubStats | undefined;
  showArchived: boolean;
  status: ConnectionStatus;
  hub: Welcome["hub"] | undefined;
  sessions: Record<string, SessionSummary>;
  approvals: Record<string, ApprovalRequest>;
  /** Event history for sessions that have been opened, oldest first. */
  timelines: Record<string, HubEvent[]>;
  selected: string | undefined;
  /** Last error from an action, shown until dismissed. */
  error: string | undefined;
  /** Unsent composer text per session, so dictation can add to it. */
  drafts: Record<string, string>;
  /** Bumped to move focus into a session's composer, e.g. after dictation. */
  composerFocus: { sessionId: string; n: number } | undefined;
  /** An event to scroll the timeline to, e.g. from history search. */
  timelineFocus: { sessionId: string; seq: number; n: number } | undefined;
}

const PAGE = 1000;

export interface TerminalSink {
  /** The recent screen. Replaces whatever the view showed before, e.g. after a reconnect. */
  snapshot(offset: number, bytes: Uint8Array): void;
  data(offset: number, bytes: Uint8Array): void;
}

interface TerminalAttachment {
  sink: TerminalSink;
  /** Frames that arrived before the attach response. */
  queued: TermFrame[] | undefined;
}

function decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function encode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * Client-side state for one hub: a snapshot, kept current by live events, using the same summary
 * reducer as the hub (`reduceSummary` in @loom/protocol).
 */
export interface HubHooks {
  /** The person turned to this hub: opened one of its sessions or boards. */
  onFocus?(): void;
  onWelcome?(welcome: Welcome): void;
  /** A live event, after it is applied. `before` is the session and `approval` the pending request as they were. */
  onEvent?(event: HubEvent, ctx: { before: SessionSummary | undefined; approval: ApprovalRequest | undefined }): void;
}

export function createHub(url: string, token: string, hooks: HubHooks = {}) {
  const [state, setState] = createStore<HubState>({
    screen: { kind: "overview" },
    boards: {},
    stats: undefined,
    showArchived: false,
    status: { kind: "connecting" },
    hub: undefined,
    sessions: {},
    approvals: {},
    timelines: {},
    selected: undefined,
    error: undefined,
    drafts: {},
    composerFocus: undefined,
    timelineFocus: undefined,
  });

  const terminals = new Map<string, TerminalAttachment>();

  const conn = new HubConnection(url, token, {
    onStatus: (status) => setState("status", reconcile(status)),
    onOpen: (welcome) => {
      setState("hub", welcome.hub);
      hooks.onWelcome?.(welcome);
      void sync();
    },
    onEvent: (e) => {
      const before = state.sessions[e.sessionId];
      const approvalId = e.event.type === "approval.updated" ? e.event.approvalId : undefined;
      const ctx = {
        before: before ? { ...before } : undefined,
        approval: approvalId && state.approvals[approvalId] ? { ...state.approvals[approvalId] } : undefined,
      };
      apply(e);
      hooks.onEvent?.(e, ctx);
    },
    // reconcile, not a plain set: Solid merges plain objects, so a field the hub removed (runCap) would stay.
    onBoard: (board) => setState("boards", board.root, reconcile(board)),
    onTerm: (frame) => {
      const a = terminals.get(frame.sessionId);
      if (!a) return;
      if (a.queued) a.queued.push(frame);
      else a.sink.data(frame.offset, decode(frame.data));
    },
  });

  async function attachTerminal(sessionId: string): Promise<void> {
    const a = terminals.get(sessionId);
    if (!a) return;
    a.queued = [];
    try {
      const snap = await conn.request({ cmd: "terminal.attach", sessionId });
      if (terminals.get(sessionId) !== a) return;
      a.sink.snapshot(snap.offset, decode(snap.data));
      const queued = a.queued ?? [];
      a.queued = undefined;
      for (const f of queued) a.sink.data(f.offset, decode(f.data));
    } catch (err) {
      a.queued = undefined;
      fail(err);
    }
  }

  function apply(e: HubEvent): void {
    setState(
      produce((s) => {
        const next = reduceSummary(s.sessions[e.sessionId], e);
        if (next) s.sessions[e.sessionId] = next;

        const ev = e.event;
        if (ev.type === "approval.requested") s.approvals[ev.request.id] = ev.request;
        else if (ev.type === "approval.updated") {
          const req = s.approvals[ev.approvalId];
          if (req) s.approvals[ev.approvalId] = { ...req, steward: ev.steward };
        } else if (ev.type === "approval.resolved") delete s.approvals[ev.approvalId];
        else if (ev.type === "session.ended") {
          for (const [id, a] of Object.entries(s.approvals)) if (a.sessionId === e.sessionId) delete s.approvals[id];
        }

        const timeline = s.timelines[e.sessionId];
        if (timeline && (timeline.length === 0 || timeline[timeline.length - 1]!.seq < e.seq)) timeline.push(e);
      }),
    );
  }

  async function readAll(sessionId: string, since: number): Promise<HubEvent[]> {
    const out: HubEvent[] = [];
    let cursor = since;
    for (;;) {
      const page = await conn.request({ cmd: "session.read", sessionId, since: cursor, limit: PAGE });
      out.push(...page);
      if (page.length < PAGE) return out;
      cursor = page[page.length - 1]!.seq;
    }
  }

  /** Snapshot, catch up open timelines, then subscribe from the snapshot head. */
  async function sync(): Promise<void> {
    try {
      const snap = await conn.request({ cmd: "hub.snapshot" });
      // Replace, not merge: approvals resolved while disconnected must disappear.
      setState("sessions", reconcile(Object.fromEntries(snap.sessions.map((s) => [s.id, s]))));
      setState("approvals", reconcile(Object.fromEntries(snap.approvals.map((a) => [a.id, a]))));
      for (const id of Object.keys(state.timelines)) {
        const known = state.timelines[id] ?? [];
        const more = await readAll(id, known.at(-1)?.seq ?? 0);
        setState("timelines", id, (prev) => mergeEvents(prev ?? [], more));
      }
      await conn.request({ cmd: "events.subscribe", since: snap.head });
      for (const id of terminals.keys()) void attachTerminal(id);
      for (const root of Object.keys(state.boards)) void actions.boardOpen(root);
      void actions.refreshStats();
    } catch (err) {
      fail(err);
    }
  }

  function fail(err: unknown): void {
    setState("error", err instanceof Error ? err.message : String(err));
  }

  async function run<T>(action: () => Promise<T>): Promise<T | undefined> {
    try {
      return await action();
    } catch (err) {
      fail(err);
      return undefined;
    }
  }

  const actions = {
    connect: () => conn.connect(),
    disconnect: () => conn.close(),
    dismissError: () => setState("error", undefined),

    async startCockpit(): Promise<void> {
      const created = await run(() => conn.request({ cmd: "session.create", spec: { adapter: "claude-sdk", cwd: "cockpit", cockpit: true } }));
      if (created) {
        setState("sessions", created.id, (prev) => prev ?? created);
        await actions.open(created.id);
      }
    },
    showOverview: () => {
      hooks.onFocus?.();
      setState("screen", reconcile({ kind: "overview" } as Screen));
    },
    toggleArchived: () => setState("showArchived", (v) => !v),

    async open(sessionId: string): Promise<void> {
      hooks.onFocus?.();
      setState("selected", sessionId);
      setState("screen", reconcile({ kind: "session" } as Screen));
      if (state.timelines[sessionId]) return;
      setState("timelines", sessionId, []);
      const events = await run(() => readAll(sessionId, 0));
      if (events) setState("timelines", sessionId, (prev) => mergeEvents(prev ?? [], events));
    },

    async create(spec: SessionSpec): Promise<SessionSummary | undefined> {
      const created = await run(() => conn.request({ cmd: "session.create", spec }));
      if (created) {
        setState("sessions", created.id, (prev) => prev ?? created);
        await actions.open(created.id);
      }
      return created;
    },

    send: (sessionId: string, text: string, from: UserMessageSource = "human") => run(() => conn.request({ cmd: "session.send", sessionId, text, from })),
    setDraft: (sessionId: string, text: string) => setState("drafts", sessionId, text),
    /** Adds dictated text to a session's draft and puts the cursor there. */
    appendDraft(sessionId: string, text: string): void {
      const prev = state.drafts[sessionId]?.trimEnd() ?? "";
      setState("drafts", sessionId, prev ? `${prev} ${text}` : text);
      setState("composerFocus", { sessionId, n: (state.composerFocus?.n ?? 0) + 1 });
    },
    /** Speech to text on this hub. Throws, so the voice bar can show the reason. */
    voiceTranscribe: (audio: string, language?: SpokenLanguage, prompt?: string) =>
      conn.request({ cmd: "voice.transcribe", audio, ...(language ? { language } : {}), ...(prompt ? { prompt } : {}) }),
    sessionDiff: (sessionId: string, mode: "uncommitted" | "branch") => conn.request({ cmd: "session.diff", sessionId, mode }),
    revertChange: (sessionId: string, path: string, hunkId?: string) => conn.request({ cmd: "session.revert", sessionId, path, ...(hunkId ? { hunkId } : {}) }),
    searchHistory: (query: string) => conn.request({ cmd: "history.search", query, limit: 50 }),
    /** Opens a session and scrolls its timeline to an event. */
    async openAt(sessionId: string, seq: number): Promise<void> {
      await actions.open(sessionId);
      setState("timelineFocus", { sessionId, seq, n: (state.timelineFocus?.n ?? 0) + 1 });
    },
    pushKey: () => conn.request({ cmd: "push.key" }),
    pushSubscribe: (subscription: PushSubscriptionJson, label: string) => conn.request({ cmd: "push.subscribe", subscription, label }),
    pushUnsubscribe: (endpoint: string) => conn.request({ cmd: "push.unsubscribe", endpoint }),
    pushTest: (endpoint?: string) => conn.request({ cmd: "push.test", ...(endpoint ? { endpoint } : {}) }),
    pushDevices: () => conn.request({ cmd: "push.devices" }),
    voiceSpeak: (text: string, lang?: SpokenLanguage) => conn.request({ cmd: "voice.speak", text, ...(lang ? { lang } : {}) }),
    interrupt: (sessionId: string) => run(() => conn.request({ cmd: "session.interrupt", sessionId })),
    stop: (sessionId: string) => run(() => conn.request({ cmd: "session.stop", sessionId })),
    setLevel: (sessionId: string, level: PermissionLevel) =>
      run(() => conn.request({ cmd: "session.set-level", sessionId, level })),
    override: (approvalId: string) => run(() => conn.request({ cmd: "approval.override", approvalId })),
    decide: (approvalId: string, decision: ApprovalDecision) =>
      run(() => conn.request({ cmd: "approval.decide", approvalId, decision })),
    restart: (sessionId: string) => run(() => conn.request({ cmd: "session.restart", sessionId })),
    rename: (sessionId: string, name: string) => run(() => conn.request({ cmd: "session.rename", sessionId, name })),
    archive: (sessionId: string, removeWorktree = false, force = false) =>
      run(() => conn.request({ cmd: "session.archive", sessionId, removeWorktree, force })),
    unarchive: (sessionId: string) => run(() => conn.request({ cmd: "session.unarchive", sessionId })),

    async refreshStats(): Promise<void> {
      if (state.status.kind !== "open") return;
      const stats = await conn.request({ cmd: "hub.stats" }).catch(() => undefined);
      if (stats) setState("stats", reconcile(stats));
    },

    /** Loads the board for the project containing `dir`; with `show`, switches to it at the resolved project root. */
    async boardOpen(dir: string, show = false): Promise<void> {
      const board = await run(() => conn.request({ cmd: "board.get", cwd: dir }));
      if (!board) return;
      setState("boards", board.root, reconcile(board));
      if (show) {
        hooks.onFocus?.();
        setState("screen", reconcile({ kind: "board", root: board.root } as Screen));
      }
    },
    boardAdd: (root: string, card: CardInput) => run(() => conn.request({ cmd: "board.add", cwd: root, card })),
    boardUpdate: (root: string, cardId: string, card: CardInput) => run(() => conn.request({ cmd: "board.update", cwd: root, cardId, card })),
    boardMove: (root: string, cardId: string, status: CardStatus) => run(() => conn.request({ cmd: "board.move", cwd: root, cardId, status })),
    boardRemove: (root: string, cardId: string) => run(() => conn.request({ cmd: "board.remove", cwd: root, cardId })),
    boardDispatch: (root: string, cardId: string) => run(() => conn.request({ cmd: "board.dispatch", cwd: root, cardId })),
    boardRun: (root: string, cap: number | null) => run(() => conn.request({ cmd: "board.run", cwd: root, cap })),

    policyGet: (cwd: string) => run(() => conn.request({ cmd: "policy.get", cwd })),
    policySave: (scope: PolicyScope, cwd: string, policy: PolicyFile) => run(() => conn.request({ cmd: "policy.save", scope, cwd, policy })),
    policyTrust: (cwd: string, allowHash: string) => run(() => conn.request({ cmd: "policy.trust", cwd, allowHash })),

    async openTerminal(sessionId: string): Promise<void> {
      const created = await run(() => conn.request({ cmd: "session.open-terminal", sessionId }));
      if (created) {
        setState("sessions", created.id, (prev) => prev ?? created);
        await actions.open(created.id);
      }
    },

    /**
     * Streams a terminal into `sink` until the returned function is called. Survives reconnects:
     * the sink gets a fresh snapshot each time the connection comes back.
     */
    watchTerminal(sessionId: string, sink: TerminalSink): () => void {
      const attachment: TerminalAttachment = { sink, queued: undefined };
      terminals.set(sessionId, attachment);
      if (state.status.kind === "open") void attachTerminal(sessionId);
      return () => {
        if (terminals.get(sessionId) !== attachment) return;
        terminals.delete(sessionId);
        if (state.status.kind === "open") void conn.request({ cmd: "terminal.detach", sessionId }).catch(() => undefined);
      };
    },

    resyncTerminal(sessionId: string): void {
      if (state.status.kind === "open") void attachTerminal(sessionId);
    },

    terminalInput(sessionId: string, bytes: Uint8Array): void {
      if (state.status.kind !== "open") return;
      void conn.request({ cmd: "terminal.write", sessionId, data: encode(bytes) }).catch(() => undefined);
    },

    terminalResize(sessionId: string, cols: number, rows: number): void {
      if (state.status.kind !== "open") return;
      void conn.request({ cmd: "terminal.resize", sessionId, cols, rows }).catch(() => undefined);
    },
  };

  return { state, actions };
}

export type Hub = ReturnType<typeof createHub>;

export const HubContext = createContext<Hub>();

export function useHub(): Hub {
  const hub = useContext(HubContext);
  if (!hub) throw new Error("useHub must be used inside a HubContext provider");
  return hub;
}
