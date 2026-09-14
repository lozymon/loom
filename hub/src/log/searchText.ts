import type { SessionEvent } from "@loom/protocol";

const INPUT_KEYS = ["command", "file_path", "path", "pattern", "url", "query", "description", "prompt", "subject", "title"];
const MAX_TEXT = 8000;

/**
 * The words of an event worth finding later (M12 history search): what people and sessions said,
 * what tools were asked to do, approvals, speech, and errors. Not tool output, not thinking.
 */
export function searchableText(event: SessionEvent): string | undefined {
  let text: string | undefined;
  switch (event.type) {
    case "user.message":
    case "assistant.text":
    case "speech":
      text = event.text;
      break;
    case "tool.use": {
      const input = event.input as Record<string, unknown>;
      const parts = INPUT_KEYS.map((k) => input[k]).filter((v): v is string => typeof v === "string");
      text = [event.toolName, ...parts].join(" ");
      break;
    }
    case "approval.requested":
      text = event.request.kind === "question" ? event.request.questions.map((q) => q.question).join(" ") : event.request.summary;
      break;
    case "error":
      text = event.message;
      break;
    case "session.renamed":
      text = event.name;
      break;
    default:
      return undefined;
  }
  const trimmed = text?.trim();
  return trimmed ? trimmed.slice(0, MAX_TEXT) : undefined;
}

/**
 * A person's search words as an FTS5 query: every word must appear, each as a prefix, with FTS
 * syntax characters taken out so a query can never be an error or an injection.
 */
export function ftsQuery(query: string): string | undefined {
  const words = query
    .normalize("NFKC")
    .split(/[\s"'`^*():{}[\]\-+~]+/u)
    .map((w) => w.replace(/[^\p{L}\p{N}_./@#$%&=]/gu, ""))
    .filter((w) => w.length > 0)
    .slice(0, 12);
  return words.length ? words.map((w) => `"${w}"*`).join(" ") : undefined;
}
