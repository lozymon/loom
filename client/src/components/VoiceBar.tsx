import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { useVoice } from "../voice/controller.ts";

/** Push-to-talk, what was heard and where it went, mute, stop, and settings (PLAN §8 voice bar). */
export function VoiceBar() {
  const voice = useVoice();
  const { state, settings, update, speaker } = voice;
  const [open, setOpen] = createSignal(false);
  const [elapsed, setElapsed] = createSignal(0);

  createEffect(() => {
    if (state.phase !== "listening") return;
    const timer = setInterval(() => setElapsed(Date.now() - state.startedAt), 100);
    onCleanup(() => clearInterval(timer));
  });

  let panel!: HTMLDivElement;
  createEffect(() => {
    if (!open()) return;
    const onDown = (e: PointerEvent) => {
      if (!panel.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    onCleanup(() => document.removeEventListener("pointerdown", onDown));
  });

  const status = () => {
    switch (state.phase) {
      case "starting":
        return "Opening the microphone…";
      case "listening":
        return `Listening ${(elapsed() / 1000).toFixed(1)}s`;
      case "transcribing":
        return "Transcribing…";
      default:
        return undefined;
    }
  };

  return (
    <div class="voice-bar" ref={panel}>
      <div class="voice-row">
        <button
          class="voice-mic"
          classList={{ live: state.phase === "listening", busy: state.phase === "transcribing" || state.phase === "starting" }}
          title="Hold to talk (or hold Ctrl+Shift+Space)"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            void voice.press();
          }}
          onPointerUp={() => void voice.release()}
          onPointerCancel={() => void voice.release()}
          onKeyDown={(e) => {
            if ((e.key === " " || e.key === "Enter") && !e.repeat) {
              e.preventDefault();
              void voice.press();
            }
          }}
          onKeyUp={(e) => {
            if (e.key === " " || e.key === "Enter") void voice.release();
          }}
        >
          <span class="voice-level" style={{ transform: `scaleY(${0.15 + state.level * 0.85})` }} />
          {state.phase === "listening" ? "Release to send" : "Hold to talk"}
        </button>
        <Show when={speaker.speaking()}>
          <button onClick={() => speaker.stop()} title="Stop talking (Escape)">
            Stop
          </button>
        </Show>
        <button classList={{ active: settings.muted }} onClick={() => update({ muted: !settings.muted })} title={settings.muted ? "Read-back is muted" : "Mute read-back"} aria-pressed={settings.muted}>
          {settings.muted ? "Muted" : "🔊"}
        </button>
        <button onClick={() => setOpen((v) => !v)} aria-label="Voice settings" aria-expanded={open()}>
          ⚙
        </button>
      </div>
      <Show when={status()}>
        <div class="voice-status muted small">{status()}</div>
      </Show>
      <Show when={state.phase === "idle" && state.problem}>
        <div class="voice-status error-text small" role="status">
          {state.problem}{" "}
          <button class="link" onClick={() => voice.dismiss()}>
            dismiss
          </button>
        </div>
      </Show>
      <Show when={state.phase === "idle" && !state.problem && state.last}>
        {(last) => (
          <div class="voice-status small" title={`${last().engine} on ${last().hub}, ${(last().tookMs / 1000).toFixed(1)}s`}>
            <span class="badge lang">{last().language}</span> <span class="voice-heard">“{last().text || "…"}”</span>
            <span class="muted"> → {last().went}</span>
          </div>
        )}
      </Show>
      <Show when={open()}>
        <div class="voice-settings" role="dialog" aria-label="Voice settings">
          <strong class="small">Dictation</strong>
          <label class="inline">
            <span>Language</span>
            <select value={settings.dictation} onChange={(e) => update({ dictation: e.currentTarget.value as typeof settings.dictation })}>
              <option value="auto">English or Português</option>
              <option value="en">English</option>
              <option value="pt">Português</option>
            </select>
          </label>
          <label class="inline">
            <span>Goes to</span>
            <select value={settings.target} onChange={(e) => update({ target: e.currentTarget.value as typeof settings.target })}>
              <option value="focused">the open session</option>
              <option value="cockpit">the Cockpit</option>
            </select>
          </label>
          <label class="check">
            <input type="checkbox" checked={settings.autoSend} onChange={(e) => update({ autoSend: e.currentTarget.checked })} />
            Ending with “send” or “enviar” sends it
          </label>
          <strong class="small">Read aloud</strong>
          <label class="check">
            <input type="checkbox" checked={settings.approvals} onChange={(e) => update({ approvals: e.currentTarget.checked })} />
            Approvals waiting for you
          </label>
          <label class="check">
            <input type="checkbox" checked={settings.finished} onChange={(e) => update({ finished: e.currentTarget.checked })} />
            Sessions finishing or failing
          </label>
          <label class="check">
            <input type="checkbox" checked={settings.speech} onChange={(e) => update({ speech: e.currentTarget.checked })} />
            What sessions say
          </label>
          <label class="inline">
            <span>Phrases in</span>
            <select value={settings.phrases} onChange={(e) => update({ phrases: e.currentTarget.value as typeof settings.phrases })}>
              <option value="en">English</option>
              <option value="pt">Português</option>
            </select>
          </label>
          <label class="inline">
            <span>Voice</span>
            <select value={settings.readWith} onChange={(e) => update({ readWith: e.currentTarget.value as typeof settings.readWith })}>
              <option value="browser">this browser</option>
              <option value="hub" disabled={!voice.hubVoice()}>
                the hub{voice.hubVoice() ? "" : " (none configured)"}
              </option>
            </select>
          </label>
          <strong class="small">Notifications</strong>
          <label class="check">
            <input
              type="checkbox"
              checked={settings.notify}
              disabled={typeof Notification === "undefined"}
              onChange={(e) => {
                const on = e.currentTarget.checked;
                update({ notify: on });
                if (on && typeof Notification !== "undefined" && Notification.permission === "default") void Notification.requestPermission();
              }}
            />
            Approvals while Loom is in the background
          </label>
          <p class="muted small">Escape stops talking. Quiet hours are set per hub in hub.json.</p>
        </div>
      </Show>
    </div>
  );
}
