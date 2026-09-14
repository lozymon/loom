import type { SpokenLanguage } from "@loom/protocol";
import { createStore } from "solid-js/store";
import type { ReadbackSettings } from "./readback.ts";

export interface VoiceSettings extends ReadbackSettings {
  /** Dictation language: automatic between English and Portuguese, or fixed (faster on whisper). */
  dictation: "auto" | SpokenLanguage;
  /** A trailing "send" or "enviar" sends the message. */
  autoSend: boolean;
  /** Where dictation goes when no approvals panel is open. */
  target: "focused" | "cockpit";
  readWith: "browser" | "hub";
  /** A system notification for approvals while Loom is in the background. */
  notify: boolean;
}

const KEY = "loom.voice";

function defaults(): VoiceSettings {
  const pt = typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("pt");
  return { muted: false, approvals: true, finished: true, speech: true, phrases: pt ? "pt" : "en", dictation: "auto", autoSend: false, target: "focused", readWith: "browser", notify: true };
}

/** Per-browser voice settings (ADR-0009: read-back is a client choice). */
export function createVoiceSettings() {
  let saved: Partial<VoiceSettings> = {};
  try {
    saved = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<VoiceSettings>;
  } catch {
    saved = {};
  }
  const [settings, setSettings] = createStore<VoiceSettings>({ ...defaults(), ...saved });
  const update = (patch: Partial<VoiceSettings>) => {
    setSettings(patch);
    localStorage.setItem(KEY, JSON.stringify(settings));
  };
  return { settings, update };
}
