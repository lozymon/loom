import { detectLanguage, type SpokenLanguage } from "@loom/protocol";
import { createSignal } from "solid-js";

export interface SpeakRequest {
  text: string;
  lang?: SpokenLanguage | undefined;
  /** Synthesis on a hub, when the person chose the hub's voice and the hub has one. */
  viaHub?: ((text: string, lang: SpokenLanguage) => Promise<{ audio: string; mime: string } | undefined>) | undefined;
}

const MAX_QUEUE = 5;

function browserVoice(lang: SpokenLanguage): SpeechSynthesisVoice | undefined {
  const voices = speechSynthesis.getVoices();
  const want = lang === "pt" ? ["pt-br", "pt"] : ["en-us", "en-gb", "en"];
  for (const prefix of want) {
    const found = voices.find((v) => v.lang.toLowerCase().replace("_", "-").startsWith(prefix));
    if (found) return found;
  }
  return undefined;
}

/** Plays read-back one utterance at a time, with the browser's voice or audio from a hub. */
export function createSpeaker() {
  const [speaking, setSpeaking] = createSignal(false);
  const queue: SpeakRequest[] = [];
  let audio: HTMLAudioElement | undefined;
  let generation = 0;

  const browserSupported = typeof speechSynthesis !== "undefined";
  if (browserSupported) speechSynthesis.getVoices(); // Chrome loads voices lazily.

  async function playOne(req: SpeakRequest, gen: number): Promise<void> {
    const lang = req.lang ?? detectLanguage(req.text);
    if (req.viaHub) {
      const out = await req.viaHub(req.text, lang).catch(() => undefined);
      if (gen !== generation) return;
      if (out) {
        audio = new Audio(`data:${out.mime};base64,${out.audio}`);
        await new Promise<void>((resolve) => {
          audio!.onended = () => resolve();
          audio!.onerror = () => resolve();
          audio!.play().catch(() => resolve());
        });
        audio = undefined;
        return;
      }
    }
    if (!browserSupported) return;
    await new Promise<void>((resolve) => {
      const u = new SpeechSynthesisUtterance(req.text);
      u.lang = lang === "pt" ? "pt-BR" : "en-US";
      const voice = browserVoice(lang);
      if (voice) u.voice = voice;
      u.onend = () => resolve();
      u.onerror = () => resolve();
      speechSynthesis.speak(u);
    });
  }

  async function drain(): Promise<void> {
    if (speaking()) return;
    setSpeaking(true);
    const gen = generation;
    while (queue.length > 0 && gen === generation) {
      await playOne(queue.shift()!, gen);
    }
    if (gen === generation) setSpeaking(false);
  }

  return {
    speaking,
    say(req: SpeakRequest): void {
      if (queue.length >= MAX_QUEUE) queue.shift();
      queue.push(req);
      void drain();
    },
    /** The stop key: silence now and forget what was waiting. */
    stop(): void {
      generation++;
      queue.length = 0;
      if (browserSupported) speechSynthesis.cancel();
      audio?.pause();
      audio = undefined;
      setSpeaking(false);
    },
  };
}
export type Speaker = ReturnType<typeof createSpeaker>;
