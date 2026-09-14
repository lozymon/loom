import type { ApprovalDecision, ApprovalId, ApprovalRequest, Resolver, RuleRef, SessionEvent, SessionId, StewardReview } from "@loom/protocol";
import { HubError } from "../errors.ts";
import type { NewApproval } from "./adapter.ts";

interface Waiter {
  request: ApprovalRequest;
  resolve: (decision: ApprovalDecision) => void;
  detach: () => void;
}

export interface RequestOptions {
  signal?: AbortSignal | undefined;
  /** Deny automatically after this long without a decision. */
  timeoutMs?: number | undefined;
  /** Replaces the automatic deny when the timeout runs out; must resolve the approval itself. */
  onTimeout?: ((request: ApprovalRequest) => void) | undefined;
  /** Called once the request is open and visible, with its id. */
  onOpen?: ((request: ApprovalRequest) => void) | undefined;
}

export interface BrokerDeps {
  emit(sessionId: SessionId, event: SessionEvent): void;
  now(): number;
  newId(): string;
}

const ALLOWED: Record<ApprovalRequest["kind"], ReadonlySet<ApprovalDecision["type"]>> = {
  permission: new Set(["allow", "allow-always", "allow-rule", "allow-edited", "deny"]),
  question: new Set(["answer", "reply", "deny"]),
};

/**
 * Holds every open approval until something decides it (ADR-0006). In M1 the only deciders are
 * humans and the hub itself; rules and the Steward plug in ahead of the human in M3 and M5.
 */
export class ApprovalBroker {
  #deps: BrokerDeps;
  #waiting = new Map<ApprovalId, Waiter>();

  constructor(deps: BrokerDeps) {
    this.#deps = deps;
  }

  request(sessionId: SessionId, raw: NewApproval, opts: RequestOptions = {}): Promise<ApprovalDecision> {
    const { signal, timeoutMs, onTimeout, onOpen } = opts;
    const now = this.#deps.now();
    const request = {
      ...raw,
      id: this.#deps.newId(),
      sessionId,
      requestedAt: now,
      ...(timeoutMs !== undefined ? { expiresAt: now + timeoutMs } : {}),
    } as ApprovalRequest;

    return new Promise<ApprovalDecision>((resolve) => {
      const onAbort = () => this.#finish(request.id, cancelled("The request was cancelled by the engine."), "hub");
      const minutes = timeoutMs !== undefined ? Math.round(timeoutMs / 60000) : 0;
      const timer =
        timeoutMs !== undefined
          ? setTimeout(() => {
              if (onTimeout && this.#waiting.has(request.id)) {
                onTimeout(this.#waiting.get(request.id)!.request);
                return;
              }
              const message = `No decision within ${minutes} minute${minutes === 1 ? "" : "s"}.`;
              this.#finish(request.id, cancelled(message), "timeout", message);
            }, timeoutMs)
          : undefined;
      timer?.unref?.();
      const detach = () => {
        signal?.removeEventListener("abort", onAbort);
        if (timer) clearTimeout(timer);
      };
      this.#waiting.set(request.id, { request, resolve, detach });
      this.#deps.emit(sessionId, { type: "approval.requested", request });
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
      if (this.#waiting.has(request.id)) onOpen?.(request);
    });
  }

  /**
   * Records an approval that a rule already decided: logged as requested and resolved at once, so the
   * audit trail shows it like any other, but nobody is asked (ADR-0006 stage 1).
   */
  resolveNow(sessionId: SessionId, raw: NewApproval, decision: ApprovalDecision, resolver: Resolver, detail: string, rule?: RuleRef): ApprovalDecision {
    const request = { ...raw, id: this.#deps.newId(), sessionId, requestedAt: this.#deps.now() } as ApprovalRequest;
    this.#deps.emit(sessionId, { type: "approval.requested", request });
    this.#deps.emit(sessionId, {
      type: "approval.resolved",
      approvalId: request.id,
      decision,
      resolver,
      detail,
      ...(rule ? { rule } : {}),
    });
    return decision;
  }

  isOpen(approvalId: ApprovalId): boolean {
    return this.#waiting.has(approvalId);
  }

  /** Attaches a Steward review to an open approval. Ignored if it was already decided. */
  update(approvalId: ApprovalId, steward: StewardReview): void {
    const waiter = this.#waiting.get(approvalId);
    if (!waiter) return;
    waiter.request = { ...waiter.request, steward } as ApprovalRequest;
    this.#deps.emit(waiter.request.sessionId, { type: "approval.updated", approvalId, steward });
  }

  get(approvalId: ApprovalId): ApprovalRequest {
    const waiter = this.#waiting.get(approvalId);
    if (!waiter) throw new HubError("not-found", `no open approval ${approvalId}`);
    return waiter.request;
  }

  /** Throws unless `decision` could be applied to the open approval. */
  check(approvalId: ApprovalId, decision: ApprovalDecision): ApprovalRequest {
    const request = this.get(approvalId);
    if (!ALLOWED[request.kind].has(decision.type)) {
      throw new HubError("invalid", `decision "${decision.type}" does not apply to a ${request.kind} approval`);
    }
    if (request.kind === "permission") {
      if (decision.type === "allow-always" && !request.canAlwaysAllow) {
        throw new HubError("invalid", "this approval does not offer an always-allow rule");
      }
      if ((decision.type === "allow-always" || decision.type === "allow-rule") && request.mustAsk) {
        throw new HubError("invalid", `an ask rule (${request.askRule?.rule ?? "policy"}) requires a decision every time`);
      }
    }
    return request;
  }

  /** Records a decision. Throws `not-found` for unknown or already decided approvals, `invalid` for a mismatched decision. */
  decide(approvalId: ApprovalId, decision: ApprovalDecision, resolver: Resolver, detail?: string, rule?: RuleRef): void {
    this.check(approvalId, decision);
    this.#finish(approvalId, decision, resolver, detail, rule);
  }

  /** Denies every open approval for a session, e.g. when it stops. */
  cancelSession(sessionId: SessionId, reason: string): void {
    for (const [id, waiter] of [...this.#waiting]) {
      if (waiter.request.sessionId === sessionId) this.#finish(id, cancelled(reason), "hub", reason);
    }
  }

  openFor(sessionId: SessionId): ApprovalRequest[] {
    return [...this.#waiting.values()].filter((w) => w.request.sessionId === sessionId).map((w) => w.request);
  }

  #finish(id: ApprovalId, decision: ApprovalDecision, resolver: Resolver, detail?: string, rule?: RuleRef): void {
    const waiter = this.#waiting.get(id);
    if (!waiter) return;
    this.#waiting.delete(id);
    waiter.detach();
    this.#deps.emit(waiter.request.sessionId, {
      type: "approval.resolved",
      approvalId: id,
      decision,
      resolver,
      ...(detail !== undefined ? { detail } : {}),
      ...(rule ? { rule } : {}),
    });
    waiter.resolve(decision);
  }
}

function cancelled(message: string): ApprovalDecision {
  return { type: "deny", message };
}
