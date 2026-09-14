import { Match, Switch } from "solid-js";

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** A readable view of a tool call's input: commands as commands, edits as diffs, the rest as JSON. */
export function ToolInput(props: { toolName: string; input: Record<string, unknown> }) {
  const lines = (text: string, prefix: string) =>
    text
      .split("\n")
      .slice(0, 200)
      .map((l) => `${prefix}${l}`)
      .join("\n");

  return (
    <Switch fallback={<pre class="code">{JSON.stringify(props.input, null, 2)}</pre>}>
      <Match when={props.toolName === "Bash" || props.toolName === "PowerShell"}>
        <pre class="code command">{str(props.input.command)}</pre>
      </Match>
      <Match when={props.toolName === "Edit"}>
        <div class="path">{str(props.input.file_path)}</div>
        <pre class="code diff">
          <span class="del">{lines(str(props.input.old_string), "- ")}</span>
          {"\n"}
          <span class="add">{lines(str(props.input.new_string), "+ ")}</span>
        </pre>
      </Match>
      <Match when={props.toolName === "Write"}>
        <div class="path">{str(props.input.file_path)}</div>
        <pre class="code diff">
          <span class="add">{lines(str(props.input.content), "+ ")}</span>
        </pre>
      </Match>
    </Switch>
  );
}
