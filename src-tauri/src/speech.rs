// Read an agent's reply out loud (Piper TTS). A pure OS concern — like `voce.rs` (its
// speech-to-text mirror) and `editor.rs`, Rust only resolves a binary, shells out, and reports
// lifecycle. Everything that decides *what* gets spoken is product logic and lives in TS: the
// frontend pulls the reply out of Claude's transcript, strips it down to speakable prose
// (`lib/speech.ts`), and hands the finished string here. This module never sees pane output, so
// ADR-0001's opacity rule is untouched.
//
// Pipeline: `piper --model <voice>.onnx --output_file <tmp>.wav`, then the platform audio player.
// Synthesis-to-file rather than `--output-raw | aplay` because a raw pipe needs a per-platform
// PCM sink and the model's sample rate; a WAV carries its own header and every OS already has a
// player for one. A medium voice synthesises at many times realtime, so the lead-in is short.
//
// One utterance at a time: a new `speak` cancels whatever is currently talking (barge-in — the
// point of a read-aloud key is that you can cut it off). `speech://done` fires when the sound
// stops, however it stopped, so the frontend's "speaking" indicator always clears.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use tauri::{AppHandle, Emitter};

use crate::winproc::NoConsoleWindow;

/// Emitted when speech stops — finished, cancelled, or failed. Payload is the failure message
/// (`None` on a clean finish) so the frontend can surface a broken setup instead of silence.
const SPEECH_DONE_EVENT: &str = "speech://done";
/// Emitted while a voice model is being fetched on first use, so a 60 MB download reads as
/// progress rather than a hang. `done: true` is the final one.
const SPEECH_DOWNLOAD_EVENT: &str = "speech://download";

#[derive(Clone, serde::Serialize)]
struct SpeechDone {
    error: Option<String>,
}

#[derive(Clone, serde::Serialize)]
struct SpeechDownload {
    voice: String,
    bytes: u64,
    done: bool,
}

/// The child currently making sound (piper while synthesising, then the player). Held so `stop`
/// can kill whichever stage we're in.
fn active() -> &'static Mutex<Option<Child>> {
    static ACTIVE: OnceLock<Mutex<Option<Child>>> = OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(None))
}

/// Bumped by every `speak`/`stop`. A worker thread compares it against the generation it started
/// with and bails if it no longer owns the floor, so a superseded utterance can't emit `done` for
/// (or kill) the one that replaced it.
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// Kill whatever is currently speaking. Returns once the child is signalled; reaping is the
/// worker thread's job.
fn kill_active() {
    if let Some(mut child) = active().lock().unwrap().take() {
        let _ = child.kill();
    }
}

/// Wait for whatever child is in the slot, polling instead of blocking on `wait()`: a blocking
/// wait would hold the registry lock for the whole utterance, so `stop` could never take it to
/// kill the child — the read-aloud key would refuse to interrupt itself. `None` means the child
/// was taken away (cancelled or superseded).
fn wait_active() -> Option<std::process::ExitStatus> {
    loop {
        {
            let mut slot = active().lock().unwrap();
            match slot.as_mut()?.try_wait() {
                Ok(Some(status)) => return Some(status),
                Ok(None) => {}
                Err(_) => return None,
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(30));
    }
}

/// Speed bounds. The floor is piper's own comfortable slow end; the ceiling is one `atempo`
/// instance's limit (above 2.0 ffmpeg wants a chained filter, which isn't worth the complexity for
/// a read-aloud key).
const SPEED_MIN: f32 = 0.5;
const SPEED_MAX: f32 = 2.0;

/// How to reach a requested speaking rate.
///
/// The obvious lever, piper's `--length_scale`, turns out to be both non-linear and saturating:
/// measured on a medium voice, 0.5 ("2x") yields only ~1.43x and even 0.20 tops out near 1.88x —
/// it compresses phonemes rather than time, so a slider labelled 2x would simply lie. A
/// pitch-preserving time-stretch over the rendered WAV is exact (ffmpeg `atempo=2.0` measured
/// 2.016x) and is what podcast players do, so when ffmpeg is present we let piper speak naturally
/// and stretch afterwards.
///
/// Without ffmpeg we fall back to `--length_scale` and accept the approximation — a slower-than-
/// asked-for 2x still beats refusing to speed up at all — which is why the doctor check mentions
/// ffmpeg and Settings flags it.
struct RatePlan {
    /// Passed to piper when we have to do it the approximate way; `None` = speak naturally.
    length_scale: Option<f32>,
    /// Passed to ffmpeg's `atempo` afterwards for an exact rate; `None` = no post-processing.
    atempo: Option<f32>,
}

fn rate_plan(speed: f32, has_ffmpeg: bool) -> RatePlan {
    if (speed - 1.0).abs() < 0.01 {
        return RatePlan {
            length_scale: None,
            atempo: None,
        };
    }
    if has_ffmpeg {
        RatePlan {
            length_scale: None,
            atempo: Some(speed),
        }
    } else {
        RatePlan {
            length_scale: Some(1.0 / speed),
            atempo: None,
        }
    }
}

/// Is ffmpeg available for the exact time-stretch? Looked up per utterance — cheap next to
/// synthesis, and it means installing ffmpeg takes effect without restarting Loom.
fn have_ffmpeg() -> bool {
    on_path(if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    })
}

