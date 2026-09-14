//! loom-voce: the hub's speech-to-text sidecar (ADR-0009).
//!
//! `loom-voce --model <ggml file> [--threads N]` loads the model, prints `ready`, then reads
//! `transcribe` commands on stdin and answers each on stdout, one at a time. Exits when stdin closes.

mod audio;
mod protocol;

use audio::{pad_to_one_second, pcm16_to_f32, pick_language, SAMPLE_RATE};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use protocol::{Command, Event};
use std::io::{self, BufRead, Write};
use std::time::Instant;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

fn emit(event: &Event) {
    let mut out = io::stdout().lock();
    if serde_json::to_writer(&mut out, event).is_ok() {
        let _ = out.write_all(b"\n");
        let _ = out.flush();
    }
}

struct Args {
    model: String,
    threads: i32,
}

fn parse_args() -> Result<Args, String> {
    let mut model = None;
    let mut threads = std::thread::available_parallelism()
        .map(|n| n.get() as i32)
        .unwrap_or(4)
        .min(8);
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--model" => model = it.next(),
            "--threads" => {
                threads = it
                    .next()
                    .and_then(|v| v.parse().ok())
                    .filter(|n| *n > 0)
                    .ok_or("--threads needs a positive number")?
            }
            "--version" => {
                println!("loom-voce {}", env!("CARGO_PKG_VERSION"));
                std::process::exit(0);
            }
            other => return Err(format!("unknown argument {other}")),
        }
    }
    Ok(Args {
        model: model.ok_or("--model <path to ggml model> is required")?,
        threads,
    })
}

struct Whisper {
    ctx: WhisperContext,
    threads: i32,
    multilingual: bool,
}

impl Whisper {
    fn transcribe(
        &self,
        samples: &[f32],
        requested: Option<&str>,
        prompt: Option<&str>,
    ) -> Result<(String, &'static str), String> {
        let mut state = self
            .ctx
            .create_state()
            .map_err(|e| format!("whisper state: {e}"))?;
        let language = if !self.multilingual {
            "en"
        } else if matches!(requested, Some("en") | Some("pt")) {
            pick_language(requested, 0.0, 0.0)
        } else {
            state
                .pcm_to_mel(samples, self.threads as usize)
                .map_err(|e| format!("whisper mel: {e}"))?;
            let (_, probs) = state
                .lang_detect(0, self.threads as usize)
                .map_err(|e| format!("whisper language detection: {e}"))?;
            let prob = |code: &str| {
                whisper_rs::get_lang_id(code)
                    .and_then(|id| probs.get(id as usize).copied())
                    .unwrap_or(0.0)
            };
            pick_language(None, prob("en"), prob("pt"))
        };

        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_language(Some(language));
        params.set_n_threads(self.threads);
        params.set_translate(false);
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        params.set_suppress_blank(true);
        if let Some(prompt) = prompt.filter(|p| !p.trim().is_empty()) {
            params.set_initial_prompt(prompt);
        }
        state
            .full(params, samples)
            .map_err(|e| format!("whisper: {e}"))?;

        let mut text = String::new();
        for i in 0..state.full_n_segments() {
            if let Some(segment) = state.get_segment(i) {
                text.push_str(
                    segment
                        .to_str()
                        .map_err(|e| format!("whisper segment {i}: {e}"))?,
                );
            }
        }
        Ok((text.trim().to_string(), language))
    }
}

fn main() {
    let args = match parse_args() {
        Ok(a) => a,
        Err(message) => {
            emit(&Event::Error { id: None, message });
            std::process::exit(2);
        }
    };
    whisper_rs::install_logging_hooks();
    let ctx =
        match WhisperContext::new_with_params(&args.model, WhisperContextParameters::default()) {
            Ok(ctx) => ctx,
            Err(e) => {
                emit(&Event::Error {
                    id: None,
                    message: format!("cannot load whisper model {}: {e}", args.model),
                });
                std::process::exit(1);
            }
        };
    let engine = Whisper {
        multilingual: ctx.is_multilingual(),
        ctx,
        threads: args.threads,
    };
    emit(&Event::Ready {
        version: env!("CARGO_PKG_VERSION"),
        model: args.model.clone(),
        multilingual: engine.multilingual,
        gpu: cfg!(feature = "cuda"),
    });

    for line in io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let command = match serde_json::from_str::<Command>(&line) {
            Ok(c) => c,
            Err(e) => {
                emit(&Event::Error {
                    id: None,
                    message: format!("bad command: {e}"),
                });
                continue;
            }
        };
        match command {
            Command::Transcribe {
                id,
                pcm,
                language,
                prompt,
            } => {
                let started = Instant::now();
                let event = match B64.decode(pcm.as_bytes()) {
                    Err(e) => Event::Error {
                        id: Some(id),
                        message: format!("bad audio: {e}"),
                    },
                    Ok(bytes) => {
                        let samples = pcm16_to_f32(&bytes);
                        let audio_ms = (samples.len() * 1000 / SAMPLE_RATE) as u64;
                        match engine.transcribe(
                            &pad_to_one_second(samples),
                            language.as_deref(),
                            prompt.as_deref(),
                        ) {
                            Ok((text, language)) => Event::Transcript {
                                id,
                                text,
                                language: language.to_string(),
                                audio_ms,
                                took_ms: started.elapsed().as_millis() as u64,
                            },
                            Err(message) => Event::Error {
                                id: Some(id),
                                message,
                            },
                        }
                    }
                };
                emit(&event);
            }
        }
    }
}
