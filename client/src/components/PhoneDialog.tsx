import type { PushDevice } from "@loom/protocol";
import qrcode from "qrcode-generator";
import { createResource, createSignal, For, onMount, Show } from "solid-js";
import { useHubList } from "../hub/hubList.ts";
import type { Hub } from "../hub/store.ts";
import { currentSubscription, disablePush, enablePush, pushUnavailableReason } from "../pwa/push.ts";

const ADDRESS_KEY = "loom.phoneAddress";

/** QR code for a URL, as SVG markup made by qrcode-generator from our own string. */
function qrSvg(text: string): string {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 5, margin: 3, scalable: true });
}

/**
 * Phone setup for one hub (M10): push notifications on this device, the devices that get them, and a
 * QR code that signs a phone in to this hub.
 */
export function PhoneDialog(props: { hub: Hub; onClose(): void }) {
  const hubList = useHubList();
  const entry = () => hubList.entryOf(props.hub);
  const isPageHub = () => entry()?.url === undefined;
  const unavailable = pushUnavailableReason();
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal<{ text: string; error?: boolean }>();
  const [subscribed, setSubscribed] = createSignal<string | undefined>();
  const [devices, { refetch }] = createResource(async () => (await props.hub.actions.pushDevices().catch(() => [])) as PushDevice[]);
  const [address, setAddress] = createSignal(localStorage.getItem(ADDRESS_KEY) ?? entry()?.url ?? "");
  const [showQr, setShowQr] = createSignal(false);

  onMount(async () => setSubscribed((await currentSubscription())?.endpoint));

  const run = async (what: () => Promise<string>) => {
    setBusy(true);
    setMessage(undefined);
    try {
      setMessage({ text: await what() });
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : String(err), error: true });
    } finally {
      setBusy(false);
      setSubscribed((await currentSubscription())?.endpoint);
      void refetch();
    }
  };

  const phoneUrl = () => {
    const base = address().trim().replace(/\/+$/, "");
    const token = entry()?.token;
    return base && token ? `${base}/#token=${encodeURIComponent(token)}` : undefined;
  };

  return (
    <div class="overlay" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <section class="dialog phone-dialog" aria-label="Phone and notifications">
        <header class="panel-head">
          <h2>Phone and notifications</h2>
          <button onClick={() => props.onClose()}>Close</button>
        </header>

        <h3>Notifications on this device</h3>
        <Show
          when={isPageHub()}
          fallback={<p class="muted">Push comes from the hub that serves the page. Open this hub's own address to get its notifications here.</p>}
        >
          <Show when={!unavailable} fallback={<p class="muted">{unavailable}</p>}>
            <p class="muted">
              {props.hub.state.hub?.name ?? "This hub"} notifies this device when an approval has waited a little while for you.
            </p>
            <div class="actions">
              <Show
                when={subscribed()}
                fallback={
                  <button class="primary" disabled={busy()} onClick={() => void run(async () => (await enablePush(props.hub), "This device gets notifications now."))}>
                    Turn on
                  </button>
                }
              >
                {(endpoint) => (
                  <>
                    <button disabled={busy()} onClick={() => void run(async () => {
                      const r = await props.hub.actions.pushTest(endpoint());
                      return r.sent ? "Test sent. It should arrive in a few seconds." : "The push service did not accept the test.";
                    })}>
                      Send a test
                    </button>
                    <button disabled={busy()} onClick={() => void run(async () => (await disablePush(props.hub), "Notifications are off on this device."))}>
                      Turn off
                    </button>
                  </>
                )}
              </Show>
            </div>
          </Show>
        </Show>
        <Show when={message()}>{(m) => <p classList={{ "error-text": m().error === true, muted: !m().error }}>{m().text}</p>}</Show>

        <Show when={(devices() ?? []).length > 0}>
          <h3>Devices getting notifications</h3>
          <ul class="device-list">
            <For each={devices()}>
              {(d) => (
                <li>
                  <span>{d.label}</span>
                  <span class="muted small">{d.service}</span>
                </li>
              )}
            </For>
          </ul>
        </Show>

        <h3>Connect a phone</h3>
        <p class="muted">
          The phone needs an https address for this hub, for example from <code>tailscale serve</code>. Scanning the code signs the phone in with this
          hub's token, so show it only to your own phone.
        </p>
        <label>
          <span>Address the phone uses</span>
          <input
            class="mono"
            value={address()}
            placeholder="https://your-pc.your-tailnet.ts.net"
            onInput={(e) => {
              setAddress(e.currentTarget.value);
              localStorage.setItem(ADDRESS_KEY, e.currentTarget.value);
              setShowQr(false);
            }}
          />
        </label>
        <Show when={phoneUrl()} fallback={<p class="muted small">Enter the address to make a code.</p>}>
          {(url) => (
            <Show when={showQr()} fallback={<button onClick={() => setShowQr(true)}>Show sign-in code</button>}>
              {/* eslint-disable-next-line solid/no-innerhtml -- SVG built by qrcode-generator from our own URL */}
              <div class="qr" innerHTML={qrSvg(url())} role="img" aria-label="Sign-in QR code" />
              <Show when={!url().startsWith("https://")}>
                <p class="error-text small">Without https the phone cannot install Loom, use its microphone, or get notifications.</p>
              </Show>
              <button onClick={() => setShowQr(false)}>Hide code</button>
            </Show>
          )}
        </Show>
      </section>
    </div>
  );
}
