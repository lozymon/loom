//! Speech-to-text via whisper.cpp (through the `whisper-rs` bindings), plus the VAD-based
//! utterance segmentation that turns the continuous mic stream into discrete phrases.
//!
//! Two consumers:
//!   • push-to-talk uses `Utterance::capture` — record from the moment the user hits <Enter> until
//!     the VAD reports a trailing silence.
//!   • continuous uses `Segmenter::push` — feed every frame; it yields a completed `Utterance`
//!     each time speech is followed by enough silence.

use anyhow::{bail, Context, Result};
use std::io::Write;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

use whisper_rs::{
    install_logging_hooks, FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters,
};

use crate::audio::TARGET_RATE;

/// A completed utterance: 16kHz mono f32 samples ready for whisper.
pub type Utterance = Vec<f32>;

/// How much trailing silence ends an utterance.
const SILENCE_TAIL: Duration = Duration::from_millis(700);
/// Give up on a push-to-talk utterance that never sees any speech.
const NO_SPEECH_TIMEOUT: Duration = Duration::from_secs(6);
/// Safety cap on a hold-mode (`--hold`) utterance so a forgotten session can't record forever.
const MAX_HOLD: Duration = Duration::from_secs(300);

/// When set, `emit_level` prints each frame's mic level to stdout for a host UI meter (see `--emit-levels`).
static EMIT_LEVELS: AtomicBool = AtomicBool::new(false);

/// Enable/disable per-frame mic-level output on stdout. Called once from `main` per the CLI flag.
pub fn set_emit_levels(on: bool) {
    EMIT_LEVELS.store(on, Ordering::Relaxed);
}

/// RMS amplitude of a frame (0.0 = silence). The same energy measure the VAD gates on.
fn rms(frame: &[f32]) -> f32 {
    if frame.is_empty() {
        return 0.0;
    }
    (frame.iter().map(|s| s * s).sum::<f32>() / frame.len() as f32).sqrt()
}

/// If level output is enabled, print `@LVL <rms>` to stdout (flushed — stdout is a pipe to the host,
/// so it's block-buffered and a meter needs each line promptly). A machine line; human logs use stderr.
fn emit_level(level: f32) {
    if EMIT_LEVELS.load(Ordering::Relaxed) {
        let mut out = std::io::stdout().lock();
        let _ = writeln!(out, "@LVL {level:.4}");
        let _ = out.flush();
    }
}

// ------------------------------------------------------------------------------------------------
// Utterance capture (push-to-talk)
// ------------------------------------------------------------------------------------------------

/// Record a single utterance from `frames`: accumulate until we've seen speech and then a
/// `SILENCE_TAIL` of quiet, or until `NO_SPEECH_TIMEOUT` elapses with no speech at all.
pub trait CaptureExt {
    fn capture(frames: &Receiver<Vec<f32>>) -> Utterance;
    fn capture_hold(frames: &Receiver<Vec<f32>>, stop: &AtomicBool) -> Utterance;
}

impl CaptureExt for Utterance {
    fn capture(frames: &Receiver<Vec<f32>>) -> Utterance {
        let mut vad = Vad::new();
        let mut buf: Vec<f32> = Vec::new();
        let mut seen_speech = false;
        let mut silence = Duration::ZERO;
        let started = Instant::now();

        loop {
            match frames.recv_timeout(Duration::from_millis(200)) {
                Ok(frame) => {
                    let dur = frame_duration(frame.len());
                    emit_level(rms(&frame));
                    let voiced = vad.is_speech(&frame);
                    buf.extend_from_slice(&frame);

                    if voiced {
                        seen_speech = true;
                        silence = Duration::ZERO;
                    } else if seen_speech {
                        silence += dur;
                        if silence >= SILENCE_TAIL {
                            break;
                        }
                    }
                }
                // A recv timeout is NOT end-of-utterance: it just means no frame arrived this tick
                // (the recorder is still warming up, or the mic briefly stalled). Keep waiting — only
                // the no-speech deadline below gives up. (The old `while let Ok` broke the loop on the
                // very first gap, so any recorder startup latency returned an empty "heard nothing".)
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }

            // Give up only if no speech has been heard at all within the onset window.
            if !seen_speech && started.elapsed() >= NO_SPEECH_TIMEOUT {
                return Vec::new();
            }
        }
        buf
    }

