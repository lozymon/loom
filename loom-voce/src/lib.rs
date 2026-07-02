//! loom-voce library: mic capture, VAD + whisper.cpp transcription, and delivery into Loom panes
//! over the control bus. The `loom-voce` binary (`src/main.rs`) is a thin CLI over these modules;
//! exposing them as a library lets examples and tests drive the STT path directly.

pub mod audio;
pub mod loom;
pub mod stt;
