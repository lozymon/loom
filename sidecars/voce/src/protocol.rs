//! The JSON-lines protocol between the hub and loom-voce. Mirrored in `hub/src/voice/voceProtocol.ts`.

use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "kebab-case")]
pub enum Command {
    /// Transcribe one clip. `pcm` is base64 of 16 kHz mono signed 16-bit little-endian samples.
    Transcribe {
        id: u64,
        pcm: String,
        /// `en`, `pt`, or absent for automatic choice between the two.
        #[serde(default)]
        language: Option<String>,
        /// Words to expect, e.g. command words; helps whisper with one-word clips.
        #[serde(default)]
        prompt: Option<String>,
    },
}

#[derive(Debug, Serialize)]
#[serde(tag = "ev", rename_all = "kebab-case")]
pub enum Event {
    Ready {
        version: &'static str,
        model: String,
        multilingual: bool,
        gpu: bool,
    },
    Transcript {
        id: u64,
        text: String,
        language: String,
        #[serde(rename = "audioMs")]
        audio_ms: u64,
        #[serde(rename = "tookMs")]
        took_ms: u64,
    },
    Error {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<u64>,
        message: String,
    },
}
