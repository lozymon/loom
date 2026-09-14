import { type ApprovalRequest, type HubEvent, inQuietHours, waitsForPerson, type QuietHours, type SessionSummary, type SpokenLanguage } from "@loom/protocol";

export interface ReadbackSettings {
  muted: boolean;
  approvals: boolean;
  finished: boolean;
  speech: boolean;
  /** Language of Loom's own phrases ("needs approval"). What sessions say keeps its own language. */
  phrases: SpokenLanguage;
}

export interface Utterance {
  text: string;
  lang?: SpokenLanguage;
  /** Speech from a session, so a newer one can wait its turn rather than cut in. */
  kind: "approval" | "finished" | "speech";
}

const PHRASES = {
  en: {
    approval: (name: string, what: string) => `${name} needs approval: ${what}`,
    question: (name: string, q: string) => `${name} has a question: ${q}`,
    done: (name: string) => `${name} is done.`,
    failed: (name: string, why?: string) => `${name} failed${why ? `: ${why}` : "."}`,
  },
  pt: {
    approval: (name: string, what: string) => `${name} precisa de aprovação: ${what}`,
    question: (name: string, q: string) => `${name} tem uma pergunta: ${q}`,
    done: (name: string) => `${name} terminou.`,
    failed: (name: string, why?: string) => `${name} falhou${why ? `: ${why}` : "."}`,
  },
};

function approvalText(request: ApprovalRequest, name: string, lang: SpokenLanguage): string {
  const p = PHRASES[lang];
  if (request.kind === "question") return p.question(name, request.questions[0]?.question ?? "");
  return p.approval(name, request.summary);
}

/**
 * What to say for one live event, if anything (ADR-0009): approvals that wait for a person, sessions
 * finishing or failing, and what sessions say with `speak`. Never tool output. `before` is the session
 * summary before the event; `approval` is the pending request an `approval.updated` refers to.
 */
export function utteranceFor(
  e: HubEvent,
  ctx: { before: SessionSummary | undefined; after: SessionSummary | undefined; approval?: ApprovalRequest | undefined; settings: ReadbackSettings; quietHours?: QuietHours | undefined; now: Date },
): Utterance | undefined {
  const { settings } = ctx;
  if (settings.muted || inQuietHours(ctx.quietHours, ctx.now)) return undefined;
  const name = ctx.after?.name ?? ctx.before?.name ?? "A session";
  const lang = settings.phrases;
  const ev = e.event;
  switch (ev.type) {
    case "speech":
      return settings.speech ? { text: ev.text, ...(ev.lang ? { lang: ev.lang } : {}), kind: "speech" } : undefined;
    case "approval.requested":
      return settings.approvals && waitsForPerson(ev.request) ? { text: approvalText(ev.request, name, lang), lang, kind: "approval" } : undefined;
    case "approval.updated": {
      if (!settings.approvals || !ctx.approval || ev.steward.status === "reviewing") return undefined;
      // Said once: when the review ends and a person is still needed.
      return waitsForPerson(ctx.approval, ev.steward) ? { text: approvalText(ctx.approval, name, lang), lang, kind: "approval" } : undefined;
    }
    case "session.state": {
      if (!settings.finished || !ctx.before) return undefined;
      if (ev.state === "idle" && ctx.before.state === "working") return { text: PHRASES[lang].done(name), lang, kind: "finished" };
      if (ev.state === "error" && ctx.before.state !== "error") return { text: PHRASES[lang].failed(name), lang, kind: "finished" };
      return undefined;
    }
    case "session.ended":
      return settings.finished && ev.outcome === "error" ? { text: PHRASES[lang].failed(name, ev.message), lang, kind: "finished" } : undefined;
    default:
      return undefined;
  }
}
