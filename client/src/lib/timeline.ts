import type { ApprovalDecision, ApprovalRequest, HubEvent, Resolver, RuleRef, StewardReview, UserMessageSource } from "@loom/protocol";

export type TimelineItem =
  | { kind: "user"; key: string; seq: number; at: number; text: string; from: UserMessageSource }
  | { kind: "assistant"; key: string; seq: number; at: number; text: string; nested: boolean }
  | { kind: "thinking"; key: string; seq: number; at: number; text: string }
  | {
      kind: "tool";
      key: string;
      seq: number;
      at: number;
      toolUseId: string;
      toolName: string;
      input: Record<string, unknown>;
      nested: boolean;
      result?: { isError: boolean; preview: string };
    }
  | {
      kind: "approval";
      key: string;
      seq: number;
      at: number;
      request: ApprovalRequest;
      resolution?: { decision: ApprovalDecision; resolver: Resolver; detail?: string; rule?: RuleRef };
      steward?: StewardReview;
      overridden?: string;
    }
  | { kind: "error"; key: string; seq: number; at: number; message: string }
  | { kind: "notice"; key: string; seq: number; at: number; text: string }
  | { kind: "speech"; key: string; seq: number; at: number; text: string };

/**
 * Folds a session's events into what the chat view shows. Tool results attach to their tool use;
 * approval resolutions attach to their request. Pure, so it is tested without a browser.
 */
export function buildTimeline(events: readonly HubEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  const tools = new Map<string, Extract<TimelineItem, { kind: "tool" }>>();
  const approvals = new Map<string, Extract<TimelineItem, { kind: "approval" }>>();

  for (const { seq, at, event: ev } of events) {
    const key = String(seq);
    switch (ev.type) {
      case "user.message":
        items.push({ kind: "user", key, seq, at, text: ev.text, from: ev.from });
        break;
      case "assistant.text":
        items.push({ kind: "assistant", key, seq, at, text: ev.text, nested: ev.parentToolUseId !== undefined });
        break;
      case "assistant.thinking":
        items.push({ kind: "thinking", key, seq, at, text: ev.text });
        break;
      case "tool.use": {
        const item = {
          kind: "tool" as const,
          key,
          seq,
          at,
          toolUseId: ev.toolUseId,
          toolName: ev.toolName,
          input: ev.input,
          nested: ev.parentToolUseId !== undefined,
        };
        tools.set(ev.toolUseId, item);
        items.push(item);
        break;
      }
      case "tool.result": {
        const tool = tools.get(ev.toolUseId);
        if (tool) tool.result = { isError: ev.isError, preview: ev.preview };
        break;
      }
      case "approval.requested": {
        const item: Extract<TimelineItem, { kind: "approval" }> = {
          kind: "approval",
          key,
          seq,
          at,
          request: ev.request,
          ...(ev.request.steward ? { steward: ev.request.steward } : {}),
        };
        approvals.set(ev.request.id, item);
        items.push(item);
        break;
      }
      case "approval.updated": {
        const item = approvals.get(ev.approvalId);
        if (item) item.steward = ev.steward;
        break;
      }
      case "approval.overridden": {
        const item = approvals.get(ev.approvalId);
        if (item) item.overridden = ev.note;
        break;
      }
      case "approval.resolved": {
        const item = approvals.get(ev.approvalId);
        if (item) {
          item.resolution = {
            decision: ev.decision,
            resolver: ev.resolver,
            ...(ev.detail !== undefined ? { detail: ev.detail } : {}),
            ...(ev.rule !== undefined ? { rule: ev.rule } : {}),
          };
        }
        break;
      }
      case "error":
        items.push({ kind: "error", key, seq, at, message: ev.message });
        break;
      case "speech":
        items.push({ kind: "speech", key, seq, at, text: ev.text });
        break;
      case "session.level":
        items.push({ kind: "notice", key, seq, at, text: `Permission level set to ${ev.level} by ${ev.by === "cockpit" ? "the Cockpit" : ev.by === "human" ? "you" : "the hub"}` });
        break;
      case "session.ended":
        items.push({ kind: "notice", key, seq, at, text: ev.message ? `Session ended: ${ev.message}` : "Session ended" });
        break;
      default:
        break;
    }
  }
  return items;
}

/** Merges two seq-ordered event lists, dropping duplicates. */
export function mergeEvents(a: readonly HubEvent[], b: readonly HubEvent[]): HubEvent[] {
  const bySeq = new Map<number, HubEvent>();
  for (const e of a) bySeq.set(e.seq, e);
  for (const e of b) bySeq.set(e.seq, e);
  return [...bySeq.values()].sort((x, y) => x.seq - y.seq);
}

/** Short text for a decision, e.g. on a resolved approval line. */
export function describeResolution(decision: ApprovalDecision, resolver: Resolver, rule?: RuleRef): string {
  if (resolver === "rule" && rule) {
    const where = rule.scope === "hub" ? "hub policy" : "project policy";
    return `${decision.type === "deny" ? "Denied" : "Allowed"} by rule ${rule.rule} · ${where}`;
  }
  if (resolver === "timeout") return decision.type === "deny" ? `Timed out: ${decision.message}` : "Timed out";
  if (resolver === "steward") return `${decision.type === "deny" ? "Denied" : "Allowed"} by the Steward`;
  if (resolver === "cockpit") return `${decision.type === "deny" ? "Denied" : decision.type === "answer" ? "Answered" : "Allowed"} by the Cockpit`;
  const who = resolver === "human" ? "you" : resolver;
  switch (decision.type) {
    case "allow":
      return `Allowed by ${who}`;
    case "allow-rule":
      return `Allowed by ${who}, saved rule ${decision.rule} to ${decision.scope} policy`;
    case "allow-always":
      return `Always allowed by ${who}`;
    case "allow-edited":
      return `Allowed with changes by ${who}`;
    case "deny":
      return resolver === "hub" ? `Cancelled: ${decision.message}` : `Denied by ${who}${decision.message ? `: ${decision.message}` : ""}`;
    case "answer":
      return `Answered by ${who}: ${Object.values(decision.answers).flat().join(", ")}`;
    case "reply":
      return `Replied by ${who}: ${decision.text}`;
  }
}
