import { HubError } from "../errors.ts";

export interface Wav {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** The samples, exactly as stored. */
  data: Buffer;
}

/** Reads a RIFF WAV header, walking chunks so extra ones (LIST, fact) are skipped. PCM only. */
export function parseWav(buf: Buffer): Wav {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new HubError("invalid", "audio is not a WAV file");
  }
  let fmt: Omit<Wav, "data"> | undefined;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      if (buf.readUInt16LE(body) !== 1) throw new HubError("invalid", "audio must be uncompressed PCM");
      fmt = { channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bitsPerSample: buf.readUInt16LE(body + 14) };
    } else if (id === "data") {
      if (!fmt) throw new HubError("invalid", "WAV data comes before its format");
      return { ...fmt, data: buf.subarray(body, Math.min(buf.length, body + size)) };
    }
    offset = body + size + (size % 2);
  }
  throw new HubError("invalid", "WAV file has no audio data");
}

export const SPEECH_RATE = 16_000;
export const MAX_SPEECH_MS = 5 * 60_000;

/** Checks a clip is what speech engines get: 16 kHz mono 16-bit, under five minutes. Returns duration. */
export function checkSpeechWav(wav: Wav): number {
  if (wav.sampleRate !== SPEECH_RATE || wav.channels !== 1 || wav.bitsPerSample !== 16) {
    throw new HubError("invalid", `audio must be 16 kHz mono 16-bit PCM, got ${wav.sampleRate} Hz, ${wav.channels} channels, ${wav.bitsPerSample}-bit`);
  }
  const ms = Math.round((wav.data.length / 2 / SPEECH_RATE) * 1000);
  if (ms > MAX_SPEECH_MS) throw new HubError("invalid", "audio is longer than five minutes");
  if (ms < 100) throw new HubError("invalid", "audio is too short");
  return ms;
}

/** A 16-bit mono WAV around raw samples. */
export function pcmToWav(pcm: Buffer, sampleRate = SPEECH_RATE): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
