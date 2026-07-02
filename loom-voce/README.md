# loom-voce

Speak into a Loom terminal pane.

`loom-voce` captures your mic, transcribes speech **locally** with whisper.cpp, and types the
transcript into a Loom pane by shelling out to the `loom` CLI — `loom send <pane> <text>` (or
`loom broadcast`). It never touches Loom's internals; it's just another client of Loom's inter-pane
control bus (ADR-0007), the same way an agent running in one pane drives the others.

## A co-located, independent crate

loom-voce lives inside the Loom repo (`loom-voce/`) but is a **standalone Cargo crate — not a
workspace member**, so it's kept out of Loom's default and CI builds: the heavy whisper.cpp + cmake
toolchain never touches `src-tauri`. It builds to its **own** `loom-voce/target/`, and couples to
Loom only through the runtime `$LOOM_SOCK` control bus and the `loom send` CLI contract — no build
dependency in either direction, and no product logic pulled into Loom's Rust. One repo (atomic
cross-cutting changes, no version skew); two independent builds.

## Design

```
 mic ──parecord──▶ 16kHz mono s16le ──VAD──▶ utterance ──whisper.cpp──▶ text ──▶ `loom send <pane>`
```

- **audio.rs** — shells out to the system recorder (`parecord`, falling back to `arecord`) and reads
  raw 16kHz mono PCM from its stdout. No cpal / no ALSA `-dev` headers — a no-sudo-friendly choice.
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

`--once` captures a single utterance (no Enter gate), delivers it, and exits — this is what Loom's
**dictation hotkey (Ctrl+Shift+M)** spawns per keypress: tap the hotkey, speak, and it auto-sends.

## Status: v0 — whisper wired & verified

The full path runs end-to-end: mic → VAD → whisper.cpp → `loom send`. The whisper binding
(`whisper-rs` 0.14) is live in `src/stt.rs`: `WhisperStt::load` resolves/downloads a ggml model to
`~/.cache/loom-voce/` (via curl/wget) and builds a `WhisperContext`; `transcribe` runs `FullParams`
greedy decoding and returns the text. Verified against whisper.cpp's `jfk.wav` sample:

```
$ cargo run --example transcribe_file -- testdata/jfk.wav tiny.en
TRANSCRIPT: And so my fellow Americans ask not what your country can do for you ...
```

`cargo test` covers the pure logic (VAD gate + utterance segmentation).

v0-simple and marked for upgrade:
- VAD is an RMS energy gate (`src/stt.rs`) — swap in Silero (`voice_activity_detector`) for noise.
- Capture shells out to `parecord`; `parecord` already resamples to 16kHz for us.
- A fresh whisper state is created per utterance — reuse it for lower latency in `--continuous`.

## Roadmap

- ✅ Wire the real whisper.cpp binding (`whisper-rs` 0.14; verified on jfk.wav).
- ✅ **Loom-side hotkey** — Ctrl+Shift+M in Loom spawns `loom-voce --once --pane <focused>` and
  shows a pulsing 🎙 "listening" chip (Loom `src/lib/voceClient.ts` + `src-tauri/src/voce.rs`).
  loom-voce must be installed next to the `loom` binary (or on `PATH`).
- Persistent daemon mode so the model loads once instead of per keypress (latency).
- *True* hold-to-talk: record on key-down, stop on key-up (the webview has key-up events a
  terminal doesn't) — the current hotkey is tap-to-talk (VAD ends the utterance on silence).
- Optional `--backend deepgram|openai` streaming backend for lower latency.
- Reuse the whisper state across utterances in `--continuous` (currently one state per utterance).

## Build

Prereqs (all satisfiable without sudo):
- **Rust** 1.96.
- **cmake** to build whisper.cpp. If `pip` is available: `pip install cmake`. Otherwise drop a
  prebuilt static build on `PATH`, e.g.:
  ```sh
  curl -fL https://github.com/Kitware/CMake/releases/download/v3.31.6/cmake-3.31.6-linux-x86_64.tar.gz \
    | tar -xz -C ~/.local/opt
  export PATH="$HOME/.local/opt/cmake-3.31.6-linux-x86_64/bin:$PATH"
  ```
- A **C/C++ compiler** (`cc`/`c++`) and **libclang** (bindgen) — usually already present on a dev box.
- A **recorder at runtime** — `parecord` (pulseaudio-utils) or `arecord` (alsa-utils).
- **`loom`** on `PATH` (or `$LOOM_BIN` set), with a Loom window running.

Build from this crate's directory (it's not part of Loom's workspace, so build it explicitly):

```sh
cd loom-voce
cargo build --release
./target/release/loom-voce
```

### Wiring into Loom's dictation hotkey (Ctrl+Shift+M)

Loom's hotkey spawns `loom-voce --once`, resolving the binary in this order: `$LOOM_VOCE_BIN` →
a sibling of the `loom` binary → `loom-voce` on `PATH`. In dev, loom-voce builds to its own
`target/`, so point Loom at it:

```sh
export LOOM_VOCE_BIN="$PWD/target/release/loom-voce"   # from loom-voce/, before launching Loom
```

When shipped, install `loom-voce` next to the `loom` binary and no env var is needed.
