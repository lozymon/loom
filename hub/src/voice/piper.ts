import type { SpokenLanguage } from "@loom/protocol";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubError } from "../errors.ts";

export interface PiperOptions {
  command: string;
  /** Voice model (`.onnx`) per language. */
  voices: Partial<Record<SpokenLanguage, string>>;
}

/** Piper, offline: text on stdin, a WAV file out. Uses the other language's voice when one is missing. */
export async function piperSpeak(opts: PiperOptions, text: string, lang: SpokenLanguage): Promise<{ audio: Buffer; mime: string; lang: SpokenLanguage }> {
  const voiceLang: SpokenLanguage = opts.voices[lang] ? lang : lang === "pt" ? "en" : "pt";
  const voice = opts.voices[voiceLang];
  if (!voice) throw new HubError("engine", "Piper has no voice configured");
  const dir = await mkdtemp(path.join(os.tmpdir(), "loom-piper-"));
  const out = path.join(dir, "speech.wav");
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(opts.command, ["--model", voice, "--output_file", out], { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
      let stderr = "";
      child.stderr.on("data", (d: Buffer) => {
        stderr = (stderr + d.toString("utf8")).slice(-1000);
      });
      const timer = setTimeout(() => child.kill(), 60_000);
      child.once("error", (err) => {
        clearTimeout(timer);
        reject(new HubError("engine", `cannot run Piper (${opts.command}): ${err.message}`));
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new HubError("engine", `Piper failed (exit ${code})${stderr.trim() ? `: ${stderr.trim().split("\n").at(-1)}` : ""}`));
      });
      child.stdin.end(text.replace(/\s+/g, " "));
    });
    return { audio: await readFile(out), mime: "audio/wav", lang: voiceLang };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