/// Longest utterance we'll synthesise. The frontend already trims to speakable prose; this is the
/// backstop against someone asking us to read a 200 KB transcript dump aloud.
const MAX_CHARS: usize = 20_000;

/// Piper's binary name (Windows appends `.exe`, mirroring `voce.rs`).
fn piper_name() -> &'static str {
    if cfg!(windows) {
        "piper.exe"
    } else {
        "piper"
    }
}

/// Locate `piper`, in order: an explicit `$LOOM_PIPER_BIN` override; a sibling of the running
/// `loom` binary; then the bare name on `PATH`. Same resolution order as `voce_bin`, so the two
/// helpers are configured the same way. Unlike loom-voce, piper is *not* bundled — it's a
/// third-party binary the user installs (`loom doctor` reports whether it resolved).
fn piper_bin() -> PathBuf {
    if let Some(p) = std::env::var_os("LOOM_PIPER_BIN") {
        let p = PathBuf::from(p);
        if p.is_file() {
            return p;
        }
    }
    if let Some(dir) = crate::control::loom_bin().and_then(|p| p.parent().map(PathBuf::from)) {
        let cand = dir.join(piper_name());
        if cand.is_file() {
            return cand;
        }
    }
    PathBuf::from(piper_name())
}

/// Where a downloaded voice lives: `<cache>/loom-speech/<voice>.onnx` plus the `.onnx.json` config
/// piper needs beside it, and the `.part` file a download fills first. Mirrors loom-voce's model
/// cache layout so both helpers cache under the same root.
fn voice_paths(voice: &str) -> Option<(PathBuf, PathBuf)> {
    let dir = crate::voce::cache_root()?.join("loom-speech");
    let onnx = dir.join(format!("{voice}.onnx"));
    let config = dir.join(format!("{voice}.onnx.json"));
    Some((onnx, config))
}

/// The upstream path for a Piper voice id like `en_US-lessac-medium` →
/// `en/en_US/lessac/medium/en_US-lessac-medium.onnx` in the `rhasspy/piper-voices` repo. `None`
/// for an id that isn't in `<locale>-<name>-<quality>` shape.
fn voice_url(voice: &str, suffix: &str) -> Option<String> {
    let (head, quality) = voice.rsplit_once('-')?;
    let (locale, name) = head.split_once('-')?;
    let lang = locale.split_once('_').map(|(l, _)| l).unwrap_or(locale);
    Some(format!(
        "https://huggingface.co/rhasspy/piper-voices/resolve/main/{lang}/{locale}/{name}/{quality}/{voice}.onnx{suffix}"
    ))
}

/// True when a file exists and is non-empty (a finished download).
fn present(path: &Path) -> bool {
    path.metadata().map(|m| m.len() > 0).unwrap_or(false)
}

