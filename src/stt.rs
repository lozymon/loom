//! Speech-to-text via whisper.cpp (through the `whisper-rs` bindings), plus the VAD-based
//! utterance segmentation that turns the continuous mic stream into discrete phrases.
//!
//! Two consumers:
//!   • push-to-talk uses `Utterance::capture` — record from the moment the user hits <Enter> until
//!     the VAD reports a trailing silence.
//!   • continuous uses `Segmenter::push` — feed every frame; it yields a completed `Utterance`
//!     each time speech is followed by enough silence.

use anyhow::{Context, Result};
use std::sync::mpsc::Receiver;
use std::time::Duration;

use crate::audio::TARGET_RATE;

/// A completed utterance: 16kHz mono f32 samples ready for whisper.
pub type Utterance = Vec<f32>;

/// How much trailing silence ends an utterance.
const SILENCE_TAIL: Duration = Duration::from_millis(700);
/// Give up on a push-to-talk utterance that never sees any speech.
const NO_SPEECH_TIMEOUT: Duration = Duration::from_secs(6);

// ------------------------------------------------------------------------------------------------
// Utterance capture (push-to-talk)
// ------------------------------------------------------------------------------------------------

/// Record a single utterance from `frames`: accumulate until we've seen speech and then a
/// `SILENCE_TAIL` of quiet, or until `NO_SPEECH_TIMEOUT` elapses with no speech at all.
pub trait CaptureExt {
    fn capture(frames: &Receiver<Vec<f32>>) -> Utterance;
}

impl CaptureExt for Utterance {
    fn capture(frames: &Receiver<Vec<f32>>) -> Utterance {
        let mut vad = Vad::new();
        let mut buf: Vec<f32> = Vec::new();
        let mut seen_speech = false;
        let mut silence = Duration::ZERO;
        let mut waited = Duration::ZERO;

        while let Ok(frame) = frames.recv_timeout(Duration::from_millis(200)) {
            let dur = frame_duration(frame.len());
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
            } else {
                waited += dur;
                if waited >= NO_SPEECH_TIMEOUT {
                    return Vec::new();
                }
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

/// The whisper.cpp engine wrapper. Holds the loaded model and transcribes one utterance at a time.
pub struct WhisperStt {
    // TODO(whisper-rs): hold `whisper_rs::WhisperContext` here once the model path is resolved.
    // Left abstract in the skeleton so `cargo check` passes before you wire the real binding.
    model_label: String,
}

impl WhisperStt {
    /// Load (downloading on first use) the named ggml model and mmap it.
    ///
    /// Wiring guide (whisper-rs 0.12):
    ///   1. Resolve a model path: `~/.cache/loom-voce/ggml-<model>.bin`, downloading from
    ///      https://huggingface.co/ggerganov/whisper.cpp if absent.
    ///   2. `let ctx = WhisperContext::new_with_params(&path, WhisperContextParameters::default())?;`
    ///   3. Store `ctx` in this struct.
    pub fn load(model: &str) -> Result<Self> {
        // Placeholder so the skeleton compiles and runs the audio/VAD path end-to-end.
        // Replace with the real WhisperContext load (see the doc comment above).
        Ok(Self {
            model_label: model.to_string(),
        })
    }

    /// Transcribe one utterance to text.
    ///
    /// Wiring guide (whisper-rs 0.12):
    ///   let mut state = self.ctx.create_state()?;
    ///   let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    ///   params.set_language(Some("en"));
    ///   params.set_print_special(false);
    ///   params.set_print_progress(false);
    ///   state.full(params, samples)?;
    ///   let n = state.full_n_segments()?;
    ///   let text = (0..n).map(|i| state.full_get_segment_text(i)).collect::<Result<String,_>>()?;
    pub fn transcribe(&mut self, samples: &[f32]) -> Result<String> {
        let _ = samples;
        // Skeleton stub: real transcription lands when WhisperContext is wired in `load`.
        Err(anyhow::anyhow!(
            "whisper transcription not yet wired (model '{}') — see src/stt.rs wiring guide",
            self.model_label
        ))
        .context("stub engine")
    }
}
