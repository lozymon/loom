// Voice-dictation "you're talking" popup. A floating card shown while a `loom-voce` helper is
// capturing for a pane (the `listening` activity flag, raised on the dictation hotkey and cleared
// on the helper's exit via `voce://done`). Purely reflects existing UI state — nothing is read from
// pane output (ADR-0001); it's the same signal that drives the small 🎙 title-bar chip, surfaced as
// a prominent centre-screen indicator so it's obvious the mic is live.
//
// The bars are a real waveform: loom-voce streams per-frame mic levels (`voce://level` → the
// `voiceLevels` signal) and we scroll them right-to-left across the bar strip.

import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { activity } from "../stores/activity";
import { activeWorkspace } from "../stores/workspace";
import { voiceLevels, cancelDictation, finishDictation } from "../lib/voceClient";

/** Number of bars in the scrolling waveform strip. */
const BARS = 22;
/** A quiet floor so silence still shows a faint sliver rather than nothing. */
const LEVEL_FLOOR = 0.04;
/** How fast the auto-scale peak decays per frame (~32/s). <1 lets the meter re-sensitise after a
 *  loud moment so it works on both hot and quiet mics without a device-specific gain. */
const PEAK_DECAY = 0.99;
/** Below this peak we treat the input as silence (avoids amplifying mic hiss to full-scale). */
const SILENCE_PEAK = 0.02;

/** The first pane currently listening in the active workspace (id + display name), or null. */
function useListeningPane() {
  return createMemo(() => {
    const ws = activeWorkspace();
    if (!ws?.panes) return null;
    for (const key of Object.keys(ws.panes)) {
      const id = Number(key);
      if (activity[id]?.listening) return { id, title: ws.panes[id]?.title ?? "" };
    }
    return null;
  });
}

export default function ListeningOverlay() {
  const listening = useListeningPane();

  // True between pressing <Enter> (finish) and the helper exiting — i.e. while it transcribes and
  // delivers. Swaps the popup to a "Transcribing…" state so the pause reads as progress, not a hang.
  const [finishing, setFinishing] = createSignal(false);

  // Set while a first-use Whisper model is downloading for the listening pane (Rust watches
  // loom-voce's cache and pushes `voce://download` → the pane's downloadingModel/Bytes). Takes
  // precedence over Listening/Transcribing so the one-time fetch never looks like a hang.
  const downloading = createMemo(() => {
    const p = listening();
    if (!p) return null;
    const a = activity[p.id];
    return a?.downloadingModel ? { model: a.downloadingModel, bytes: a.downloadedBytes } : null;
  });
  const fmtMB = (b: number) => (b > 0 ? `${(b / 1_000_000).toFixed(0)} MB` : "starting…");

  // A scrolling ring of normalized bar heights (0..1), newest on the right. Fed by the mic level of
  // the listening pane; reset to flat whenever no pane is listening so each session starts clean.
  const [wave, setWave] = createSignal<number[]>(new Array(BARS).fill(0));
  // Auto-scale reference: the recent peak RMS, decaying each frame. Persists across effect runs so
  // the meter adapts to whatever absolute range this mic produces (a `let` closed over by the effect).
  let peak = 0;
  createEffect(() => {
    const pane = listening();
    if (!pane) {
      setWave(new Array(BARS).fill(0));
      setFinishing(false);
      peak = 0;
      return;
    }
    // Reading the level here subscribes the effect: every new `voce://level` shifts the strip.
    const rms = voiceLevels()[pane.title] ?? 0;
    peak = Math.max(rms, peak * PEAK_DECAY);
    const h = peak > SILENCE_PEAK ? Math.min(1, Math.max(LEVEL_FLOOR, rms / peak)) : LEVEL_FLOOR;
    setWave((w) => [...w.slice(1), h]);
  });

  // Keys while a pane is listening: Enter finishes (transcribe + deliver), Esc cancels (discard).
  // Capture-phase + stopImmediatePropagation so they fire before xterm's handler and don't also
  // reach the focused terminal (a raw Enter/ESC). Ignored once finishing is under way.
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      const pane = listening();
      if (!pane) return;
      // While the model is still downloading the helper hasn't started capturing — swallow Enter so
      // we don't buffer a premature "finish" that ends the capture the instant it begins.
      if (e.key === "Enter" && !finishing() && !downloading()) {
        e.preventDefault();
        e.stopImmediatePropagation();
        setFinishing(true);
        void finishDictation(pane.title);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        void cancelDictation(pane.title);
      }
    };
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => window.removeEventListener("keydown", onKey, true));
  });

  return (
    <Show when={listening()}>
      {(pane) => (
        <div class="voce-overlay" classList={{ finishing: finishing(), downloading: !!downloading() }} role="status" aria-live="polite">
          <div class="voce-card">
            <div class="voce-mic" aria-hidden="true">
              <span class="voce-ring" />
              <span class="voce-ring voce-ring-2" />
              <span class="voce-glyph">{downloading() ? "⬇" : "🎙"}</span>
            </div>
            <div class="voce-text">
              <div class="voce-title">
                {downloading() ? "Downloading model…" : finishing() ? "Transcribing…" : "Listening…"}
              </div>
              <div class="voce-sub">
                <Show
                  when={downloading()}
                  fallback={
                    <Show
                      when={!finishing()}
                      fallback={<>Converting your speech to text…</>}
                    >
                      Speak now — dictating into <strong>{pane().title || "this pane"}</strong>
                      <span class="voce-hint">
                        <kbd>Enter</kbd> to finish · <kbd>Esc</kbd> to cancel
                      </span>
                    </Show>
                  }
                >
                  {(dl) => (
                    <>
                      Fetching the <strong>{dl().model}</strong> model (one-time) — {fmtMB(dl().bytes)}
                      <span class="voce-hint">First use of this model · <kbd>Esc</kbd> to cancel</span>
                    </>
                  )}
                </Show>
              </div>
            </div>
            <div class="voce-bars" aria-hidden="true">
              <For each={wave()}>
                {(h) => <span style={{ height: `${(h * 100).toFixed(1)}%` }} />}
              </For>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
}
