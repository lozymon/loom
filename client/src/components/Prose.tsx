import { For, Show } from "solid-js";

interface Block {
  code: boolean;
  lang?: string;
  text: string;
}

function blocks(text: string): Block[] {
  const out: Block[] = [];
  const re = /```([\w+-]*)\n([\s\S]*?)(?:```|$)/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ code: false, text: text.slice(last, m.index) });
    out.push({ code: true, ...(m[1] ? { lang: m[1] } : {}), text: m[2] ?? "" });
    last = re.lastIndex;
  }
  if (last < text.length) out.push({ code: false, text: text.slice(last) });
  return out;
}

/** Renders assistant text: fenced code blocks and inline code, everything else as plain text. No HTML injection. */
export function Prose(props: { text: string }) {
  return (
    <div class="prose">
      <For each={blocks(props.text)}>
        {(b) => (
          <Show when={b.code} fallback={<Inline text={b.text} />}>
            <pre class="code" data-lang={b.lang}>
              <code>{b.text}</code>
            </pre>
          </Show>
        )}
      </For>
    </div>
  );
}

function Inline(props: { text: string }) {
  const parts = () => props.text.split(/(`[^`\n]+`)/g);
  return (
    <p>
      <For each={parts()}>{(part) => (part.startsWith("`") && part.endsWith("`") && part.length > 2 ? <code>{part.slice(1, -1)}</code> : part)}</For>
    </p>
  );
}
