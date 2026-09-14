import { detectLanguage, type SpokenLanguage } from "@loom/protocol";
import { HubError } from "../errors.ts";
import type { Transcript } from "./whisper.ts";

type Fetch = typeof fetch;

async function failure(res: Response, service: string): Promise<HubError> {
  const body = (await res.text().catch(() => "")).slice(0, 300);
  if (res.status === 401 || res.status === 403) return new HubError("engine", `${service} rejected the API key`);
  if (res.status === 429) return new HubError("engine", `${service} rate limit reached; try again shortly`);
  return new HubError("engine", `${service} failed (${res.status})${body ? `: ${body}` : ""}`);
}

function languageOf(reported: unknown, text: string): SpokenLanguage {
  const r = typeof reported === "string" ? reported.toLowerCase() : "";
  if (r === "en" || r.startsWith("english")) return "en";
  if (r === "pt" || r.startsWith("portuguese")) return "pt";
  return detectLanguage(text);
}

export interface GroqOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetch?: Fetch;
}

/** Groq's OpenAI-compatible transcription endpoint. The WAV is sent as is. */
export async function groqTranscribe(opts: GroqOptions, wav: Buffer, audioMs: number, language?: SpokenLanguage, prompt?: string): Promise<Transcript> {
  const started = Date.now();
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "speech.wav");
  form.append("model", opts.model);
  form.append("response_format", "verbose_json");
  form.append("temperature", "0");
  if (language) form.append("language", language);
  if (prompt) form.append("prompt", prompt);
  const res = await (opts.fetch ?? fetch)(`${opts.baseUrl ?? "https://api.groq.com/openai/v1"}/audio/transcriptions`, {
    method: "POST",
    headers: { authorization: `Bearer ${opts.apiKey}` },
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw await failure(res, "Groq");
  const body = (await res.json()) as { text?: unknown; language?: unknown };
  const text = typeof body.text === "string" ? body.text.trim() : "";
  return { text, language: language ?? languageOf(body.language, text), audioMs, tookMs: Date.now() - started };
}

export interface OpenAiTtsOptions {
  apiKey: string;
  model: string;
  voice: string;
  baseUrl?: string;
  fetch?: Fetch;
}

/** OpenAI text to speech, MP3. One voice speaks both languages; the instructions pin the accent. */
export async function openaiSpeak(opts: OpenAiTtsOptions, text: string, lang: SpokenLanguage): Promise<{ audio: Buffer; mime: string }> {
  const res = await (opts.fetch ?? fetch)(`${opts.baseUrl ?? "https://api.openai.com/v1"}/audio/speech`, {
    method: "POST",
    headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: opts.model,
      voice: opts.voice,
      input: text,
      response_format: "mp3",
      instructions: lang === "pt" ? "Speak in Brazilian Portuguese, clearly and calmly." : "Speak in English, clearly and calmly.",
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw await failure(res, "OpenAI");
  return { audio: Buffer.from(await res.arrayBuffer()), mime: "audio/mpeg" };
}
