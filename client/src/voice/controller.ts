import type { SessionSummary, SpokenLanguage } from "@loom/protocol";
import { createContext, onCleanup, useContext } from "solid-js";
import { createStore } from "solid-js/store";
import type { HubList, ListedHub } from "../hub/hubList.ts";
import type { Hub } from "../hub/store.ts";
import { approvalCommand, cleanTranscript, parseDictation } from "./commands.ts";
import { utteranceFor } from "./readback.ts";
import { Recorder } from "./recorder.ts";
import { createVoiceSettings } from "./settings.ts";
import { createSpeaker } from "./speaker.ts";
import { toBase64 } from "./wav.ts";

export type VoicePhase = "idle" | "starting" | "listening" | "transcribing";

export interface VoiceState {
  phase: VoicePhase;
  startedAt: number;
  level: number;
  /** The last transcript and where it went. */
  last: { text: string; language: SpokenLanguage; engine: string; hub: string; went: string; tookMs: number } | undefined;
  /** Why the last attempt did nothing, in plain words. */
  problem: string | undefined;
}

/** Handles a spoken approval command while the approvals panel is open; returns what happened. */
export type ApprovalVoiceHandler = (command: "allow" | "deny") => string;

const MIN_MS = 300;

function withTimeout<T>(ms: number, message: string, promise: Promise<T>): Promise<T> {
  return Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), ms))]);
}
const encoder = new TextEncoder();

/**
 * Voice in the client (ADR-0009): push-to-talk capture, where the transcript goes, and read-back of
 * live events from every hub.
 */
