import { createEffect, on, Show } from "solid-js";

/** Message input: Enter sends, Shift+Enter adds a line. The draft lives in the store so dictation can add to it. */
export function Composer(props: {
  disabled: boolean;
  working: boolean;
  placeholder: string;
  draft: string;
  onDraft(text: string): void;
  /** Changes when something outside (dictation) wants the cursor here. */
  focusSignal: number | undefined;
  onSend(text: string): Promise<unknown>;
  onInterrupt(): void;
}) {
  const text = () => props.draft;
  let area!: HTMLTextAreaElement;

  const fit = () => {
    area.style.height = "";
    area.style.height = `${Math.min(area.scrollHeight, 240)}px`;
  };
  createEffect(
    on(
      () => props.focusSignal,
      (n) => {
        if (n === undefined) return;
        queueMicrotask(() => {
          fit();
          area.focus();
          area.setSelectionRange(area.value.length, area.value.length);
        });
      },
      { defer: true },
    ),
  );

  const send = async () => {
    const value = text().trim();
    if (!value || props.disabled) return;
    props.onDraft("");
    area.style.height = "";
    await props.onSend(value);
    area.focus();
  };

  return (
    <form
      class="composer"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <textarea
        ref={area}
        rows={1}
        value={text()}
        placeholder={props.placeholder}
        disabled={props.disabled}
        onInput={(e) => {
          props.onDraft(e.currentTarget.value);
          fit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <Show when={props.working}>
        <button type="button" onClick={() => props.onInterrupt()} title="Stop the current turn">
          Interrupt
        </button>
      </Show>
      <button type="submit" class="primary" disabled={props.disabled || !text().trim()}>
        Send
      </button>
    </form>
  );
}
