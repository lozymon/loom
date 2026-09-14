import { type ApprovalRequest, type HubEvent, waitsForPerson } from "@loom/protocol";
import type { PushPayload } from "./pushService.ts";

export interface NotifierDeps {
  subscribe(listener: (e: HubEvent) => void): () => void;
  pending(approvalId: string): ApprovalRequest | undefined;
  sessionName(sessionId: string): string;
  send(payload: PushPayload): Promise<unknown>;
  delayMs: number;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** What a notification says: the session and the one-line summary, never the tool input itself. */
export function approvalPayload(request: ApprovalRequest, sessionName: string): PushPayload {
  const body =
    request.kind === "question"
      ? `${sessionName} has a question: ${request.questions[0]?.question ?? ""}`
      : `${sessionName} needs approval: ${request.summary}`;
  return { title: "Loom", body: oneLine(body, 180), tag: `approval-${request.id}`, url: `/#approval=${encodeURIComponent(request.id)}` };
}

/**
 * Pushes approvals that still wait for a person after a delay (M10), so handling one at the desk does
 * not buzz the phone. Resolved or cancelled approvals never push.
 */
export class ApprovalNotifier {
  #deps: NotifierDeps;
  #timers = new Map<string, NodeJS.Timeout>();
  #stop: () => void;

  constructor(deps: NotifierDeps) {
    this.#deps = deps;
    this.#stop = deps.subscribe((e) => this.#on(e));
  }

  #on(e: HubEvent): void {
    const ev = e.event;
    if (ev.type === "approval.requested") {
      if (waitsForPerson(ev.request)) this.#schedule(ev.request.id);
    } else if (ev.type === "approval.updated") {
      const request = this.#deps.pending(ev.approvalId);
      if (request && waitsForPerson(request, ev.steward)) this.#schedule(ev.approvalId);
    } else if (ev.type === "approval.resolved") {
      this.#cancel(ev.approvalId);
    }
  }

  #schedule(approvalId: string): void {
    if (this.#timers.has(approvalId)) return;
    const timer = setTimeout(() => {
      this.#timers.delete(approvalId);
      const request = this.#deps.pending(approvalId);
      if (!request || !waitsForPerson(request)) return;
      this.#deps.send(approvalPayload(request, this.#deps.sessionName(request.sessionId))).catch((err: unknown) => {
        console.error("approval push failed:", err instanceof Error ? err.message : err);
      });
    }, this.#deps.delayMs);
    timer.unref();
    this.#timers.set(approvalId, timer);
  }

  #cancel(approvalId: string): void {
    clearTimeout(this.#timers.get(approvalId));
    this.#timers.delete(approvalId);
  }

  close(): void {
    this.#stop();
    for (const t of this.#timers.values()) clearTimeout(t);
    this.#timers.clear();
  }
}
