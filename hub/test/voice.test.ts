import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HUMAN } from "../src/control/actor.ts";
import { inProcessApi } from "../src/loom/inProcess.ts";
import { loomTools, runTool } from "../src/loom/tools.ts";
import { VoiceConfig } from "../src/config.ts";
import { groqTranscribe, openaiSpeak } from "../src/voice/cloud.ts";
import { piperSpeak } from "../src/voice/piper.ts";
import { VoiceService, whisperModelCandidates } from "../src/voice/voiceService.ts";
import { checkSpeechWav, parseWav, pcmToWav } from "../src/voice/wav.ts";
import { WhisperSidecar } from "../src/voice/whisper.ts";
import { testHub } from "./support/hub.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function tmp(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "loom-voice-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const second = () => pcmToWav(Buffer.alloc(16_000 * 2));

describe("WAV", () => {
  it("round-trips and skips unknown chunks", () => {
    const wav = second();
    const withList = Buffer.concat([wav.subarray(0, 36), Buffer.from("LIST"), Buffer.from([3, 0, 0, 0, 1, 2, 3, 0]), wav.subarray(36)]);
    for (const b of [wav, withList]) {
      const parsed = parseWav(b);
      expect(parsed).toMatchObject({ sampleRate: 16_000, channels: 1, bitsPerSample: 16 });
      expect(parsed.data.length).toBe(32_000);
      expect(checkSpeechWav(parsed)).toBe(1000);
    }
  });

  it("refuses what engines cannot take", () => {
    expect(() => parseWav(Buffer.from("not audio"))).toThrow(/not a WAV/);
    expect(() => checkSpeechWav(parseWav(pcmToWav(Buffer.alloc(4000), 44_100)))).toThrow(/16 kHz/);
    expect(() => checkSpeechWav(parseWav(pcmToWav(Buffer.alloc(100))))).toThrow(/too short/);
    expect(() => checkSpeechWav(parseWav(pcmToWav(Buffer.alloc(16_000 * 2 * 301))))).toThrow(/five minutes/);
  });
});

/** A stand-in for loom-voce: answers each clip with its byte count, fails on request, can crash. */
function fakeVoce(dir: string): string {
  const script = path.join(dir, "fake-voce.mjs");
  writeFileSync(
    script,
    `import { createInterface } from "node:readline";
const model = process.argv[process.argv.indexOf("--model") + 1];
if (model.includes("broken")) { console.log(JSON.stringify({ ev: "error", message: "cannot load whisper model" })); process.exit(1); }
console.log(JSON.stringify({ ev: "ready", model, multilingual: true, gpu: false }));
createInterface({ input: process.stdin }).on("line", (line) => {
  const c = JSON.parse(line);
  const bytes = Buffer.from(c.pcm, "base64").length;
  if (bytes === 3) process.exit(9);
  if (bytes === 2) return console.log(JSON.stringify({ ev: "error", id: c.id, message: "whisper failed" }));
  console.log(JSON.stringify({ ev: "transcript", id: c.id, text: "bytes " + bytes, language: c.language ?? "pt", audioMs: 5, tookMs: 1 }));
});
`,
  );
  return script;
}

const spawnNode = (script: string) => (_bin: string, args: string[]) => spawn(process.execPath, [script, ...args], { stdio: ["pipe", "pipe", "pipe"] });

describe("WhisperSidecar", () => {
  it("starts on the first clip, answers in order, and reports errors per clip", async () => {
    const script = fakeVoce(tmp());
    const w = new WhisperSidecar({ binary: "loom-voce", model: "small.bin", spawn: spawnNode(script) });
    cleanups.push(() => w.close());
    expect(w.running).toBe(false);
    const [a, b, c] = await Promise.allSettled([
      w.transcribe(Buffer.alloc(10)),
      w.transcribe(Buffer.alloc(2)),
      w.transcribe(Buffer.alloc(20), "en"),
    ]);
    expect(a).toMatchObject({ status: "fulfilled", value: { text: "bytes 10", language: "pt" } });
    expect(b).toMatchObject({ status: "rejected", reason: { message: "whisper failed" } });
    expect(c).toMatchObject({ status: "fulfilled", value: { text: "bytes 20", language: "en" } });
    expect(w.running).toBe(true);
  });

  it("fails pending clips when the sidecar dies, then starts again", async () => {
    const script = fakeVoce(tmp());
    const w = new WhisperSidecar({ binary: "loom-voce", model: "small.bin", spawn: spawnNode(script) });
    cleanups.push(() => w.close());
    await expect(w.transcribe(Buffer.alloc(3))).rejects.toThrow(/stopped: exit 9/);
    await expect(w.transcribe(Buffer.alloc(4))).resolves.toMatchObject({ text: "bytes 4" });
  });

  it("explains a model that does not load, and stops when idle", async () => {
    const script = fakeVoce(tmp());
    const broken = new WhisperSidecar({ binary: "loom-voce", model: "broken.bin", spawn: spawnNode(script) });
    await expect(broken.transcribe(Buffer.alloc(4))).rejects.toThrow(/cannot load whisper model/);

    const idle = new WhisperSidecar({ binary: "loom-voce", model: "small.bin", idleMs: 30, spawn: spawnNode(script) });
    cleanups.push(() => idle.close());
    await idle.transcribe(Buffer.alloc(4));
    await new Promise((r) => setTimeout(r, 80));
    expect(idle.running).toBe(false);
  });
});

