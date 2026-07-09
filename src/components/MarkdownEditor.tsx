// A small rich Markdown editor: a formatting toolbar + a Write/Preview toggle over a plain textarea.
// Deliberately dependency-free — the toolbar just splices Markdown syntax around the selection, and
// Preview reuses the app's safe markdown-it renderer (renderMarkdown, html:false). Controlled: the
// text lives in the parent (`value`/`onInput`); this component only mutates it and the caret.

import { createSignal, For, Show } from "solid-js";
import { renderMarkdown } from "../lib/markdown";

type Tool =
  | { kind: "wrap"; label: string; title: string; before: string; after: string }
  | { kind: "prefix"; label: string; title: string; prefix: string };

const TOOLS: Tool[] = [
  { kind: "wrap", label: "B", title: "Bold (Ctrl+B)", before: "**", after: "**" },
  { kind: "wrap", label: "I", title: "Italic (Ctrl+I)", before: "*", after: "*" },
  { kind: "wrap", label: "</>", title: "Inline code", before: "`", after: "`" },
  { kind: "prefix", label: "H", title: "Heading", prefix: "# " },
  { kind: "prefix", label: "•", title: "Bullet list", prefix: "- " },
  { kind: "prefix", label: "1.", title: "Numbered list", prefix: "1. " },
  { kind: "prefix", label: "❝", title: "Quote", prefix: "> " },
  { kind: "wrap", label: "🔗", title: "Link", before: "[", after: "](https://)" },
];

export default function MarkdownEditor(props: {
  value: string;
  onInput: (v: string) => void;
  placeholder?: string;
  class?: string;
}) {
  const [mode, setMode] = createSignal<"write" | "preview">("write");
  let ta: HTMLTextAreaElement | undefined;

  // Wrap the current selection (or caret) with `before`/`after`, then reselect the inner text.
  function wrap(before: string, after: string) {
    if (!ta) return;
    const s = ta.selectionStart, e = ta.selectionEnd, v = props.value;
    props.onInput(v.slice(0, s) + before + v.slice(s, e) + after + v.slice(e));
    queueMicrotask(() => {
      ta!.focus();
      ta!.selectionStart = s + before.length;
      ta!.selectionEnd = e + before.length;
    });
  }

  // Prefix every line touched by the selection (list/heading/quote).
  function prefixLines(prefix: string) {
    if (!ta) return;
    const s = ta.selectionStart, e = ta.selectionEnd, v = props.value;
    const lineStart = v.lastIndexOf("\n", s - 1) + 1;
    const region = v.slice(lineStart, e).split("\n").map((l) => prefix + l).join("\n");
    props.onInput(v.slice(0, lineStart) + region + v.slice(e));
    queueMicrotask(() => { ta!.focus(); ta!.selectionStart = ta!.selectionEnd = e + prefix.length; });
  }

  const apply = (t: Tool) => (t.kind === "wrap" ? wrap(t.before, t.after) : prefixLines(t.prefix));

  function onKeyDown(e: KeyboardEvent) {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.key === "b") { e.preventDefault(); wrap("**", "**"); }
    else if (e.key === "i") { e.preventDefault(); wrap("*", "*"); }
  }

  return (
    <div class={`md-editor ${props.class ?? ""}`}>
      <div class="md-toolbar">
        <div class="md-tools">
          <For each={TOOLS}>{(t) => (
            <button type="button" class="md-tool-btn" title={t.title}
              disabled={mode() === "preview"}
              onClick={() => apply(t)}>{t.label}</button>
          )}</For>
        </div>
        <div class="md-tabs">
          <button type="button" class="md-tab" classList={{ active: mode() === "write" }} onClick={() => setMode("write")}>Write</button>
          <button type="button" class="md-tab" classList={{ active: mode() === "preview" }} onClick={() => setMode("preview")}>Preview</button>
        </div>
      </div>
      <Show
        when={mode() === "write"}
        fallback={
          <Show when={props.value.trim()} fallback={<div class="md-preview md-preview-empty">Nothing to preview</div>}>
            <div class="md-preview" innerHTML={renderMarkdown(props.value)} />
          </Show>
        }
      >
        <textarea
          ref={ta}
          class="board-input board-prompt md-textarea"
          placeholder={props.placeholder}
          value={props.value}
          onInput={(e) => props.onInput(e.currentTarget.value)}
          onKeyDown={onKeyDown}
        />
      </Show>
    </div>
  );
}
