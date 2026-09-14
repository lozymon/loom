import { levelRank, PermissionLevel, QuietHours } from "@loom/protocol";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { HubPaths } from "./paths.ts";

/** Speech on this hub (ADR-0009). API keys come from the environment, never from this file. */
export const VoiceConfig = z
  .object({
    /** `auto`: whisper if loom-voce and a model are present, else Groq if GROQ_API_KEY is set. */
    stt: z.enum(["auto", "whisper", "groq", "off"]).default("auto"),
    /** `auto`: Piper if configured, else OpenAI if OPENAI_API_KEY is set, else the client's own voice. */
    tts: z.enum(["auto", "openai", "piper", "off"]).default("auto"),
    whisper: z
      .object({
        /** A model name (`small`, `medium`, `large-v3-turbo-q5_0`) looked up in the hub's models folder, or a path. */
        model: z.string().min(1).default("small"),
        threads: z.number().int().min(1).max(64).optional(),
      })
      .strict()
      .default({ model: "small" }),
    groq: z.object({ model: z.string().min(1).default("whisper-large-v3-turbo") }).strict().default({ model: "whisper-large-v3-turbo" }),
    openai: z
      .object({ model: z.string().min(1).default("gpt-4o-mini-tts"), voice: z.string().min(1).default("alloy") })
      .strict()
      .default({ model: "gpt-4o-mini-tts", voice: "alloy" }),
    piper: z
      .object({
        command: z.string().min(1).default("piper"),
        voices: z.object({ en: z.string().min(1).optional(), pt: z.string().min(1).optional() }).strict().default({}),
      })
      .strict()
      .default({ command: "piper", voices: {} }),
    /** No automatic read-back in this window, e.g. { "from": "22:00", "to": "07:00" }. */
    quietHours: QuietHours.optional(),
  })
  .strict();
export type VoiceConfig = z.infer<typeof VoiceConfig>;

/**
 * Hub-wide settings in `hub.json` (ADR-0012). Defaults are the cautious ones, suitable for a work
 * machine: a person approves everything, and the Steward's model stage is off.
 */
export const HubConfig = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    /** "127.0.0.1" (default), "tailscale", a Tailscale address, or another address with allowUnencryptedNetwork. */
    bind: z.string().min(1).default("127.0.0.1"),
    /** Accept a non-loopback, non-Tailscale bind. Loom's own traffic is not encrypted (ADR-0008). */
    allowUnencryptedNetwork: z.boolean().default(false),
    port: z.number().int().min(0).max(65535).default(7420),
    defaultLevel: PermissionLevel.default("supervised"),
    maxLevel: PermissionLevel.default("accept-edits"),
    stewardModel: z.boolean().default(false),
    /** How the Steward behaves where `stewardModel` is true (ADR-0006). */
    steward: z
      .object({
        model: z.string().min(1).default("claude-sonnet-5"),
        /** `recommend` advises only (start here for a week); `decide` may allow or deny by itself. */
        mode: z.enum(["recommend", "decide"]).default("recommend"),
        /** Minimum confidence to act on a verdict. Terminal sessions add 0.05. */
        minConfidence: z.number().min(0.5).max(1).default(0.85),
        /** Automatic decisions per session per hour before everything escalates. */
        maxDecisionsPerHour: z.number().int().min(1).max(1000).default(30),
        /** Steward spend per day, in USD, before everything escalates. */
        maxDailyUsd: z.number().positive().max(1000).default(2),
        /** Extra guidance from the hub owner, added to the Steward's instructions. */
        instructions: z.string().max(4000).optional(),
      })
      .strict()
      .default({ model: "claude-sonnet-5", mode: "recommend", minConfidence: 0.85, maxDecisionsPerHour: 30, maxDailyUsd: 2 }),
    voice: VoiceConfig.default(() => VoiceConfig.parse({})),
    /** Web push to phones (M10). Devices subscribe from the client; nothing is sent until one does. */
    push: z
      .object({
        enabled: z.boolean().default(true),
        /** Wait this long before pushing, so approvals handled at the desk do not buzz the phone. */
        delaySeconds: z.number().int().min(0).max(3600).default(15),
        /** VAPID contact. Some push services reject addresses that do not look real. */
        subject: z.string().regex(/^(mailto:|https:)/).default("mailto:loom@localhost"),
      })
      .strict()
      .default({ enabled: true, delaySeconds: 15, subject: "mailto:loom@localhost" }),
    /** Heuristic state for terminal CLIs without hooks (ADR-0011): manifest ids from `<config dir>/manifests/*.toml`. */
    heuristics: z.object({ enabled: z.array(z.string().min(1)).default([]) }).strict().default({ enabled: [] }),
    /** A relay this hub dials out to (ADR-0014). `loom-relay add-hub` prints this block. */
    relay: z
      .object({
        url: z.string().regex(/^wss:\/\/[^/]+\/?$/, "relay.url is wss://<relay domain>"),
        name: z.string().regex(/^[a-z0-9-]{1,32}$/),
        secret: z.string().min(20),
        /** `acme` gets and renews a certificate through the relay; or give certificate files. */
        certificate: z.union([z.literal("acme"), z.object({ cert: z.string().min(1), key: z.string().min(1) }).strict()]).default("acme"),
        acme: z
          .object({
            directory: z.string().url().default("https://acme-v02.api.letsencrypt.org/directory"),
            email: z.string().email().optional(),
            /** acme-client checks the challenge is reachable before asking the CA. */
            verifyChallenge: z.boolean().default(true),
          })
          .strict()
          .default({ directory: "https://acme-v02.api.letsencrypt.org/directory", verifyChallenge: true }),
      })
      .strict()
      .optional(),
    /** Certificate files for HTTPS on network addresses, e.g. from `tailscale cert`. Loopback stays HTTP. */
    tls: z.object({ cert: z.string().min(1), key: z.string().min(1) }).strict().optional(),
  })
  .strict()
  .refine((c) => levelRank(c.defaultLevel) <= levelRank(c.maxLevel), {
    message: "defaultLevel must not be above maxLevel",
    path: ["defaultLevel"],
  });
export type HubConfig = z.infer<typeof HubConfig>;

export class ConfigError extends Error {
  override name = "ConfigError";
}

/** Reads `hub.json`, creating it with defaults on first run. Unknown keys are an error. */
export function loadConfig(paths: HubPaths): { config: HubConfig; created: boolean } {
  mkdirSync(paths.configDir, { recursive: true });
  if (!existsSync(paths.configFile)) {
    const config = HubConfig.parse({ id: randomUUID(), name: os.hostname() });
    writeFileSync(paths.configFile, `${JSON.stringify(config, null, 2)}\n`);
    return { config, created: true };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(paths.configFile, "utf8"));
  } catch (err) {
    throw new ConfigError(`${paths.configFile} is not valid JSON: ${(err as Error).message}`);
  }
  const parsed = HubConfig.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(`${path.basename(paths.configFile)} is invalid:\n${z.prettifyError(parsed.error)}`);
  }
  return { config: parsed.data, created: false };
}