async function http(handler: (req: IncomingMessage, body: Buffer) => { status?: number; type?: string; body: string | Buffer }): Promise<string> {
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const out = handler(req, Buffer.concat(chunks));
    res.writeHead(out.status ?? 200, { "content-type": out.type ?? "application/json" });
    res.end(out.body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("cloud engines", () => {
  it("sends Groq the WAV with the key and maps the reported language", async () => {
    let seen: { auth?: string | undefined; body?: string } = {};
    const baseUrl = await http((req, body) => {
      seen = { auth: req.headers.authorization, body: body.toString("latin1") };
      return { body: JSON.stringify({ text: " Rode os testes ", language: "Portuguese" }) };
    });
    const t = await groqTranscribe({ apiKey: "gsk", model: "whisper-large-v3-turbo", baseUrl }, second(), 1000);
    expect(t).toMatchObject({ text: "Rode os testes", language: "pt", audioMs: 1000 });
    expect(seen.auth).toBe("Bearer gsk");
    expect(seen.body).toMatch(/name="model"\r\n\r\nwhisper-large-v3-turbo/);
    expect(seen.body).toMatch(/filename="speech.wav"/);
    expect(seen.body).not.toMatch(/name="language"/);
    await groqTranscribe({ apiKey: "gsk", model: "m", baseUrl }, second(), 1000, "en", "Allow. Deny.");
    expect(seen.body).toMatch(/name="language"\r\n\r\nen/);
    expect(seen.body).toMatch(/name="prompt"\r\n\r\nAllow. Deny./);
  });

  it("says when a key is rejected", async () => {
    const baseUrl = await http(() => ({ status: 401, body: "{}" }));
    await expect(groqTranscribe({ apiKey: "bad", model: "m", baseUrl }, second(), 1000)).rejects.toThrow(/Groq rejected the API key/);
    await expect(openaiSpeak({ apiKey: "bad", model: "m", voice: "alloy", baseUrl }, "hi", "en")).rejects.toThrow(/OpenAI rejected/);
  });

  it("asks OpenAI for speech in the right language", async () => {
    let request: Record<string, unknown> = {};
    const baseUrl = await http((_req, body) => {
      request = JSON.parse(body.toString()) as Record<string, unknown>;
      return { type: "audio/mpeg", body: Buffer.from([1, 2, 3]) };
    });
    const out = await openaiSpeak({ apiKey: "sk", model: "gpt-4o-mini-tts", voice: "alloy", baseUrl }, "Terminei a tarefa", "pt");
    expect(out).toEqual({ audio: Buffer.from([1, 2, 3]), mime: "audio/mpeg" });
    expect(request).toMatchObject({ model: "gpt-4o-mini-tts", voice: "alloy", input: "Terminei a tarefa", response_format: "mp3" });
    expect(String(request.instructions)).toMatch(/Brazilian Portuguese/);
  });
});

describe.skipIf(process.platform === "win32")("Piper", () => {
  it("writes text to Piper and returns its WAV, falling back to the other voice", async () => {
    const dir = tmp();
    const fake = path.join(dir, "piper");
    writeFileSync(
      fake,
      `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
let text = "";
process.stdin.on("data", (d) => (text += d)).on("end", () => {
  fs.writeFileSync(args[args.indexOf("--output_file") + 1], "WAV:" + args[args.indexOf("--model") + 1] + ":" + text);
});
`,
    );
    chmodSync(fake, 0o755);
    const out = await piperSpeak({ command: fake, voices: { en: "en.onnx" } }, "Olá,\n mundo", "pt");
    expect(out).toEqual({ audio: Buffer.from("WAV:en.onnx:Olá, mundo"), mime: "audio/wav", lang: "en" });
    await expect(piperSpeak({ command: path.join(dir, "missing"), voices: { en: "en.onnx" } }, "hi", "en")).rejects.toThrow(/cannot run Piper/);
  });
});

describe("VoiceService", () => {
  const config = (over: Record<string, unknown> = {}) => VoiceConfig.parse(over);

  it("finds models by name in the hub's folder or v1's cache", () => {
    expect(whisperModelCandidates("small", "/data", { XDG_CACHE_HOME: "/cache" })).toEqual([
      path.join("/data", "models", "ggml-small.bin"),
      path.join("/cache", "loom-voce", "ggml-small.bin"),
    ]);
    expect(whisperModelCandidates("/models/x.bin", "/data", {})).toEqual(["/models/x.bin"]);
  });

  it("prefers whisper when the sidecar and model exist, else Groq, else nothing with a note", () => {
    const dataDir = tmp();
    const none = new VoiceService(config(), { dataDir, env: { XDG_CACHE_HOME: dataDir }, voceBinary: "/bin/loom-voce" });
    expect(none.info).toEqual({});
    expect(none.notes.join()).toMatch(/no model small/);

    const groq = new VoiceService(config(), { dataDir, env: { XDG_CACHE_HOME: dataDir, GROQ_API_KEY: "k", OPENAI_API_KEY: "o" } });
    expect(groq.info).toEqual({ stt: "groq", tts: "openai" });
    expect(groq.notes).toEqual([]);

    mkdirSync(path.join(dataDir, "models"));
    writeFileSync(path.join(dataDir, "models", "ggml-small.bin"), "model");
    const whisper = new VoiceService(config({ quietHours: { from: "22:00", to: "07:00" } }), {
      dataDir,
      env: { XDG_CACHE_HOME: dataDir, GROQ_API_KEY: "k" },
      voceBinary: "/bin/loom-voce",
    });
    expect(whisper.info).toEqual({ stt: "whisper", quietHours: { from: "22:00", to: "07:00" } });
    expect(whisper.summary).toMatch(/whisper \(ggml-small.bin\)/);

    const off = new VoiceService(config({ stt: "off", tts: "openai" }), { dataDir, env: { GROQ_API_KEY: "k" } });
    expect(off.info).toEqual({});
    expect(off.notes.join()).toMatch(/OPENAI_API_KEY/);
  });

  it("transcribes through the chosen engine after checking the audio", async () => {
    const dataDir = tmp();
    const baseUrl = await http(() => ({ body: JSON.stringify({ text: "run the tests", language: "English" }) }));
    const voice = new VoiceService(config({ stt: "groq" }), { dataDir, env: { GROQ_API_KEY: "k" }, groqBaseUrl: baseUrl });
    await expect(voice.transcribe(second().toString("base64"))).resolves.toMatchObject({ text: "run the tests", language: "en", engine: "groq" });
    await expect(voice.transcribe(Buffer.from("nope").toString("base64"))).rejects.toThrow(/not a WAV/);
    await expect(voice.speak("hello")).rejects.toThrow(/no speech engine/);
  });
});

describe("speak", () => {
  it("records speech from a session as itself, and never as another session", async () => {
    const hub = testHub();
    const a = await hub.manager.create({ adapter: "claude-sdk", cwd: "/repo" });
    const b = await hub.manager.create({ adapter: "claude-sdk", cwd: "/repo" });
    const caller = { sessionId: a.id, name: a.name, role: "session" as const, cwd: "/repo", projectRoot: "/repo" };
    const api = inProcessApi(hub.manager, () => undefined, { kind: "session", sessionId: a.id, role: "session" });
    const speak = loomTools(caller).find((t) => t.name === "speak")!;
    expect((await runTool(speak, { text: "Terminei os testes", lang: "pt" }, api)).text).toBe("Said.");
    const speech = hub.events.find((e) => e.event.type === "speech");
    expect(speech).toMatchObject({ sessionId: a.id, event: { type: "speech", text: "Terminei os testes", lang: "pt" } });
    expect(hub.manager.get(a.id).activity).toBe("“Terminei os testes”");

    await expect(api.request({ cmd: "session.speak", sessionId: b.id, text: "hi" })).rejects.toThrow(/only speak as itself/);
    await expect(api.request({ cmd: "voice.speak", text: "hi" })).rejects.toThrow(/cannot use voice.speak/);
    await expect(inProcessApi(hub.manager, () => undefined, HUMAN).request({ cmd: "voice.transcribe", audio: "AAAA" })).rejects.toThrow(/no speech recognition/);
  });
});
