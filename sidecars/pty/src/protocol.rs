//! Wire protocol between the Loom hub and this sidecar: one JSON object per line.
//! Mirrors `hub/src/pty/sidecarProtocol.ts`.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Hub to sidecar.
#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum Command {
    Spawn {
        id: u32,
        program: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        cwd: Option<String>,
        /// Added to the inherited environment.
        #[serde(default)]
        env: HashMap<String, String>,
        cols: u16,
        rows: u16,
    },
    /// `data` is base64 bytes.
    Write {
        id: u32,
        data: String,
    },
    Resize {
        id: u32,
        cols: u16,
        rows: u16,
    },
    Kill {
        id: u32,
    },
}

/// Sidecar to hub.
#[derive(Debug, Serialize)]
#[serde(tag = "ev", rename_all = "lowercase")]
pub enum Event {
    Ready {
        version: &'static str,
        platform: &'static str,
    },
    Spawned {
        id: u32,
        pid: Option<u32>,
    },
    /// `data` is base64 bytes, coalesced.
    Output {
        id: u32,
        data: String,
    },
    /// Sent once, after the terminal's last output.
    Exit {
        id: u32,
        code: i64,
    },
    Error {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<u32>,
        message: String,
    },
}