export function createVoice(hubs: HubList) {
  const { settings, update } = createVoiceSettings();
  const speaker = createSpeaker();
  const [state, setState] = createStore<VoiceState>({ phase: "idle", startedAt: 0, level: 0, last: undefined, problem: undefined });
  let recorder: Recorder | undefined;
  let meter: number | undefined;
  let releasedEarly = false;
  let approvalHandler: ApprovalVoiceHandler | undefined;

  const stopReading = hubs.onEvent((hub, event, ctx) => {
    const after = hub.state.sessions[event.sessionId];
    notifyInBackground(event, { ...ctx, after });
    const u = utteranceFor(event, { ...ctx, after, settings, quietHours: hub.state.hub?.voice?.quietHours, now: new Date() });
    if (!u) return;
    const viaHub = settings.readWith === "hub" && hub.state.hub?.voice?.tts ? (text: string, lang: SpokenLanguage) => hub.actions.voiceSpeak(text, lang) : undefined;
    speaker.say({ text: u.text, lang: u.lang, viaHub });
  });
  onCleanup(stopReading);

  /** Approvals waiting for a person, as system notifications, while the window is hidden or unfocused. */
  function notifyInBackground(event: Parameters<typeof utteranceFor>[0], ctx: { before: SessionSummary | undefined; after: SessionSummary | undefined; approval: Parameters<typeof utteranceFor>[1]["approval"] }): void {
    if (!settings.notify || typeof Notification === "undefined" || Notification.permission !== "granted") return;
    if (!document.hidden && document.hasFocus()) return;
    const u = utteranceFor(event, { ...ctx, settings: { ...settings, muted: false, approvals: true, finished: false, speech: false }, now: new Date() });
    if (u?.kind !== "approval") return;
    const n = new Notification("Loom", { body: u.text, tag: `loom-approval-${event.sessionId}` });
    n.onclick = () => window.focus();
  }

  /** Where dictation goes: the focused session or the active hub's Cockpit. */
  function target(): { hub: Hub; session: SessionSummary } | undefined {
    const active = hubs.active();
    if (!active) return undefined;
    const s = active.hub.state;
    const focused = s.screen.kind === "session" && s.selected ? s.sessions[s.selected] : undefined;
    const cockpit = Object.values(s.sessions).find((x) => x.cockpit && !x.archived);
    const session = settings.target === "cockpit" ? (cockpit ?? focused) : (focused ?? cockpit);
    return session ? { hub: active.hub, session } : undefined;
  }

  /** The hub that recognizes speech: the target's, else the active one, else any connected hub that can. */
  function recognizer(preferred: Hub | undefined): ListedHub | undefined {
    const able = (h: ListedHub) => h.hub.state.status.kind === "open" && h.hub.state.hub?.voice?.stt !== undefined;
    const list = hubs.hubs();
    return list.find((h) => h.hub === preferred && able(h)) ?? list.find((h) => h === hubs.active() && able(h)) ?? list.find(able);
  }

  async function press(): Promise<void> {
    if (state.phase !== "idle") return;
    speaker.stop();
    const unavailable = Recorder.unavailableReason();
    if (unavailable) return void setState({ problem: unavailable });
    if (!recognizer(target()?.hub)) return void setState({ problem: "No connected hub recognizes speech. See Voice in docs/dev.md." });
    releasedEarly = false;
    setState({ phase: "starting", problem: undefined, level: 0 });
    recorder = new Recorder();
    try {
      await recorder.start();
    } catch (err) {
      recorder = undefined;
      setState({ phase: "idle", problem: err instanceof DOMException && err.name === "NotAllowedError" ? "Microphone permission was refused." : `Cannot use the microphone: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    setState({ phase: "listening", startedAt: Date.now() });
    const tick = () => {
      if (state.phase !== "listening" || !recorder) return;
      setState("level", recorder.level());
      meter = requestAnimationFrame(tick);
    };
    meter = requestAnimationFrame(tick);
    if (releasedEarly) void release();
  }

  async function release(): Promise<void> {
    if (state.phase === "starting") {
      releasedEarly = true;
      return;
    }
    if (state.phase !== "listening" || !recorder) return;
    if (meter !== undefined) cancelAnimationFrame(meter);
    const rec = recorder;
    recorder = undefined;
    if (Date.now() - state.startedAt < MIN_MS) {
      rec.cancel();
      return void setState({ phase: "idle", level: 0, problem: "Hold the button while you speak." });
    }
    setState({ phase: "transcribing", level: 0 });
    try {
      const clip = await rec.stop();
      if (clip.loudness < 0.002) throw new Error("Nothing was heard. Is the microphone muted?");
      const dest = target();
      const via = recognizer(dest?.hub);
      if (!via) throw new Error("No connected hub recognizes speech.");
      const result = await withTimeout(90_000, "speech recognition took too long", via.hub.actions.voiceTranscribe(
        toBase64(clip.wav),
        settings.dictation === "auto" ? undefined : settings.dictation,
        approvalHandler ? "Allow. Deny. Permitir. Negar." : undefined,
      ));
      const text = cleanTranscript(result.text);
      const went = deliver(text, dest);
      setState({
        phase: "idle",
        last: { text, language: result.language, engine: result.engine, hub: via.hub.state.hub?.name ?? "hub", went, tookMs: result.tookMs },
      });
    } catch (err) {
      setState({ phase: "idle", problem: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Puts a transcript where it belongs and says where that was. */
  function deliver(transcript: string, dest: { hub: Hub; session: SessionSummary } | undefined): string {
    if (!transcript.trim()) return "nothing recognized";
    if (approvalHandler) {
      const command = approvalCommand(transcript);
      return command ? approvalHandler(command) : "not an approval command (say allow or deny)";
    }
    if (!dest) return "no session to put it in";
    const { hub, session } = dest;
    const { text, send } = parseDictation(transcript, settings.autoSend);
    if (session.adapter === "pty") {
      if (text) hub.actions.terminalInput(session.id, encoder.encode(text));
      if (send) hub.actions.terminalInput(session.id, encoder.encode("\r"));
      return `${session.name}'s terminal${send ? ", sent" : ""}`;
    }
    if (send) {
      const draft = hub.state.drafts[session.id]?.trim();
      const message = draft ? `${draft} ${text}`.trim() : text;
      hub.actions.setDraft(session.id, "");
      if (message) void hub.actions.send(session.id, message, "voice");
      return `${session.name}, sent`;
    }
    if (hub.state.screen.kind !== "session" || hub.state.selected !== session.id) void hub.actions.open(session.id);
    if (text) hub.actions.appendDraft(session.id, text);
    return `${session.name}'s message box`;
  }

  return {
    state,
    settings,
    update,
    speaker,
    press,
    release,
    dismiss: () => setState({ problem: undefined }),
    /** The approvals panel takes spoken commands while it is open. */
    useApprovalCommands(handler: ApprovalVoiceHandler): void {
      approvalHandler = handler;
      onCleanup(() => {
        if (approvalHandler === handler) approvalHandler = undefined;
      });
    },
    /** Hub speech engines on connected hubs, for the settings. */
    hubVoice: () => hubs.hubs().some((h) => h.hub.state.hub?.voice?.tts !== undefined),
  };
}

export type Voice = ReturnType<typeof createVoice>;

export const VoiceContext = createContext<Voice>();

export function useVoice(): Voice {
  const v = useContext(VoiceContext);
  if (!v) throw new Error("useVoice must be used inside a VoiceContext provider");
  return v;
}
