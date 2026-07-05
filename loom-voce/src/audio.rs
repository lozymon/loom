//! Microphone capture → 16kHz mono f32 frames for the STT loop.
//!
//! Two backends behind one `start_capture` seam, split by platform for a deliberate reason:
//!
//! * **Linux** shells out to the system recorder (`parecord`/`arecord`), reading raw 16kHz mono
//!   s16le PCM from its stdout. Why not cpal here? On a no-sudo Linux box, cpal needs the ALSA
//!   `-dev` headers (`libasound2-dev`) to build; `parecord` (PulseAudio) / `arecord` (ALSA) ship on
//!   every desktop, resample to 16kHz for us, and need no build-time system headers — the right fit
//!   for Loom's Linux-first, no-sudo world. This path is unchanged and pulls no new dependency.
//!
//! * **macOS / Windows** use **cpal** (CoreAudio / WASAPI) — no problematic build-time headers on
//!   those platforms, and no `parecord`/`arecord` to shell out to. cpal delivers audio at the
//!   device's *native* rate and channel count, so this backend downmixes to mono and resamples to
//!   16kHz in-process (`Resampler`, linear interpolation — adequate for speech dictation).
//!
//! The cpal dependency is target-gated (`cfg(not(target_os = "linux"))`) in Cargo.toml, so the
//! Linux build is byte-identical to before and never needs the ALSA headers.

use anyhow::Result;
use std::sync::mpsc::Sender;

/// whisper.cpp expects 16kHz mono.
pub const TARGET_RATE: u32 = 16_000;

/// ~30ms frames: 480 samples at 16kHz. Small enough for responsive VAD.
const FRAME_SAMPLES: usize = 480;

/// Handle that keeps capture alive; drop it to stop. Innards are platform-specific: the Linux
/// backend holds the recorder subprocess (killed on drop), the cpal backend holds the input stream
/// (cpal stops it when the stream is dropped).
pub struct Capture {
    #[cfg(target_os = "linux")]
    child: std::process::Child,
    #[cfg(not(target_os = "linux"))]
    #[allow(dead_code)] // held only so Drop stops the stream; never read directly.
    stream: cpal::Stream,
}

#[cfg(target_os = "linux")]
impl Drop for Capture {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

// ── Linux backend: shell out to parecord/arecord ───────────────────────────────────────────────

/// Spawn the system recorder and stream 16kHz mono f32 frames to `tx` from a reader thread.
#[cfg(target_os = "linux")]
pub fn start_capture(tx: Sender<Vec<f32>>) -> Result<Capture> {
    use anyhow::Context;
    use std::io::Read;

    let mut child = spawn_recorder().context("could not start an audio recorder")?;
    let mut stdout = child
        .stdout
        .take()
        .context("recorder produced no stdout pipe")?;

    std::thread::spawn(move || {
        // Read fixed s16le blocks and hand each off as an f32 frame. A read error is EOF/shutdown
        // (recorder ended) → stop the loop cleanly.
        let mut raw = vec![0u8; FRAME_SAMPLES * 2];
        while stdout.read_exact(&mut raw).is_ok() {
            let frame: Vec<f32> = raw
                .chunks_exact(2)
                .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0)
                .collect();
            // Drop on a closed channel (consumer gone) and stop the thread.
            if tx.send(frame).is_err() {
                break;
            }
        }
    });

    Ok(Capture { child })
}