/// Fetch `url` to `dest` via curl (falling back to wget), atomically through a `.part` file so an
/// interrupted download never leaves a truncated model that looks valid. Mirrors loom-voce's
/// `stt.rs::download` — same tools, same atomicity, so neither helper needs an HTTP crate.
fn download(url: &str, dest: &Path) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("cannot create {parent:?}: {e}"))?;
    }
    let part = dest.with_extension("part");
    let ok = if on_path(if cfg!(windows) { "curl.exe" } else { "curl" }) {
        Command::new("curl")
            .args(["-fsSL", "--retry", "2", "-o"])
            .arg(&part)
            .arg(url)
            .no_console_window()
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    } else {
        Command::new("wget")
            .args(["-q", "-O"])
            .arg(&part)
            .arg(url)
            .no_console_window()
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    };
    if !ok {
        let _ = std::fs::remove_file(&part);
        return Err(format!("download failed: {url}"));
    }
    std::fs::rename(&part, dest).map_err(|e| format!("cannot finalize download: {e}"))
}

/// Is `name` runnable (on PATH, or given as a path that exists)? A `--version` probe would spawn a
/// process per call, so we just walk PATH.
fn on_path(name: &str) -> bool {
    if Path::new(name).is_file() {
        return true;
    }
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|dir| dir.join(name).is_file())
}

/// Ensure the voice model + its config are cached, downloading both on first use. Emits
/// `speech://download` around a real fetch so the UI can show the wait.
fn ensure_voice(app: &AppHandle, voice: &str) -> Result<PathBuf, String> {
    let (onnx, config) =
        voice_paths(voice).ok_or_else(|| "no cache directory for the voice model".to_string())?;
    if present(&onnx) && present(&config) {
        return Ok(onnx);
    }
    let _ = app.emit(
        SPEECH_DOWNLOAD_EVENT,
        SpeechDownload {
            voice: voice.to_string(),
            bytes: 0,
            done: false,
        },
    );
    let result = (|| {
        if !present(&onnx) {
            let url = voice_url(voice, "").ok_or_else(|| {
                format!("'{voice}' is not a Piper voice id (expected e.g. en_US-lessac-medium)")
            })?;
            download(&url, &onnx)?;
        }
        if !present(&config) {
            let url = voice_url(voice, ".json").ok_or_else(|| "bad voice id".to_string())?;
            download(&url, &config)?;
        }
        Ok(onnx.clone())
    })();
    let _ = app.emit(
        SPEECH_DOWNLOAD_EVENT,
        SpeechDownload {
            voice: voice.to_string(),
            bytes: onnx.metadata().map(|m| m.len()).unwrap_or(0),
            done: true,
        },
    );
    result
}

/// Time-stretch `src` into `dst` by `tempo` using ffmpeg's `atempo`, which changes duration
/// without changing pitch. Runs to completion (a few hundred ms next to synthesis) rather than
/// being registered as cancellable — `stop` still kills the playback that follows.
fn stretch(src: &Path, dst: &Path, tempo: f32) -> Result<(), String> {
    let status = Command::new("ffmpeg")
        .args(["-y", "-loglevel", "error", "-i"])
        .arg(src)
        .arg("-filter:a")
        .arg(format!("atempo={tempo:.3}"))
        .arg("-f")
        .arg("wav")
        .arg(dst)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .no_console_window()
        .status()
        .map_err(|e| format!("ffmpeg failed to start: {e}"))?;
    if !status.success() {
        return Err(format!("ffmpeg exited with {status}"));
    }
    Ok(())
}

