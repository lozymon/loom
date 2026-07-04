//! Microphone capture by shelling out to the system recorder (`parecord`/`arecord`), reading raw
//! 16kHz mono s16le PCM from its stdout, and streaming it to the STT loop as f32 frames.
//!
//! Why not a Rust audio crate (cpal)? On a no-sudo Linux box, cpal needs the ALSA `-dev` headers
//! (`libasound2-dev`) to build. `parecord` (PulseAudio) / `arecord` (ALSA) ship on every desktop,
//! resample to 16kHz for us, and need no build-time system headers — a far better fit for Loom's
//! Linux-first, no-sudo world. If you later want in-process capture, drop cpal back in behind this
//! same `start_capture` seam.

use anyhow::{bail, Context, Result};
use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::Sender;

/// whisper.cpp expects 16kHz mono.
pub const TARGET_RATE: u32 = 16_000;

/// ~30ms frames: 480 samples at 16kHz. Small enough for responsive VAD.
const FRAME_SAMPLES: usize = 480;

/// Handle that keeps the recorder subprocess alive; drop it to stop capture (child is killed).
pub struct Capture {
    child: Child,
}

impl Drop for Capture {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Spawn the system recorder and stream 16kHz mono f32 frames to `tx` from a reader thread.
pub fn start_capture(tx: Sender<Vec<f32>>) -> Result<Capture> {
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
fn spawn_recorder() -> Result<Child> {
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
fn which(bin: &str) -> bool {
    std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).any(|dir| dir.join(bin).is_file()))
        .unwrap_or(false)
}
