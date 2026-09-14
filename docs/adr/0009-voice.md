# Voice is captured on the client; local engines first, cloud fallback

**Status:** Accepted (2026-09-12).

## Decision

- **Languages:** English and Brazilian Portuguese (`pt_BR`), detected per utterance.
- **Speech to text:**
  - Local: whisper.cpp via `sidecars/voce` (v1 `loom-voce`), `medium` or quantized `large-v3-turbo` where a GPU exists.
  - Cloud: Groq transcription, through the hub so keys stay on the hub.
  - Input: hold `Ctrl+Shift+Space` in the desktop app; hold a button in browser clients. Transcript lands editable in the composer and is sent with Enter. Command-word auto-send ("send", "enviar") is opt-in.
- **Text to speech:**
  - Local: Piper with one English and one `pt_BR` voice.
  - Cloud: OpenAI TTS through the hub.
  - Zero-install fallback in browsers: the Web Speech API.
- **What is spoken** is opt-in per event class. Defaults: escalated approvals, session done or error, and the Cockpit's `speak` calls. Never tool output.
- **Audio is captured where the microphone is.** Clients send audio to the hub only when the engine runs there (cloud or a GPU hub).
- Everything spoken is also written. One mute switch, one stop key, per-hub quiet hours.

## Consequences

- WSL hubs and GPU-less Windows machines use cloud speech by default (ADR-0010).
- Approval cards are answerable by voice ("allow", "deny", "permitir", "negar"), which requires a confirmation step for anything on the always-ask list.

## As built (M8, 2026-09-13)

- **Recognition runs on a hub, capture in the client.** The browser records with `MediaRecorder`, decodes and resamples to 16 kHz mono itself, and sends a WAV in `voice.transcribe`; the hub needs no ffmpeg. The client picks the hub of the session it dictates to, else the active hub, else any connected hub that has an engine. Running whisper inside the desktop client stays possible for M9 but is not built.
- **`sidecars/voce`** is v1's `loom-voce` reduced to a JSON-lines transcriber (whisper-rs 0.16). The hub starts it on the first clip and stops it after 10 idle minutes. It compares whisper's English and Portuguese probabilities only, then decodes in the winner. On this CPU (i5-12400F, no CUDA build) an 11 s clip takes about 5.5 s with `small` (3 s with a fixed language) and 18 s with `medium`, so `small` is the default; `--features cuda` exists but is untested.
- **Engines** are chosen per hub in `hub.json` `voice` (`auto` by default): whisper if the sidecar and a model are present, else Groq with `GROQ_API_KEY`; read-back with Piper if configured, else OpenAI with `OPENAI_API_KEY`, else only the browser's voice. The hub never downloads models.
- **Short commands:** while the approvals panel is open the client sends `prompt: "Allow. Deny. Permitir. Negar."` (whisper's initial prompt, Groq's `prompt`). Without it, a one-word "Allow." was heard as "below."
- **Voice never decides an always-ask approval,** and never answers a question: the panel says to click. That is the confirmation step from the decision above. Accepted words: allow, approve, yes, permitir, aprovar, sim; deny, reject, no, negar, rejeitar, não, and only as the whole utterance.
- **`speak`** is a loom tool for every session and `loom say`; it records a `speech` event. Read-back applies to live events in each open tab; two tabs read twice.
- **Settings are per browser** (`loom.voice` in local storage): what to read, phrase language, browser or hub voice, dictation language, target, auto-send. Quiet hours are per hub and use the client's clock. Escape is the stop key.
- **The microphone needs a secure context:** `localhost`, `127.0.0.1`, or https. A client opened at a hub's Tailscale address over http has no microphone; open the client locally and add the remote hub, or use `loom tunnel`.
