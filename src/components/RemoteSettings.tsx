// Settings → Remote (Plan 02 L2, laptop side). Enable the LAN bridge and show the QR the phone
// scans to pair. This is the piece that makes the local-first app usable without the dev env seam.
//
// Trust model, surfaced honestly: enabling opens a LAN-bound listener. It is safe because every
// frame is sealed to the pairing key (only the scanned phone can drive), but the operator should
// know it's on and be able to revoke. See ADR-0012 / lansec.rs.

import { createSignal, onMount, Show } from "solid-js";
import QRCode from "qrcode";
import {
  enableBridge,
  stopBridge,
  unpairBridge,
  bridgeStatus,
  pairingPayload,
  type BridgeStatus,
  type PairingInfo,
} from "../lib/lanBridge";

export default function RemoteSettings() {
  const [status, setStatus] = createSignal<BridgeStatus | null>(null);
  const [pairing, setPairing] = createSignal<PairingInfo | null>(null);
  const [qr, setQr] = createSignal<string>("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const refresh = async () => {
    try {
      setStatus(await bridgeStatus());
    } catch (e) {
      setError(String(e));
    }
  };
  onMount(refresh);

  async function showPairing(info: PairingInfo) {
    setPairing(info);
    // Dark modules on a light ground — high contrast so any phone camera reads it, regardless of theme.
    setQr(
      await QRCode.toString(pairingPayload(info), {
        type: "svg",
        margin: 1,
        color: { dark: "#0e0f12", light: "#ffffff" },
      }),
    );
  }

  async function enable() {
    setBusy(true);
    setError(null);
    try {
      await showPairing(await enableBridge());
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    setBusy(true);
    try {
      await stopBridge();
      setPairing(null);
      setQr("");
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function unpair() {
    if (!window.confirm("Revoke pairing? The paired phone will be cut off and must scan a new code.")) return;
    setBusy(true);
    try {
      await unpairBridge();
      setPairing(null);
      setQr("");
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section class="settings-section">
      <h3>Remote (phone, same Wi-Fi)</h3>
      <p class="settings-sub">
        Drive this Loom from the Loom Android app over your local network. Off by default; every
        message is end-to-end sealed to the phone you pair.
      </p>

      <div class="settings-card">
        <div class="settings-row">
          <span class="settings-label">Status</span>
          <span class="remote-status" classList={{ on: status()?.running }}>
            {status()?.running ? `Listening on port ${status()?.port}` : "Off"}
            {status()?.paired ? " · paired" : ""}
          </span>
        </div>

        <Show when={!status()?.running}>
          <div class="remote-actions">
            <button class="settings-btn primary" disabled={busy()} onClick={enable}>
              {busy() ? "Enabling…" : "Enable & show pairing QR"}
            </button>
          </div>
        </Show>

        <Show when={status()?.running}>
          <Show
            when={qr()}
            fallback={
              <div class="remote-actions">
                <button class="settings-btn" disabled={busy()} onClick={enable}>
                  Show pairing QR
                </button>
              </div>
            }
          >
            <div class="remote-qr">
              {/* eslint-disable-next-line solid/no-innerhtml */}
              <div class="remote-qr-img" innerHTML={qr()} />
              <p class="settings-sub">Scan this in the Loom app → Pair. Or paste the code below.</p>
              <textarea class="settings-input remote-code" readonly rows={3}>
                {pairing() ? pairingPayload(pairing()!) : ""}
              </textarea>
            </div>
          </Show>
          <div class="remote-actions">
            <button class="settings-btn" disabled={busy()} onClick={stop}>
              Stop
            </button>
            <button class="settings-btn danger" disabled={busy()} onClick={unpair}>
              Revoke pairing
            </button>
          </div>
        </Show>

        <Show when={error()}>
          <p class="remote-error">{error()}</p>
        </Show>
      </div>

      <p class="settings-note">
        ⚠ Enabling opens a listener on your local network. It's protected by the pairing key — only the
        phone you scan can connect — but the underlying crypto is pending an independent review, so
        treat it as a home-network convenience, not a hardened channel.
      </p>
    </section>
  );
}
