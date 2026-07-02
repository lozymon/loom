# loom-voce

Speak into a [Loom](../loom) terminal pane.

`loom-voce` is a standalone voice-dictation tool for the Loom control room. It captures your mic,
transcribes speech **locally** with whisper.cpp, and types the transcript into a Loom pane by
shelling out to the `loom` CLI — `loom send <pane> <text>` (or `loom broadcast`). It never touches
Loom's internals; it's just another client of Loom's inter-pane control bus (ADR-0007), the same way
an agent running in one pane drives the others.

## Why a separate tool

Loom's stack is deliberately lean (`std + serde_json` for its CLI/MCP faces). Speech-to-text drags
in audio capture + a whisper model — heavy, its own release cadence, and squarely "product logic",
which Loom keeps out of Rust. The clean seam already exists: the `$LOOM_SOCK` control bus. So
loom-voce lives beside `loom`/`termcore`/`termhaus` and plugs into that bus instead of bloating the
Loom binary.

## Design

```
 mic ──cpal──▶ 16kHz mono f32 ──VAD──▶ utterance ──whisper.cpp──▶ text ──▶ `loom send <pane>`
```

- **audio.rs** — cpal capture, downmix to mono, resample to 16kHz.
- **stt.rs** — VAD segmentation (utterance boundaries) + the whisper.cpp engine wrapper.
- **loom.rs** — target resolution (`--pane`, `--broadcast`, or the focused pane from `loom list`)
  and delivery via the `loom` CLI. The transcript is piped through **stdin**, not argv, so arbitrary
  spoken text can't break shell quoting.
- **main.rs** — CLI + the push-to-talk / continuous loops.

## Usage

```sh
loom-voce                 # push-to-talk into the FOCUSED pane (default)
loom-voce --pane Cleo     # dictate into a named pane
loom-voce --broadcast     # dictate to every live pane in the active workspace
loom-voce --continuous    # hands-free; VAD sends each utterance as it completes
loom-voce --no-enter      # type the text but don't press Enter
loom-voce --model small.en
```

Push-to-talk (the default): press **Enter** to start an utterance; the VAD ends it on ~0.7s of
silence, whisper transcribes, and the text lands in the target pane.

## Status: v0 skeleton

The audio → VAD → `loom send` path is wired end-to-end. **The whisper binding is stubbed** — see the
wiring guide in `src/stt.rs` (`WhisperStt::load` / `transcribe`): resolve/download a ggml model to
`~/.cache/loom-voce/`, construct a `whisper_rs::WhisperContext`, and run `FullParams`. Until then
`transcribe` returns an explanatory error, but the mic capture, VAD segmentation, and pane delivery
all run.

Also v0-simple and marked for upgrade:
- VAD is an RMS energy gate (`src/stt.rs`) — swap in Silero (`voice_activity_detector`) for noise.
- Resampler is linear decimation (`src/audio.rs`) — swap in `rubato` for fidelity.

## Roadmap

- Wire the real whisper.cpp binding.
- **Loom-side hotkey**: a push-to-talk keybinding inside Loom (`lib/keybindings.ts`) that spawns
  `loom-voce --pane <focused>` and shows a 🎙 "listening" indicator. This is where *true*
  hold-to-talk lands — the webview has OS key-up events a terminal doesn't.
- Optional `--backend deepgram|openai` streaming backend for lower latency.

## Build

Needs Rust (workspace uses 1.96) and a C toolchain for whisper.cpp (cmake + clang; no sudo — it
builds in-tree). `loom` must be on `PATH` (or `$LOOM_BIN` set) with a Loom window running.

```sh
cargo build --release
./target/release/loom-voce
```
