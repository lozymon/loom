//! Smoke-test the whisper path without a mic: read a 16kHz mono s16le WAV and transcribe it.
//!
//!   # fetch the classic whisper.cpp speech sample (16kHz mono):
//!   curl -fsSL -o testdata/jfk.wav \
//!     https://github.com/ggerganov/whisper.cpp/raw/master/samples/jfk.wav
//!   cargo run --example transcribe_file -- testdata/jfk.wav [model]
//!
//! Exercises the real pipeline — `WhisperStt::load` (downloading the model on first use) and
//! `transcribe` — with the same code the live dictation loop uses.

use std::path::Path;

use loom_voce::stt::WhisperStt;

fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let wav = args
        .next()
        .unwrap_or_else(|| "testdata/jfk.wav".to_string());
    let model = args.next().unwrap_or_else(|| "tiny.en".to_string());

    let samples = read_wav_s16le_mono(Path::new(&wav))?;
    eprintln!("loaded {} samples from {wav}", samples.len());

    let mut engine = WhisperStt::load(&model)?;
    let text = engine.transcribe(&samples)?;
    println!("TRANSCRIPT: {}", text.trim());
    Ok(())
}

/// Minimal WAV reader: find the `data` chunk and decode 16-bit little-endian PCM to f32 in [-1, 1].
/// Assumes 16kHz mono s16le (what loom-voce's capture produces); enough for the smoke test.
fn read_wav_s16le_mono(path: &Path) -> anyhow::Result<Vec<f32>> {
    let bytes = std::fs::read(path)?;
    anyhow::ensure!(
        bytes.len() > 44 && &bytes[0..4] == b"RIFF",
        "not a RIFF/WAV file"
    );

    // Walk chunks from offset 12 to find "data".
    let mut i = 12;
    while i + 8 <= bytes.len() {
        let id = &bytes[i..i + 4];
        let size =
            u32::from_le_bytes([bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]]) as usize;
        let body = i + 8;
        if id == b"data" {
            let end = (body + size).min(bytes.len());
            let pcm = &bytes[body..end];
            return Ok(pcm
                .chunks_exact(2)
                .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0)
                .collect());
        }
        i = body + size + (size & 1); // chunks are word-aligned
    }
    anyhow::bail!("no data chunk in WAV")
}