/// Build the platform's "play this WAV file" command. Linux has no single answer, so we take the
/// first sink that's actually installed (PipeWire → PulseAudio → ALSA → ffmpeg's player).
fn player_for(path: &Path) -> Result<Command, String> {
    #[cfg(target_os = "macos")]
    {
        let mut c = Command::new("afplay");
        c.arg(path);
        return Ok(c);
    }
    #[cfg(windows)]
    {
        let mut c = Command::new("powershell");
        c.args(["-NoProfile", "-Command"]).arg(format!(
            "(New-Object Media.SoundPlayer '{}').PlaySync()",
            path.display()
        ));
        return Ok(c);
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        for (bin, args) in [
            ("pw-play", &[][..]),
            ("paplay", &[][..]),
            ("aplay", &["-q"][..]),
            (
                "ffplay",
                &["-nodisp", "-autoexit", "-loglevel", "quiet"][..],
            ),
        ] {
            if on_path(bin) {
                let mut c = Command::new(bin);
                c.args(args).arg(path);
                return Ok(c);
            }
        }
        Err("no audio player found — install pipewire-utils, pulseaudio-utils or alsa-utils".into())
    }
}

/// Speak `text` with the Piper `voice` (e.g. `en_US-lessac-medium`). Cancels any utterance already
/// in progress, then returns immediately — synthesis and playback run on a worker thread and end
/// with a `speech://done` event carrying any error.
#[tauri::command]
pub fn speech_speak(
    app: AppHandle,
    text: String,
    voice: Option<String>,
    speed: Option<f32>,
) -> Result<(), String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("nothing to read".into());
    }
    let text: String = text.chars().take(MAX_CHARS).collect();
    let voice = voice
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or("en_US-lessac-medium")
        .to_string();
    let speed = speed.unwrap_or(1.0).clamp(SPEED_MIN, SPEED_MAX);

    kill_active();
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;

    std::thread::spawn(move || {
        let outcome = synthesize_and_play(&app, generation, &text, &voice, speed);
        // Only the utterance that still owns the floor reports done — a superseded one stays quiet
        // so it can't clear the indicator belonging to the utterance that replaced it.
        if GENERATION.load(Ordering::SeqCst) == generation {
            active().lock().unwrap().take();
            let _ = app.emit(
                SPEECH_DONE_EVENT,
                SpeechDone {
                    error: outcome.err(),
                },
            );
        }
    });
    Ok(())
}

