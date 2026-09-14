import { detectLanguage, type SpokenLanguage, type VoiceInfo } from "@loom/protocol";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { VoiceConfig } from "../config.ts";
import { HubError } from "../errors.ts";
import { resolveOnPath } from "../adapters/pty/launch.ts";
import { groqTranscribe, openaiSpeak } from "./cloud.ts";
import { piperSpeak } from "./piper.ts";
import { checkSpeechWav, parseWav } from "./wav.ts";
import { type Transcript, WhisperSidecar } from "./whisper.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Finds loom-voce the way the terminal sidecar is found: env, repo builds, next to the executable. */
export function locateVoceSidecar(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  const exe = platform === "win32" ? "loom-voce.exe" : "loom-voce";
  return [
    env.LOOM_VOCE_BIN,
    path.join(REPO_ROOT, "sidecars", "voce", "target", "release", exe),
    path.join(path.dirname(process.execPath), exe),
  ].find((c): c is string => typeof c === "string" && c !== "" && existsSync(c));
}

/** Where a whisper model named `small` may be: the hub's models folder, then Loom v1's download cache. */
export function whisperModelCandidates(model: string, dataDir: string, env: NodeJS.ProcessEnv = process.env): string[] {
  if (model.endsWith(".bin") || model.includes("/") || model.includes("\\")) return [model];
  const file = `ggml-${model}.bin`;
  const cache = env.XDG_CACHE_HOME || (process.platform === "win32" ? env.LOCALAPPDATA : undefined) || path.join(os.homedir(), ".cache");
  return [path.join(dataDir, "models", file), path.join(cache, "loom-voce", file)];
}

export interface VoiceEnv {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  voceBinary?: string | undefined;
  /** For tests: stand-ins for the network and processes. */
  whisper?: (binary: string, model: string) => WhisperSidecar;
  fetch?: typeof fetch;
  groqBaseUrl?: string;
  openaiBaseUrl?: string;
}

type Stt = { kind: "whisper"; sidecar: WhisperSidecar; model: string } | { kind: "groq"; apiKey: string };
type Tts = { kind: "openai"; apiKey: string } | { kind: "piper"; command: string };

/**
 * Speech on the hub (ADR-0009): picks engines from `hub.json` and what is installed, and runs them. A
 * missing engine is not an error for the hub, only for the commands that need it.
 */
export class VoiceService {
  readonly info: VoiceInfo;
  /** Startup lines explaining the choice, e.g. why whisper is unavailable. */
  readonly notes: string[] = [];
  #config: VoiceConfig;
  #deps: VoiceEnv;
  #stt: Stt | undefined;
  #tts: Tts | undefined;

