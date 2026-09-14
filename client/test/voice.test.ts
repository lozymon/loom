import type { ApprovalRequest, HubEvent, SessionEvent, SessionSummary } from "@loom/protocol";
import { describe, expect, it } from "vitest";
import { approvalCommand, cleanTranscript, parseDictation } from "../src/voice/commands.ts";
import { type ReadbackSettings, utteranceFor } from "../src/voice/readback.ts";
import { resample } from "../src/voice/recorder.ts";
import { encodeWav, rms } from "../src/voice/wav.ts";

describe("encodeWav", () => {
  it("writes a 16 kHz mono 16-bit header and clamps samples", () => {
    const wav = encodeWav(new Float32Array([0, 1, -1, 2]), 16_000);
    const view = new DataView(wav.buffer);
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe("RIFF");
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(40, true)).toBe(8);
    expect([0, 1, 2, 3].map((i) => view.getInt16(44 + i * 2, true))).toEqual([0, 32767, -32768, 32767]);
    expect(rms(new Float32Array([0.5, -0.5]))).toBe(0.5);
  });
});

describe("resample", () => {
  it("downsamples by averaging and upsamples by interpolating", () => {
    const ramp = Float32Array.from({ length: 48 }, (_, i) => i);
    const down = resample(ramp, 48_000, 16_000);
    expect(down.length).toBe(16);
    expect(Array.from(down.slice(0, 3))).toEqual([1, 4, 7]);
    expect(Array.from(resample(new Float32Array([0, 1]), 8_000, 16_000))).toEqual([0, 0.5, 1, 1]);
    expect(resample(new Float32Array([0.5, 0.25]), 16_000)).toEqual(new Float32Array([0.5, 0.25]));
  });
});

describe("cleanTranscript", () => {
  it("drops sound tags and keeps words", () => {
    expect(cleanTranscript("[Paper rustling]")).toBe("");
    expect(cleanTranscript(" [BLANK_AUDIO] ")).toBe("");
    expect(cleanTranscript("(music) run the tests *cough* now")).toBe("run the tests now");
  });
});

describe("parseDictation", () => {
  it("sends only with auto-send and a trailing send word", () => {
    expect(parseDictation("run the tests, send.", true)).toEqual({ text: "run the tests", send: true });
    expect(parseDictation("Rode os testes enviar", true)).toEqual({ text: "Rode os testes", send: true });
    expect(parseDictation("run the tests, send.", false)).toEqual({ text: "run the tests, send.", send: false });
    expect(parseDictation("resend the report", true)).toEqual({ text: "resend the report", send: false });
    expect(parseDictation("Send.", true)).toEqual({ text: "", send: false });
  });
});

describe("approvalCommand", () => {
  it("accepts the command words alone and nothing longer", () => {
    for (const w of ["Allow.", "allow it", "Permitir!", "sim"]) expect(approvalCommand(w), w).toBe("allow");
    for (const w of ["Deny", "Negar.", "não"]) expect(approvalCommand(w), w).toBe("deny");
    for (const w of ["allow me to explain", "", "maybe"]) expect(approvalCommand(w), w).toBeUndefined();
  });
});

const settings: ReadbackSettings = { muted: false, approvals: true, finished: true, speech: true, phrases: "en" };
const summary = (state: SessionSummary["state"]) => ({ id: "s1", name: "Faye", state }) as SessionSummary;
const ev = (event: SessionEvent): HubEvent => ({ seq: 1, at: 1, sessionId: "s1", event }) as HubEvent;
const request = (steward?: ApprovalRequest["steward"]): ApprovalRequest =>
  ({ id: "a1", sessionId: "s1", requestedAt: 1, summary: "Run: git push", kind: "permission", toolName: "Bash", input: {}, canAlwaysAllow: true, ...(steward ? { steward } : {}) }) as ApprovalRequest;
const now = new Date(2026, 8, 13, 12, 0);
const say = (e: HubEvent, over: Partial<Parameters<typeof utteranceFor>[1]> = {}) =>
  utteranceFor(e, { before: summary("working"), after: summary("idle"), settings, now, ...over })?.text;

describe("utteranceFor", () => {
  it("reads approvals that wait for a person, once", () => {
    expect(say(ev({ type: "approval.requested", request: request() }))).toBe("Faye needs approval: Run: git push");
    const reviewing = request({ status: "reviewing", mode: "decide" });
    expect(say(ev({ type: "approval.requested", request: reviewing }))).toBeUndefined();
    expect(say(ev({ type: "approval.updated", approvalId: "a1", steward: { status: "done", mode: "decide", decision: "allow", confidence: 0.99 } }), { approval: reviewing })).toBeUndefined();
    expect(say(ev({ type: "approval.updated", approvalId: "a1", steward: { status: "done", mode: "decide", decision: "escalate" } }), { approval: reviewing })).toBe("Faye needs approval: Run: git push");
    expect(say(ev({ type: "approval.updated", approvalId: "a1", steward: { status: "done", mode: "recommend", decision: "allow" } }), { approval: reviewing, settings: { ...settings, phrases: "pt" } })).toBe("Faye precisa de aprovação: Run: git push");
  });

  it("reads finishing and failing, what sessions say, and never tool output", () => {
    expect(say(ev({ type: "session.state", state: "idle", provenance: "pushed" }))).toBe("Faye is done.");
    expect(say(ev({ type: "session.state", state: "idle", provenance: "pushed" }), { before: summary("blocked") })).toBeUndefined();
    expect(say(ev({ type: "session.ended", outcome: "error", message: "auth expired" }))).toBe("Faye failed: auth expired");
    expect(utteranceFor(ev({ type: "speech", text: "Terminei", lang: "pt" }), { before: undefined, after: summary("idle"), settings, now })).toEqual({ text: "Terminei", lang: "pt", kind: "speech" });
    expect(say(ev({ type: "tool.result", toolUseId: "t", isError: false, preview: "secret output" } as SessionEvent))).toBeUndefined();
  });

  it("stays quiet when muted, in quiet hours, or when a class is off", () => {
    const e = ev({ type: "speech", text: "hello" });
    expect(say(e, { settings: { ...settings, muted: true } })).toBeUndefined();
    expect(say(e, { settings: { ...settings, speech: false } })).toBeUndefined();
    expect(say(e, { quietHours: { from: "11:00", to: "13:00" } })).toBeUndefined();
    expect(say(e, { quietHours: { from: "13:00", to: "11:00" } })).toBe("hello");
  });
});

import { snippetParts } from "../src/lib/snippet.ts";

describe("snippetParts", () => {
  it("splits at the hub's match markers", () => {
    const s = `run the ${String.fromCharCode(1)}tests${String.fromCharCode(2)} now`;
    expect(snippetParts(s)).toEqual([
      { text: "run the ", hit: false },
      { text: "tests", hit: true },
      { text: " now", hit: false },
    ]);
  });
});
