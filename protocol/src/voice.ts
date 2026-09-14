import { z } from "zod";

/** The two languages Loom speaks and understands (ADR-0009). */
export const SpokenLanguage = z.enum(["en", "pt"]);
export type SpokenLanguage = z.infer<typeof SpokenLanguage>;

/** `HH:MM` to `HH:MM` in the client's local time; may cross midnight. */
export const QuietHours = z.object({
  from: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  to: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
});
export type QuietHours = z.infer<typeof QuietHours>;

/** What speech a hub offers, sent in `welcome`. Absent engines mean the client uses its own or none. */
export const VoiceInfo = z.object({
  stt: z.enum(["whisper", "groq"]).optional(),
  tts: z.enum(["openai", "piper"]).optional(),
  quietHours: QuietHours.optional(),
});
export type VoiceInfo = z.infer<typeof VoiceInfo>;

export function inQuietHours(quiet: QuietHours | undefined, now: Date): boolean {
  if (!quiet) return false;
  const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  const t = now.getHours() * 60 + now.getMinutes();
  const from = minutes(quiet.from);
  const to = minutes(quiet.to);
  if (from === to) return false;
  return from < to ? t >= from && t < to : t >= from || t < to;
}

const PT_WORDS = new Set(
  "a o as os um uma de do da dos das em no na nos nas por para com não nao sim que é e ou mas se ele ela eles elas você voce isso isto este esta esse essa aqui agora está esta estão estao foi ser ter tem fazer faz pode precisa quer arquivo sessão sessao comando rodar executar permitir negar enviar terminou falhou pronto obrigado olá ola bom boa também tambem mais muito já ja ainda depois antes quando onde como porque".split(" "),
);
const EN_WORDS = new Set(
  "the a an of to in on at for with and or but not no yes is are was were be been has have had do does did it this that these those you he she they we i my your can could would should will want wants run file session command allow deny send done failed ready thanks hello please what when where how why there here now just also more very still after before".split(" "),
);

/**
 * English or Portuguese, from the words used. Accents and `ção`/`ões` count for Portuguese. Ties and
 * empty text are English. Good enough to pick a voice; not a general language detector.
 */
export function detectLanguage(text: string): SpokenLanguage {
  const lower = text.toLowerCase();
  let pt = (lower.match(/[ãõçáéíóúâêô]/g)?.length ?? 0) * 0.5 + (lower.match(/ção|ções|ões|nh|lh/g)?.length ?? 0);
  let en = (lower.match(/\b(th|wh)\w+|\w+ing\b/g)?.length ?? 0) * 0.5;
  for (const word of lower.split(/[^\p{L}]+/u)) {
    if (!word) continue;
    if (PT_WORDS.has(word)) pt++;
    if (EN_WORDS.has(word)) en++;
  }
  return pt > en ? "pt" : "en";
}
