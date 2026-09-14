import { createSignal, Show } from "solid-js";
import { parseHubInput } from "../hub/registry.ts";
import { useHubList } from "../hub/hubList.ts";

/**
 * Connect to a hub: paste the link it printed, or an address and token. With `first`, this is the whole
 * screen because there is nothing else to show yet.
 */
export function AddHub(props: { first?: boolean; url?: string | undefined; onClose?(): void }) {
  const hubList = useHubList();
  const [address, setAddress] = createSignal(props.url ?? "");
  const [token, setToken] = createSignal("");
  const [error, setError] = createSignal<string>();

  const submit = (e: Event) => {
    e.preventDefault();
    const parsed = parseHubInput(address(), token());
    if (!parsed.ok) return setError(parsed.error);
    hubList.add(parsed.url, parsed.token);
    props.onClose?.();
  };

  const form = (
    <form class="dialog" onSubmit={submit}>
      <h2>{props.first ? "Connect to a Loom hub" : "Add a hub"}</h2>
      <p class="muted">
        Paste the link the hub printed when it started, or its address and access token. Leave the address empty for the hub
        serving this page. To reach a hub on another computer, run <code>loom tunnel you@that-computer</code> here and use
        the address it prints, or use the hub's Tailscale address. To make a new token, restart the hub with{" "}
        <code>--new-token</code>.
      </p>
      <label>
        <span>Address or link</span>
        <input
          class="mono"
          value={address()}
          onInput={(e) => {
            setAddress(e.currentTarget.value);
            setError(undefined);
          }}
          placeholder="empty for this page's hub, or http://127.0.0.1:17420"
          autofocus={!props.url}
        />
      </label>
      <label>
        <span>Access token</span>
        <input
          class="mono"
          value={token()}
          onInput={(e) => {
            setToken(e.currentTarget.value);
            setError(undefined);
          }}
          placeholder="not needed if the link has one"
          autofocus={Boolean(props.url)}
        />
      </label>
      <Show when={error()}>
        <p class="error-text">{error()}</p>
      </Show>
      <div class="actions end">
        <Show when={props.onClose}>
          <button type="button" onClick={() => props.onClose?.()}>
            Cancel
          </button>
        </Show>
        <button class="primary" type="submit" disabled={!address().trim() && !token().trim()}>
          Connect
        </button>
      </div>
    </form>
  );

  return props.first ? (
    <div class="empty">{form}</div>
  ) : (
    <div class="overlay" onClick={(e) => e.target === e.currentTarget && props.onClose?.()}>
      {form}
    </div>
  );
}