  constructor(config: VoiceConfig, deps: VoiceEnv) {
    this.#config = config;
    this.#deps = deps;
    const env = deps.env ?? process.env;
    this.#stt = this.#pickStt(env);
    this.#tts = this.#pickTts(env);
    this.info = {
      ...(this.#stt ? { stt: this.#stt.kind } : {}),
      ...(this.#tts ? { tts: this.#tts.kind } : {}),
      ...(config.quietHours ? { quietHours: config.quietHours } : {}),
    };
  }

  get summary(): string {
    const stt = this.#stt ? (this.#stt.kind === "whisper" ? `whisper (${path.basename(this.#stt.model)})` : "Groq") : "none";
    const tts = this.#tts ? (this.#tts.kind === "openai" ? "OpenAI" : "Piper") : "browser voice only";
    return `speech to text ${stt}, read-back ${tts}`;
  }

  #pickStt(env: NodeJS.ProcessEnv): Stt | undefined {
    const want = this.#config.stt;
    if (want === "off") return undefined;
    if (want === "whisper" || want === "auto") {
      const binary = this.#deps.voceBinary;
      const model = whisperModelCandidates(this.#config.whisper.model, this.#deps.dataDir, env).find((m) => existsSync(m));
      if (binary && model) {
        const sidecar = this.#deps.whisper?.(binary, model) ?? new WhisperSidecar({ binary, model, threads: this.#config.whisper.threads });
        return { kind: "whisper", sidecar, model };
      }
      if (want === "whisper" || !env.GROQ_API_KEY) {
        this.notes.push(
          !binary
            ? "whisper unavailable: build it with npm run build:voce"
            : `whisper unavailable: no model ${this.#config.whisper.model}; put ggml-${this.#config.whisper.model}.bin in ${path.join(this.#deps.dataDir, "models")}`,
        );
      }
      if (want === "whisper") return undefined;
    }
    if (env.GROQ_API_KEY) return { kind: "groq", apiKey: env.GROQ_API_KEY };
    if (want === "groq") this.notes.push("Groq unavailable: set GROQ_API_KEY for the hub");
    return undefined;
  }

  #pickTts(env: NodeJS.ProcessEnv): Tts | undefined {
    const want = this.#config.tts;
    if (want === "off") return undefined;
    if (want === "piper" || want === "auto") {
      const voices = this.#config.piper.voices;
      const command = path.isAbsolute(this.#config.piper.command)
        ? existsSync(this.#config.piper.command)
          ? this.#config.piper.command
          : undefined
        : resolveOnPath(this.#config.piper.command, { platform: process.platform, env: env as Record<string, string> });
      if (command && (voices.en || voices.pt)) return { kind: "piper", command };
      if (want === "piper") {
        this.notes.push(command ? "Piper unavailable: set piper.voices.en or piper.voices.pt" : `Piper unavailable: ${this.#config.piper.command} not found`);
        return undefined;
      }
    }
    if (env.OPENAI_API_KEY) return { kind: "openai", apiKey: env.OPENAI_API_KEY };
    if (want === "openai") this.notes.push("OpenAI speech unavailable: set OPENAI_API_KEY for the hub");
    return undefined;
  }

  async transcribe(audioBase64: string, language?: SpokenLanguage, prompt?: string): Promise<Transcript & { engine: string }> {
    const stt = this.#stt;
    if (!stt) throw new HubError("invalid", "this hub has no speech recognition; see docs/dev.md, Voice");
    const wavBytes = Buffer.from(audioBase64, "base64");
    const wav = parseWav(wavBytes);
    const audioMs = checkSpeechWav(wav);
    if (stt.kind === "whisper") return { ...(await stt.sidecar.transcribe(wav.data, language, prompt)), engine: "whisper" };
    return {
      ...(await groqTranscribe(
        { apiKey: stt.apiKey, model: this.#config.groq.model, ...(this.#deps.groqBaseUrl ? { baseUrl: this.#deps.groqBaseUrl } : {}), ...(this.#deps.fetch ? { fetch: this.#deps.fetch } : {}) },
        wavBytes,
        audioMs,
        language,
        prompt,
      )),
      engine: "groq",
    };
  }

  async speak(text: string, lang?: SpokenLanguage): Promise<{ audio: string; mime: string; lang: SpokenLanguage; engine: string }> {
    const tts = this.#tts;
    if (!tts) throw new HubError("invalid", "this hub has no speech engine; the client can use the browser's voice");
    const language = lang ?? detectLanguage(text);
    if (tts.kind === "piper") {
      const { en, pt } = this.#config.piper.voices;
      const out = await piperSpeak({ command: tts.command, voices: { ...(en ? { en } : {}), ...(pt ? { pt } : {}) } }, text, language);
      return { audio: out.audio.toString("base64"), mime: out.mime, lang: out.lang, engine: "piper" };
    }
    const out = await openaiSpeak(
      {
        apiKey: tts.apiKey,
        model: this.#config.openai.model,
        voice: this.#config.openai.voice,
        ...(this.#deps.openaiBaseUrl ? { baseUrl: this.#deps.openaiBaseUrl } : {}),
        ...(this.#deps.fetch ? { fetch: this.#deps.fetch } : {}),
      },
      text,
      language,
    );
    return { audio: out.audio.toString("base64"), mime: out.mime, lang: language, engine: "openai" };
  }

  close(): void {
    if (this.#stt?.kind === "whisper") this.#stt.sidecar.close();
  }
}