/// The worker body: cache the voice, synthesise to a temp WAV, play it, clean up. Each stage
/// checks it still owns `generation`, so a `stop` or a newer utterance ends it promptly.
fn synthesize_and_play(
    app: &AppHandle,
    generation: u64,
    text: &str,
    voice: &str,
    speed: f32,
) -> Result<(), String> {
    let model = ensure_voice(app, voice)?;
    if GENERATION.load(Ordering::SeqCst) != generation {
        return Ok(());
    }

    let wav = std::env::temp_dir().join(format!("loom-speech-{generation}.wav"));
    // How we reach `speed` depends on what's installed — see `rate_plan`.
    let plan = rate_plan(speed, have_ffmpeg());
    let bin = piper_bin();
    let mut cmd = Command::new(&bin);
    cmd.arg("--model")
        .arg(&model)
        .arg("--output_file")
        .arg(&wav);
    if let Some(ls) = plan.length_scale {
        cmd.arg("--length_scale").arg(format!("{ls:.3}"));
        // The pause piper leaves between sentences is a flat 0.2s that `--length_scale` does NOT
        // touch, so at speed it becomes a bigger and bigger share of the runtime. Shrink it to match.
        cmd.arg("--sentence_silence")
            .arg(format!("{:.3}", 0.2 / speed));
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .no_console_window();

    let mut piper = cmd.spawn().map_err(|e| {
        format!(
            "failed to launch {}: {e} — install piper and put it on PATH, or set $LOOM_PIPER_BIN",
            bin.display()
        )
    })?;
    // Piper reads the utterance on stdin; dropping the pipe is what tells it to synthesise.
    if let Some(mut stdin) = piper.stdin.take() {
        use std::io::Write;
        let _ = stdin.write_all(text.as_bytes());
    }
    *active().lock().unwrap() = Some(piper);
    let Some(status) = wait_active() else {
        return Ok(()); // cancelled while synthesising
    };
    if GENERATION.load(Ordering::SeqCst) != generation {
        let _ = std::fs::remove_file(&wav);
        return Ok(());
    }
    if !status.success() {
        let _ = std::fs::remove_file(&wav);
        return Err(format!("piper exited with {status}"));
    }

    // Exact rate, pitch preserved. A failure here is not fatal: we simply play the natural-rate
    // audio rather than dropping the utterance over a speed preference.
    let mut playing = wav.clone();
    if let Some(tempo) = plan.atempo {
        let stretched = std::env::temp_dir().join(format!("loom-speech-{generation}-x.wav"));
        match stretch(&wav, &stretched, tempo) {
            Ok(()) => playing = stretched,
            Err(e) => eprintln!("loom: speed change failed, playing at natural rate: {e}"),
        }
        if GENERATION.load(Ordering::SeqCst) != generation {
            let _ = std::fs::remove_file(&wav);
            let _ = std::fs::remove_file(&playing);
            return Ok(());
        }
    }

    let player = player_for(&playing)?
        .no_console_window()
        .spawn()
        .map_err(|e| format!("failed to play audio: {e}"))?;
    *active().lock().unwrap() = Some(player);
    wait_active(); // None = cancelled mid-sentence, which is a clean stop, not an error
    let _ = std::fs::remove_file(&wav);
    if playing != wav {
        let _ = std::fs::remove_file(&playing);
    }
    Ok(())
}

/// Stop the current utterance (the read-aloud key pressed again, or Esc). Idempotent — stopping
/// silence is a no-op. The worker thread sees the generation bump and stays quiet, so we emit
/// `speech://done` here to clear the indicator.
#[tauri::command]
pub fn speech_stop(app: AppHandle) {
    GENERATION.fetch_add(1, Ordering::SeqCst);
    kill_active();
    let _ = app.emit(SPEECH_DONE_EVENT, SpeechDone { error: None });
}

/// Whether ffmpeg is available for the exact pitch-preserving rate change. Settings surfaces this
/// so "2x sounds slower than 2x" has a visible cause (see `rate_plan`).
#[tauri::command]
pub fn speech_stretch_available() -> bool {
    have_ffmpeg()
}

/// Whether Piper resolved to a real binary — `loom doctor` and Settings show this so a missing
/// install is a visible, fixable state rather than a key that silently does nothing.
#[tauri::command]
pub fn speech_available() -> bool {
    let bin = piper_bin();
    bin.is_file() || on_path(piper_name())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn voice_url_maps_an_id_to_its_upstream_path() {
        assert_eq!(
            voice_url("en_US-lessac-medium", "").unwrap(),
            "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx"
        );
        // The config sits beside the model with a .json suffix.
        assert!(voice_url("en_US-lessac-medium", ".json")
            .unwrap()
            .ends_with(".onnx.json"));
        // Multi-word voice names keep their underscores and still split on the right dashes.
        assert_eq!(
            voice_url("en_GB-northern_english_male-medium", "").unwrap(),
            "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/northern_english_male/medium/en_GB-northern_english_male-medium.onnx"
        );
    }

    #[test]
    fn rate_plan_prefers_an_exact_stretch_and_falls_back_to_piper() {
        // With ffmpeg: piper speaks naturally and the rate is hit exactly afterwards.
        let p = rate_plan(2.0, true);
        assert_eq!(p.length_scale, None);
        assert_eq!(p.atempo, Some(2.0));

        // Without it, approximate with piper's own (non-linear, saturating) knob rather than
        // refusing to speed up at all.
        let p = rate_plan(2.0, false);
        assert_eq!(p.length_scale, Some(0.5));
        assert_eq!(p.atempo, None);
    }

    #[test]
    fn rate_plan_does_nothing_at_natural_speed() {
        for has_ffmpeg in [true, false] {
            let p = rate_plan(1.0, has_ffmpeg);
            assert_eq!(p.length_scale, None, "no resynthesis at 1x");
            assert_eq!(p.atempo, None, "no stretch at 1x");
        }
    }

    #[test]
    fn voice_url_rejects_a_malformed_id() {
        assert!(voice_url("lessac", "").is_none());
        assert!(voice_url("", "").is_none());
    }
}
