//! Microphone capture via cpal. Opens the default input device and streams frames to the STT loop
//! as 16kHz mono `f32` chunks (whisper.cpp's native format). We downmix to mono and naively
//! resample to 16kHz here so the rest of the pipeline is sample-rate-agnostic.
//!
//! NOTE: this is the v0 skeleton — the resampler is a simple linear decimation, good enough for
//! speech. Swap in `rubato` if you need higher fidelity.

use anyhow::{Context, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::mpsc::Sender;

/// whisper.cpp expects 16kHz mono.
pub const TARGET_RATE: u32 = 16_000;

/// Handle that keeps the cpal stream alive; drop it to stop capture.
pub struct Capture {
    _stream: cpal::Stream,
}

/// Open the default input device and start streaming 16kHz mono f32 frames to `tx`.
pub fn start_capture(tx: Sender<Vec<f32>>) -> Result<Capture> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .context("no default input device (is a mic connected?)")?;
    let config = device
        .default_input_config()
        .context("no default input config")?;
    let src_rate = config.sample_rate().0;
    let channels = config.channels() as usize;

    let err_fn = |e| eprintln!("loom-voce: audio stream error: {e}");

    // We only wire the f32 sample format here; extend with a match on config.sample_format()
    // for i16/u16 devices if your hardware needs it.
    let stream = device
        .build_input_stream(
            &config.into(),
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                let mono = downmix_mono(data, channels);
                let frame = resample_to_16k(&mono, src_rate);
                // Drop on a full/closed channel rather than block the audio callback.
                let _ = tx.send(frame);
            },
            err_fn,
            None,
        )
        .context("failed to build input stream")?;
    stream.play().context("failed to start input stream")?;
    Ok(Capture { _stream: stream })
}

/// Average interleaved channels down to mono.
fn downmix_mono(interleaved: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return interleaved.to_vec();
    }
    interleaved
        .chunks(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect()
}

/// Naive linear-interpolation resample from `src_rate` to 16kHz. Fine for speech; replace with
/// `rubato` for production fidelity.
fn resample_to_16k(mono: &[f32], src_rate: u32) -> Vec<f32> {
    if src_rate == TARGET_RATE || mono.is_empty() {
        return mono.to_vec();
    }
    let ratio = TARGET_RATE as f32 / src_rate as f32;
    let out_len = (mono.len() as f32 * ratio).round() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src_pos = i as f32 / ratio;
        let idx = src_pos.floor() as usize;
        let frac = src_pos - idx as f32;
        let a = mono.get(idx).copied().unwrap_or(0.0);
        let b = mono.get(idx + 1).copied().unwrap_or(a);
        out.push(a + (b - a) * frac);
    }
    out
}
