//! loom-voce — speak into a Loom pane.
//!
//! Voice dictation for the Loom terminal control room. loom-voce is a standalone tool that plugs
//! into Loom's existing inter-pane control bus (ADR-0007): it captures the mic, transcribes speech
//! locally with whisper.cpp, and delivers the transcript by shelling out to the `loom` CLI —
//! `loom send <pane> <text>` (or `loom broadcast`). It never touches Loom's internals; it's just
//! another client of the bus, the same way an agent in one pane drives the others.
//!
//! Default flow is **push-to-talk**: press <Enter> to start an utterance, the VAD ends it on
//! silence, whisper transcribes, and the text is typed into the target pane. `--continuous` runs
//! hands-free (each VAD-gated utterance is sent as it completes).
//!
//! Target resolution:
//!   • --pane <name>   → that pane
//!   • --broadcast     → every live pane in the active workspace (`loom broadcast`)
//!   • (default)       → the focused pane, discovered from `loom list` (the `*` marker)

use anyhow::{Context, Result};
use clap::Parser;
use std::io::{self, BufRead, Write};
use std::sync::mpsc;

use loom_voce::audio;
use loom_voce::loom::{self, Target};
use loom_voce::stt::{self, CaptureExt, Utterance};

/// Speak into a Loom pane. Runs alongside a Loom window; talks to it over `$LOOM_SOCK` via `loom`.
#[derive(Parser, Debug)]
#[command(
    name = "loom-voce",
    version,
    about = "Speech-to-text dictation into Loom panes"
)]
struct Cli {
    /// Dictate into a specific pane by name. Default: the focused pane (from `loom list`).
    #[arg(long)]
    pane: Option<String>,

    /// Dictate to every live pane in the active workspace (wraps `loom broadcast`).
    #[arg(long, conflicts_with = "pane")]
    broadcast: bool,

    /// Hands-free: VAD auto-segments each utterance and sends it. Default is push-to-talk.
    #[arg(long)]
    continuous: bool,

    /// Deliver the transcript without pressing Enter (compose, submit manually).
    #[arg(long)]
    no_enter: bool,

    /// Whisper model to load (tiny.en, base.en, small.en, medium.en, …). Downloaded on first use.
    #[arg(long, default_value = "base.en")]
    model: String,
}

fn main() -> Result<()> {
    let cli = Cli::parse();

    // Resolve the target pane up front so we fail fast if Loom isn't reachable.
    let target = if cli.broadcast {
        Target::Broadcast
    } else {
        loom::resolve_target(cli.pane.as_deref()).context("could not resolve target pane")?
    };
    eprintln!("loom-voce → {}  (model {})", target.describe(), cli.model);

    // Load the STT engine (blocks while whisper.cpp mmaps the model).
    let mut engine = stt::WhisperStt::load(&cli.model).context("failed to load whisper model")?;

    // Start mic capture on its own thread; frames arrive as 16kHz mono f32 chunks.
    let (frames_tx, frames_rx) = mpsc::channel::<Vec<f32>>();
    let _capture = audio::start_capture(frames_tx).context("failed to open microphone")?;

    if cli.continuous {
        run_continuous(&mut engine, frames_rx, &target, !cli.no_enter)
    } else {
        run_push_to_talk(&mut engine, frames_rx, &target, !cli.no_enter)
    }
}

/// Push-to-talk: wait for <Enter>, capture one VAD-gated utterance, transcribe, deliver, repeat.
/// (True hold-to-talk needs OS key-up events; that arrives with the Loom-side hotkey — see README.)
fn run_push_to_talk(
    engine: &mut stt::WhisperStt,
    frames_rx: mpsc::Receiver<Vec<f32>>,
    target: &Target,
    enter: bool,
) -> Result<()> {
    let stdin = io::stdin();
    let mut lines = stdin.lock().lines();
    println!("push-to-talk: press <Enter> to speak, Ctrl-C to quit.");

    loop {
        print!("🎙  ");
        io::stdout().flush().ok();
        // Blocking read of one line = the "press to talk" gate.
        match lines.next() {
            Some(Ok(_)) => {}
            _ => break, // EOF / Ctrl-D
        }

        // Drain any frames captured before we were listening, then record one utterance.
        let utt = Utterance::capture(&frames_rx);
        if utt.is_empty() {
            continue;
        }
        let text = engine.transcribe(&utt)?;
        let text = text.trim();
        if text.is_empty() {
            println!("(heard nothing)");
            continue;
        }
        println!("“{text}”");
        loom::deliver(target, text, enter)?;
    }
    Ok(())
}

/// Hands-free: continuously segment the mic stream and send each utterance as it completes.
fn run_continuous(
    engine: &mut stt::WhisperStt,
    frames_rx: mpsc::Receiver<Vec<f32>>,
    target: &Target,
    enter: bool,
) -> Result<()> {
    println!("continuous: listening… Ctrl-C to quit.");
    let mut segmenter = stt::Segmenter::new();
    for frame in frames_rx {
        if let Some(utt) = segmenter.push(frame) {
            let text = engine.transcribe(&utt)?;
            let text = text.trim();
            if text.is_empty() {
                continue;
            }
            println!("“{text}”");
            loom::deliver(target, text, enter)?;
        }
    }
    Ok(())
}
