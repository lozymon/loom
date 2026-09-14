import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { EngineLoaded, SessionEvent } from "@loom/protocol";

const PREVIEW_MAX = 2000;

export interface MapState {
  /** Session cost before this engine process started. */
  costBase: number;
  /** Last engine identity published, to avoid repeating it on every turn's init frame. */
  lastEngineKey?: string;
}

function preview(content: unknown): string {
  let text: string;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    text = content
      .map((b: { type?: string; text?: string }) => (b?.type === "text" && typeof b.text === "string" ? b.text : `[${b?.type ?? "content"}]`))
      .join("\n");
  } else text = content === undefined ? "" : JSON.stringify(content);
  return text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX)}…` : text;
}

function parentOf(msg: { parent_tool_use_id: string | null }): { parentToolUseId?: string } {
  return msg.parent_tool_use_id ? { parentToolUseId: msg.parent_tool_use_id } : {};
}

/**
 * Translates one SDK message into normalized session events (ADR-0004). Pure apart from `state`.
 * Anything Loom does not show yet maps to nothing.
 */
export function mapMessage(msg: SDKMessage, state: MapState): SessionEvent[] {
  switch (msg.type) {
    case "system": {
      if (msg.subtype !== "init") return [];
      const loaded: EngineLoaded = {
        plugins: msg.plugins?.map((p) => p.name) ?? [],
        mcpServers: msg.mcp_servers?.map((s) => ({ name: s.name, status: s.status })) ?? [],
      };
      const key = JSON.stringify([msg.session_id, msg.model, loaded]);
      if (key === state.lastEngineKey) return [];
      state.lastEngineKey = key;
      return [{ type: "session.engine", engineSessionId: msg.session_id, model: msg.model, loaded }];
    }

    case "assistant": {
      const out: SessionEvent[] = [];
      const content = msg.message.content as unknown as Array<Record<string, unknown>>;
      content.forEach((block, i) => {
        const messageId = `${msg.message.id}:${i}`;
        if (block.type === "text" && typeof block.text === "string" && block.text !== "") {
          out.push({ type: "assistant.text", messageId, text: block.text, ...parentOf(msg) });
        } else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking !== "") {
          out.push({ type: "assistant.thinking", messageId, text: block.thinking });
        } else if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
          out.push({
            type: "tool.use",
            toolUseId: block.id,
            toolName: block.name,
            input: (block.input ?? {}) as Record<string, unknown>,
            ...parentOf(msg),
          });
        }
      });
      if (msg.error) out.push({ type: "error", message: `Claude reported an error: ${String(msg.error)}` });
      return out;
    }

    case "user": {
      if ("isReplay" in msg && msg.isReplay) return [];
      const content = msg.message.content;
      if (!Array.isArray(content)) return [];
      return content
        .filter((b): b is Extract<typeof b, { type: "tool_result" }> => (b as { type?: string }).type === "tool_result")
        .map((b) => ({
          type: "tool.result" as const,
          toolUseId: b.tool_use_id,
          isError: b.is_error === true,
          preview: preview(b.content),
        }));
    }

    case "result": {
      const out: SessionEvent[] = [{ type: "cost.update", costUsd: state.costBase + Math.max(0, msg.total_cost_usd) }];
      if (msg.subtype !== "success") {
        const detail = msg.errors?.length ? msg.errors.join("; ") : msg.subtype;
        out.push({ type: "error", message: `Turn ended with ${msg.subtype}: ${detail}` });
      } else if (msg.is_error) {
        out.push({ type: "error", message: msg.result || "Turn ended with an error" });
      }
      out.push({ type: "session.state", state: "idle", provenance: "pushed" });
      return out;
    }

    default:
      return [];
  }
}
