/** What a spoken transcript means, before it goes anywhere. Pure, so it is tested without a browser. */

/** Drops whisper's sound tags ("[Paper rustling]", "[BLANK_AUDIO]", "(music)"); a clip of only tags is empty. */
export function cleanTranscript(text: string): string {
  return text
    .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const SEND_WORDS = ["send", "send it", "enviar", "envia", "envie", "manda"];

/** Strips a trailing "send" / "enviar" when auto-send is on, and says whether to send. */
export function parseDictation(transcript: string, autoSend: boolean): { text: string; send: boolean } {
  const text = transcript.trim();
  if (!autoSend) return { text, send: false };
  const lower = text.toLowerCase().replace(/[.!?,;:\s]+$/u, "");
  for (const word of SEND_WORDS) {
    if (lower === word) return { text: "", send: false };
    if (lower.endsWith(` ${word}`) || lower.endsWith(`, ${word}`)) {
      return { text: text.slice(0, lower.length - word.length).replace(/[\s,.;:]+$/u, ""), send: true };
    }
  }
  return { text, send: false };
}

const ALLOW = ["allow", "allow it", "approve", "yes", "permitir", "permite", "aprovar", "aprova", "sim"];
const DENY = ["deny", "deny it", "reject", "no", "negar", "nega", "rejeitar", "não", "nao"];

/** "allow" / "permitir" or "deny" / "negar" and close variants, and nothing else. */
export function approvalCommand(transcript: string): "allow" | "deny" | undefined {
  const words = transcript
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
  if (ALLOW.includes(words)) return "allow";
  if (DENY.includes(words)) return "deny";
  return undefined;
}
