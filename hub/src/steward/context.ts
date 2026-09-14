import type { ApprovalRequest, HubEvent, SessionSummary } from "@loom/protocol";
import { git } from "../git/git.ts";
import type { ReviewInput } from "./types.ts";

function brief(input: Record<string, unknown>): string {
  const v = input.command ?? input.file_path ?? input.url ?? input.pattern ?? input.description;
  return typeof v === "string" ? v.replace(/\s+/g, " ").slice(0, 200) : "";
}

function short(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** A compact, oldest-first account of what the session has been doing. */
export function describeActivity(events: readonly HubEvent[]): string[] {
  const lines: string[] = [];
  for (const { event: ev } of events) {
    switch (ev.type) {
      case "user.message":
        lines.push(`${ev.from === "human" ? "developer" : ev.from}: ${short(ev.text, 600)}`);
        break;
      case "assistant.text":
        if (!ev.parentToolUseId) lines.push(`agent: ${short(ev.text, 400)}`);
        break;
      case "tool.use":
        lines.push(`agent used ${ev.toolName}${brief(ev.input) ? `: ${brief(ev.input)}` : ""}`);
        break;
      case "tool.result":
        if (ev.isError) lines.push(`tool error: ${short(ev.preview, 200)}`);
        break;
      case "approval.resolved":
        lines.push(`approval ${ev.decision.type} by ${ev.resolver}${ev.detail ? ` (${short(ev.detail, 160)})` : ""}`);
        break;
      default:
        break;
    }
  }
  return lines.slice(-40);
}

export async function diffStat(cwd: string): Promise<string | undefined> {
  try {
    const out = await git(["diff", "--stat", "HEAD"], cwd, 3000);
    return out.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function buildReviewInput(parts: {
  request: Extract<ApprovalRequest, { kind: "permission" }>;
  session: SessionSummary;
  events: readonly HubEvent[];
  card?: { title: string; prompt: string } | undefined;
  rules: { deny: string[]; ask: string[] };
  diffStat?: string | undefined;
}): ReviewInput {
  const { session } = parts;
  return {
    request: parts.request,
    session: {
      name: session.name,
      cwd: session.cwd,
      projectRoot: session.projectRoot,
      level: session.level,
      adapter: session.adapter,
      ...(session.branch !== undefined ? { branch: session.branch } : {}),
      ...(session.agent !== undefined ? { agent: session.agent } : {}),
      ...(session.model !== undefined ? { model: session.model } : {}),
    },
    card: parts.card,
    activity: describeActivity(parts.events),
    rules: parts.rules,
    diffStat: parts.diffStat,
  };
}