/// Prefer PulseAudio's `parecord`, fall back to ALSA's `arecord`; both emit raw s16le mono @16kHz.
#[cfg(target_os = "linux")]
fn spawn_recorder() -> Result<std::process::Child> {
    use anyhow::{bail, Context};
    use std::process::{Command, Stdio};

    if which("parecord") {
        // `--latency-msec=30` is essential, not a tweak: PulseAudio's default record buffer is ~2s,
        // so without it the first frame doesn't arrive for ~2s — long enough that a one-shot capture
        // gives up ("heard nothing") before the mic ever produces a sample. 30ms makes it near-instant.
        return Command::new("parecord")
            .args([
                "--raw",
                "--rate=16000",
                "--channels=1",
                "--format=s16le",
                "--latency-msec=30",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .context("failed to spawn parecord");
    }
    if which("arecord") {
        // `--buffer-time`/`--period-time` (µs) keep ALSA's startup latency low for the same reason.
        return Command::new("arecord")
            .args([
                "-q",
                "-t",
                "raw",
                "-f",
                "S16_LE",
                "-r",
                "16000",
                "-c",
                "1",
                "--buffer-time=100000",
                "--period-time=30000",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .context("failed to spawn arecord");
    }
    bail!("no recorder found — install pulseaudio-utils (parecord) or alsa-utils (arecord)")
}

/// Is `bin` on `PATH`? (Avoids a hard dep just to probe for a CLI.)
#[cfg(target_os = "linux")]
fn which(bin: &str) -> bool {
    std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).any(|dir| dir.join(bin).is_file()))
        .unwrap_or(false)
}

// ── macOS / Windows backend: cpal + in-process resampling ──────────────────────────────────────

/// Open the default input device via cpal and stream 16kHz mono f32 frames to `tx`. The device
/// runs at its native rate/channels; each callback downmixes to mono and resamples to 16kHz.
#[cfg(not(target_os = "linux"))]
pub fn start_capture(tx: Sender<Vec<f32>>) -> Result<Capture> {
    use anyhow::{bail, Context};
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .context("no default audio input device")?;
    let supported = device
        .default_input_config()
        .context("no default input config for the device")?;
    let in_rate = supported.sample_rate().0;
    let channels = supported.channels() as usize;
    let sample_format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();

    let err_fn = |e| eprintln!("loom-voce: audio input stream error: {e}");

    // One streaming resampler (native rate → 16kHz mono) feeds `tx`. Built inside each sample-format
    // arm because every `build_input_stream` closure owns a differently-typed sample buffer.
    let stream = match sample_format {
        cpal::SampleFormat::F32 => {
            let mut rs = Resampler::new(in_rate, TARGET_RATE, channels);
            device.build_input_stream(
                &config,
                move |data: &[f32], _: &cpal::InputCallbackInfo| rs.push(data, |s| s, &tx),
                err_fn,
                None,
            )
        }
        cpal::SampleFormat::I16 => {
            let mut rs = Resampler::new(in_rate, TARGET_RATE, channels);
            device.build_input_stream(
                &config,
                move |data: &[i16], _: &cpal::InputCallbackInfo| {
                    rs.push(data, |s| s as f32 / 32768.0, &tx)
                },
                err_fn,
                None,
            )
        }
        cpal::SampleFormat::U16 => {
            let mut rs = Resampler::new(in_rate, TARGET_RATE, channels);
            device.build_input_stream(
                &config,
                move |data: &[u16], _: &cpal::InputCallbackInfo| {
                    rs.push(data, |s| (s as f32 - 32768.0) / 32768.0, &tx)
                },
                err_fn,
                None,
            )
        }
        other => bail!("unsupported audio input sample format: {other:?}"),
    }
    .context("failed to build the audio input stream")?;

    stream
        .play()
        .context("failed to start the audio input stream")?;
    Ok(Capture { stream })
}

/// A streaming linear-interpolation resampler: interleaved native-rate samples in, 16kHz mono
/// f32 frames out. Keeps the unconsumed input tail between callbacks so interpolation is seamless.
/// Linear (not sinc) is deliberate — adequate for speech dictation and dependency-free.
#[cfg(not(target_os = "linux"))]
struct Resampler {
    /// Input samples advanced per output sample (`in_rate / out_rate`).
    step: f64,
    /// Fractional read cursor into `buf`.
    pos: f64,
    channels: usize,
    /// Mono input accumulated at the native rate (drained as it's consumed).
    buf: Vec<f32>,
    /// 16kHz mono output accumulating toward one `FRAME_SAMPLES` frame.
    out: Vec<f32>,
}

#[cfg(not(target_os = "linux"))]
impl Resampler {
    fn new(in_rate: u32, out_rate: u32, channels: usize) -> Self {
        Self {
            step: in_rate as f64 / out_rate as f64,
            pos: 0.0,
            channels: channels.max(1),
            buf: Vec::new(),
            out: Vec::new(),
        }
    }

    /// Downmix interleaved `data` (each raw sample mapped to f32 by `to_f32`) to mono, resample
    /// native→16kHz, and emit ~30ms frames to `tx`.
    fn push<T: Copy>(&mut self, data: &[T], to_f32: impl Fn(T) -> f32, tx: &Sender<Vec<f32>>) {
        let ch = self.channels;
        for frame in data.chunks_exact(ch) {
            let sum: f32 = frame.iter().map(|&s| to_f32(s)).sum();
            self.buf.push(sum / ch as f32);
        }
        // Emit output samples while there's a sample past `pos` to interpolate toward.
        while (self.pos as usize) + 1 < self.buf.len() {
            let i = self.pos as usize;
            let frac = (self.pos - i as f64) as f32;
            self.out
                .push(self.buf[i] * (1.0 - frac) + self.buf[i + 1] * frac);
            self.pos += self.step;
            if self.out.len() >= FRAME_SAMPLES && tx.send(std::mem::take(&mut self.out)).is_err() {
                return; // consumer gone
            }
        }
        // Drop consumed input; keep the tail from floor(pos) so the next callback continues cleanly.
        let consumed = self.pos as usize;
        if consumed > 0 {
            self.buf.drain(0..consumed);
            self.pos -= consumed as f64;
        }
    }
}
