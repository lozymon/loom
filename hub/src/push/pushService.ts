import type { PushDevice, PushSubscriptionJson } from "@loom/protocol";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import webpush from "web-push";
import { HubError } from "../errors.ts";

interface StoredDevice extends PushDevice {
  subscription: PushSubscriptionJson;
}

interface PushFile {
  vapid?: { publicKey: string; privateKey: string };
  devices: StoredDevice[];
}

export interface PushPayload {
  title: string;
  body: string;
  /** Replaces an earlier notification with the same tag on the device. */
  tag: string;
  /** Opened when the notification is tapped, relative to the hub's page. */
  url: string;
}

type SendFn = (subscription: PushSubscriptionJson, payload: string, options: webpush.RequestOptions) => Promise<{ statusCode: number }>;

export interface PushServiceOptions {
  file: string;
  /** VAPID contact, a `mailto:` or `https:` URL. */
  subject: string;
  send?: SendFn;
  now?: () => number;
}

/**
 * Web push for one hub (M10): VAPID keys, the devices that subscribed, and sending. Encryption and
 * signing are done by `web-push` (RFC 8291, RFC 8292), never by Loom code.
 */
export class PushService {
  #opts: PushServiceOptions;
  #data: PushFile;

  constructor(opts: PushServiceOptions) {
    this.#opts = opts;
    this.#data = existsSync(opts.file) ? (JSON.parse(readFileSync(opts.file, "utf8")) as PushFile) : { devices: [] };
    this.#data.devices ??= [];
  }

  #save(): void {
    mkdirSync(path.dirname(this.#opts.file), { recursive: true });
    const tmp = `${this.#opts.file}.tmp`;
    // The private VAPID key signs pushes as this hub, so the file is for this user only.
    writeFileSync(tmp, `${JSON.stringify(this.#data, null, 2)}\n`, { mode: 0o600 });
    if (process.platform !== "win32") chmodSync(tmp, 0o600);
    renameSync(tmp, this.#opts.file);
  }

  #vapid(): { publicKey: string; privateKey: string } {
    if (!this.#data.vapid) {
      this.#data.vapid = webpush.generateVAPIDKeys();
      this.#save();
    }
    return this.#data.vapid;
  }

  publicKey(): string {
    return this.#vapid().publicKey;
  }

  devices(): PushDevice[] {
    return this.#data.devices.map(({ subscription: _s, ...d }) => d);
  }

  subscribe(subscription: PushSubscriptionJson, label: string): PushDevice {
    let service: string;
    try {
      const url = new URL(subscription.endpoint);
      if (url.protocol !== "https:") throw new Error("not https");
      service = url.host;
    } catch {
      throw new HubError("invalid", "a push endpoint must be an https URL");
    }
    const existing = this.#data.devices.find((d) => d.subscription.endpoint === subscription.endpoint);
    const device: StoredDevice = {
      id: existing?.id ?? randomUUID(),
      label,
      createdAt: existing?.createdAt ?? (this.#opts.now ?? Date.now)(),
      service,
      subscription,
    };
    this.#data.devices = [...this.#data.devices.filter((d) => d !== existing), device];
    this.#save();
    const { subscription: _s, ...view } = device;
    return view;
  }

  unsubscribe(endpoint: string): void {
    const before = this.#data.devices.length;
    this.#data.devices = this.#data.devices.filter((d) => d.subscription.endpoint !== endpoint);
    if (this.#data.devices.length !== before) this.#save();
  }

  /** Sends to every device, or one. Devices the push service no longer knows are removed. */
  async send(payload: PushPayload, onlyEndpoint?: string): Promise<{ sent: number; failed: number }> {
    const targets = this.#data.devices.filter((d) => !onlyEndpoint || d.subscription.endpoint === onlyEndpoint);
    if (onlyEndpoint && targets.length === 0) throw new HubError("not-found", "this device is not registered for push");
    if (targets.length === 0) return { sent: 0, failed: 0 };
    const send: SendFn = this.#opts.send ?? ((s, p, o) => webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, p, o));
    const vapid = this.#vapid();
    const body = JSON.stringify(payload);
    let sent = 0;
    let failed = 0;
    const gone: string[] = [];
    await Promise.all(
      targets.map(async (d) => {
        try {
          await send(d.subscription, body, {
            vapidDetails: { subject: this.#opts.subject, ...vapid },
            TTL: 60 * 60,
            urgency: "high",
            topic: payload.tag.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || undefined,
            timeout: 15_000,
          } as webpush.RequestOptions);
          sent++;
        } catch (err) {
          failed++;
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) gone.push(d.subscription.endpoint);
          else console.error(`push to ${d.service} failed:`, (err as Error).message);
        }
      }),
    );
    if (gone.length) {
      this.#data.devices = this.#data.devices.filter((d) => !gone.includes(d.subscription.endpoint));
      this.#save();
    }
    return { sent, failed };
  }
}