    /// Hold mode: record everything (pauses included) until `stop` is set — the host's "finish"
    /// signal — or the `MAX_HOLD` safety cap. No VAD gating, so a monologue with pauses stays one
    /// utterance. Still streams levels for the meter. May return leading/trailing silence; whisper
    /// copes. Empty only if the mic never delivered a frame.
    fn capture_hold(frames: &Receiver<Vec<f32>>, stop: &AtomicBool) -> Utterance {
        let mut buf: Vec<f32> = Vec::new();
        let started = Instant::now();
        while !stop.load(Ordering::Relaxed) {
            match frames.recv_timeout(Duration::from_millis(100)) {
                Ok(frame) => {
                    emit_level(rms(&frame));
                    buf.extend_from_slice(&frame);
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
            if started.elapsed() >= MAX_HOLD {
                break;
            }
        }
        buf
    }
}

// ------------------------------------------------------------------------------------------------
// Streaming segmentation (continuous mode)
// ------------------------------------------------------------------------------------------------

/// Stateful segmenter for hands-free mode: push frames, get an `Utterance` back whenever speech is
/// followed by `SILENCE_TAIL` of quiet.
pub struct Segmenter {
    vad: Vad,
    buf: Vec<f32>,
    seen_speech: bool,
    silence: Duration,
}

impl Segmenter {
    pub fn new() -> Self {
        Self {
            vad: Vad::new(),
            buf: Vec::new(),
            seen_speech: false,
            silence: Duration::ZERO,
        }
    }

    /// Feed one frame; returns `Some(utterance)` when a phrase completes.
    pub fn push(&mut self, frame: Vec<f32>) -> Option<Utterance> {
        let dur = frame_duration(frame.len());
        emit_level(rms(&frame));
        let voiced = self.vad.is_speech(&frame);

        if voiced {
            self.seen_speech = true;
            self.silence = Duration::ZERO;
            self.buf.extend_from_slice(&frame);
        } else if self.seen_speech {
            self.buf.extend_from_slice(&frame);
            self.silence += dur;
            if self.silence >= SILENCE_TAIL {
                let utt = std::mem::take(&mut self.buf);
                self.seen_speech = false;
                self.silence = Duration::ZERO;
                return Some(utt);
            }
        }
        None
    }
}

impl Default for Segmenter {
    fn default() -> Self {
        Self::new()
    }
}

fn frame_duration(samples: usize) -> Duration {
    Duration::from_secs_f32(samples as f32 / TARGET_RATE as f32)
}

// ------------------------------------------------------------------------------------------------
// VAD
// ------------------------------------------------------------------------------------------------

/// Voice-activity gate. v0 is a simple RMS energy threshold — zero deps, works offline, good enough
/// to segment phrases in a quiet room. Swap in `voice_activity_detector` (Silero) for robustness in
/// noise; the interface (`is_speech(&frame) -> bool`) stays the same.
pub struct Vad {
    threshold: f32,
}

impl Vad {
    pub fn new() -> Self {
        Self { threshold: 0.015 }
    }

    pub fn is_speech(&mut self, frame: &[f32]) -> bool {
        if frame.is_empty() {
            return false;
        }
        let rms = (frame.iter().map(|s| s * s).sum::<f32>() / frame.len() as f32).sqrt();
        rms > self.threshold
    }
}

impl Default for Vad {
    fn default() -> Self {
        Self::new()
    }
}

// ------------------------------------------------------------------------------------------------
// Whisper engine
// ------------------------------------------------------------------------------------------------

/// whisper.cpp rejects clips shorter than ~1s, so we pad short utterances with trailing silence.
const MIN_SAMPLES: usize = TARGET_RATE as usize;

/// The whisper.cpp engine: a loaded model context plus decode settings. Transcribes one utterance
/// at a time (a fresh state per call — state reuse is a later optimization).
pub struct WhisperStt {
    ctx: WhisperContext,
    /// Forced decode language, or `None` to let a multilingual model auto-detect.
    language: Option<&'static str>,
    threads: i32,
}

impl WhisperStt {
    /// Load the named ggml model (downloading to the cache on first use) and mmap it.
    /// `model` is a short name like `base.en`, `small.en`, `medium` — resolved to
    /// `ggml-<model>.bin` under the loom-voce cache.
    pub fn load(model: &str) -> Result<Self> {
        // Route whisper.cpp/ggml's own logging through the `log` facade; with no logger installed
        // this silences its stderr chatter (which would otherwise clutter the dictation prompt).
        install_logging_hooks();

        let path = ensure_model(model)?;
        let ctx = WhisperContext::new_with_params(&path, WhisperContextParameters::default())
            .with_context(|| format!("failed to load whisper model at {}", path.display()))?;

        // English-only models (`*.en`) must be decoded as English; multilingual ones auto-detect.
        let language = if model.ends_with(".en") {
            Some("en")
        } else {
            None
        };
        let threads = std::thread::available_parallelism()
            .map(|n| n.get() as i32)
            .unwrap_or(4)
            .min(8);

        Ok(Self {
            ctx,
            language,
            threads,
        })
    }

    /// Transcribe one utterance to text.
    pub fn transcribe(&mut self, samples: &[f32]) -> Result<String> {
        let mut state = self
            .ctx
            .create_state()
            .context("failed to create whisper state")?;

        // Pad up to whisper's minimum clip length so short taps still decode.
        let mut audio;
        let input: &[f32] = if samples.len() < MIN_SAMPLES {
            audio = Vec::with_capacity(MIN_SAMPLES);
            audio.extend_from_slice(samples);
            audio.resize(MIN_SAMPLES, 0.0);
            &audio
        } else {
            samples
        };

        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_language(self.language);
        params.set_n_threads(self.threads);
        params.set_translate(false);
        // Keep the output text clean and quiet — no special tokens, no progress spew.
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        params.set_suppress_blank(true);

        state
            .full(params, input)
            .context("whisper transcription failed")?;

        // whisper-rs 0.16: `full_n_segments` returns the count directly, and per-segment text comes
        // from `get_segment(i).to_str()` (the old `full_get_segment_text` was removed).
        let n = state.full_n_segments();
        let mut text = String::new();
        for i in 0..n {
            if let Some(seg) = state.get_segment(i) {
                let s = seg
                    .to_str()
                    .with_context(|| format!("failed to read whisper segment {i}"))?;
                text.push_str(s);
            }
        }
        Ok(text)
    }
}

/// Resolve (downloading on first use) the ggml model file for `model`, returning its path.
/// Models are cached at `$XDG_CACHE_HOME/loom-voce/` (or `~/.cache/loom-voce/`) and pulled from
/// the canonical ggerganov/whisper.cpp Hugging Face repo.
fn ensure_model(model: &str) -> Result<PathBuf> {
    let dir = cache_dir()?.join("loom-voce");
    let path = dir.join(format!("ggml-{model}.bin"));
    if path.metadata().map(|m| m.len() > 0).unwrap_or(false) {
        return Ok(path);
    }

    std::fs::create_dir_all(&dir)
        .with_context(|| format!("cannot create cache dir {}", dir.display()))?;
    let url = format!("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-{model}.bin");
    eprintln!(
        "loom-voce: downloading model '{model}' → {}",
        path.display()
    );
    download(&url, &path).with_context(|| format!("failed to download model '{model}'"))?;
    Ok(path)
}

/// Download `url` to `dest` via curl (fallback wget), atomically through a `.part` file so an
/// interrupted download never leaves a truncated model that looks valid.
fn download(url: &str, dest: &PathBuf) -> Result<()> {
    let part = dest.with_extension("part");
    let ok = if which("curl") {
        Command::new("curl")
            .args(["-fL", "--progress-bar", "-o"])
            .arg(&part)
            .arg(url)
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    } else if which("wget") {
        Command::new("wget")
            .args(["-q", "--show-progress", "-O"])
            .arg(&part)
            .arg(url)
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    } else {
        bail!("need curl or wget to download the model");
    };
    if !ok {
        let _ = std::fs::remove_file(&part);
        bail!("downloader failed for {url}");
    }
    std::fs::rename(&part, dest).context("failed to finalize downloaded model")?;
    Ok(())
}

/// The per-user cache root for downloaded models. `$XDG_CACHE_HOME` wins everywhere when set;
/// otherwise the platform default: `$HOME/.cache` on Linux/macOS, `%LOCALAPPDATA%` (then
/// `%USERPROFILE%\.cache`) on Windows, where neither XDG_CACHE_HOME nor HOME normally exists.
fn cache_dir() -> Result<PathBuf> {
    if let Ok(x) = std::env::var("XDG_CACHE_HOME") {
        if !x.is_empty() {
            return Ok(PathBuf::from(x));
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        if !home.is_empty() {
            return Ok(PathBuf::from(home).join(".cache"));
        }
    }
    #[cfg(windows)]
    {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            if !local.is_empty() {
                return Ok(PathBuf::from(local));
            }
        }
        if let Ok(profile) = std::env::var("USERPROFILE") {
            if !profile.is_empty() {
                return Ok(PathBuf::from(profile).join(".cache"));
            }
        }
        bail!("no cache dir: set XDG_CACHE_HOME, HOME, LOCALAPPDATA, or USERPROFILE");
    }
    #[cfg(not(windows))]
    bail!("neither XDG_CACHE_HOME nor HOME is set");
}

/// Is `bin` on `PATH`? On Windows an executable is `bin.exe` (etc.), never the bare `bin`, so probe
/// each `PATHEXT` suffix as well — otherwise `which("curl")` misses the `curl.exe` that ships in
/// System32 and the model download wrongly reports "need curl or wget".
fn which(bin: &str) -> bool {
    let Some(paths) = std::env::var_os("PATH") else {
        return false;
    };
    let exts: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".EXE;.CMD;.BAT;.COM".into())
            .split(';')
            .filter(|e| !e.is_empty())
            .map(|e| e.to_string())
            .collect()
    } else {
        Vec::new()
    };
    std::env::split_paths(&paths).any(|dir| {
        if dir.join(bin).is_file() {
            return true;
        }
        exts.iter()
            .any(|ext| dir.join(format!("{bin}{ext}")).is_file())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(amplitude: f32) -> Vec<f32> {
        // One ~30ms frame at a constant magnitude (RMS == amplitude).
        vec![amplitude; 480]
    }

    #[test]
    fn vad_gates_on_energy() {
        let mut vad = Vad::new();
        assert!(!vad.is_speech(&frame(0.0)), "silence must not be speech");
        assert!(!vad.is_speech(&[]), "empty frame must not be speech");
        assert!(vad.is_speech(&frame(0.5)), "loud frame must be speech");
    }

    #[test]
    fn segmenter_emits_after_trailing_silence() {
        let mut seg = Segmenter::new();
        // Speech must not emit on its own.
        assert!(seg.push(frame(0.5)).is_none());
        // Feed silence until the tail threshold trips; it must emit exactly one utterance that
        // includes the leading speech frame.
        let mut emitted = None;
        for _ in 0..40 {
            if let Some(utt) = seg.push(frame(0.0)) {
                emitted = Some(utt);
                break;
            }
        }
        let utt = emitted.expect("an utterance should complete after the silence tail");
        assert!(
            utt.len() >= 480,
            "utterance should contain the speech frame"
        );
        // After emitting, the segmenter resets and won't re-emit on continued silence.
        assert!(seg.push(frame(0.0)).is_none());
    }

    #[test]
    fn segmenter_ignores_leading_silence() {
        let mut seg = Segmenter::new();
        for _ in 0..40 {
            assert!(
                seg.push(frame(0.0)).is_none(),
                "silence before any speech must never emit"
            );
        }
    }
}
