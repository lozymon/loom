import { encodeWav, rms } from "./wav.ts";

const RATE = 16_000;

export interface Recording {
  wav: Uint8Array;
  ms: number;
  /** RMS of the whole clip: near zero means nothing was said, or the microphone is muted. */
  loudness: number;
}

/**
 * Averages (downsampling) or interpolates (upsampling) mono samples to `toRate`. Averaging each output
 * sample's span is a crude low-pass filter, which is enough for speech recognition.
 */
export function resample(input: Float32Array, fromRate: number, toRate = RATE): Float32Array {
  if (fromRate === toRate) return input.slice();
  const ratio = fromRate / toRate;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    if (ratio > 1) {
      const start = Math.floor(i * ratio);
      const end = Math.min(input.length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
      let sum = 0;
      for (let j = start; j < end; j++) sum += input[j]!;
      out[i] = sum / (end - start);
    } else {
      const pos = i * ratio;
      const j = Math.floor(pos);
      const next = input[Math.min(j + 1, input.length - 1)]!;
      out[i] = input[j]! + (next - input[j]!) * (pos - j);
    }
  }
  return out;
}

/**
 * Push-to-talk capture: raw samples from the Web Audio graph while the key is held, resampled to
 * 16 kHz mono here, so the hub gets a plain WAV (ADR-0009). No MediaRecorder or decodeAudioData,
 * which never finish in some webviews (WebKitGTK, M9).
 */
export class Recorder {
  #stream: MediaStream | undefined;
  #ctx: AudioContext | undefined;
  #analyser: AnalyserNode | undefined;
  #processor: ScriptProcessorNode | undefined;
  #chunks: Float32Array[] = [];
  #buf = new Float32Array(512);

  static unavailableReason(): string | undefined {
    if (!window.isSecureContext) return "The microphone needs https or a localhost address. Reach remote hubs through loom tunnel.";
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === "undefined") return "This browser cannot record audio.";
    return undefined;
  }

  async start(): Promise<void> {
    const request = navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    // Some webviews never answer when capture is unavailable; do not leave push-to-talk hanging.
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the microphone did not open within 8 seconds")), 8000));
    try {
      this.#stream = await Promise.race([request, timeout]);
    } catch (err) {
      void request.then((late) => late.getTracks().forEach((t) => t.stop())).catch(() => undefined);
      throw err;
    }
    const ctx = new AudioContext();
    this.#ctx = ctx;
    // A global shortcut is not a user gesture, so the context may start suspended.
    await ctx.resume().catch(() => undefined);
    const source = ctx.createMediaStreamSource(this.#stream);
    this.#analyser = ctx.createAnalyser();
    this.#analyser.fftSize = 512;
    source.connect(this.#analyser);
    this.#chunks = [];
    this.#processor = ctx.createScriptProcessor(4096, 1, 1);
    this.#processor.onaudioprocess = (e) => this.#chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    // The processor only runs when connected to the output; a silent gain keeps it from being heard.
    const silent = ctx.createGain();
    silent.gain.value = 0;
    source.connect(this.#processor);
    this.#processor.connect(silent);
    silent.connect(ctx.destination);
  }

  /** Current input level, 0 to about 1. */
  level(): number {
    if (!this.#analyser) return 0;
    this.#analyser.getFloatTimeDomainData(this.#buf);
    return Math.min(1, rms(this.#buf) * 4);
  }

  async stop(): Promise<Recording> {
    const ctx = this.#ctx;
    if (!ctx) throw new Error("not recording");
    const rate = ctx.sampleRate;
    const chunks = this.#chunks;
    this.#release();
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const joined = new Float32Array(total);
    let offset = 0;
    for (const c of chunks) {
      joined.set(c, offset);
      offset += c.length;
    }
    const samples = resample(joined, rate);
    return { wav: encodeWav(samples, RATE), ms: Math.round((samples.length / RATE) * 1000), loudness: rms(samples) };
  }

  cancel(): void {
    this.#release();
  }

  #release(): void {
    if (this.#processor) this.#processor.onaudioprocess = null;
    for (const track of this.#stream?.getTracks() ?? []) track.stop();
    void this.#ctx?.close();
    this.#stream = undefined;
    this.#ctx = undefined;
    this.#analyser = undefined;
    this.#processor = undefined;
    this.#chunks = [];
  }
}
