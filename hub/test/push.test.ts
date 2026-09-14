import type { ApprovalRequest, HubEvent, PushSubscriptionJson } from "@loom/protocol";
import { createECDH, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
// @ts-expect-error http_ece ships no types; it is web-push's own dependency, used here to read what a device would.
import ece from "http_ece";
import { afterEach, describe, expect, it } from "vitest";
import webpush from "web-push";
import { ApprovalNotifier, approvalPayload } from "../src/push/approvalNotifier.ts";
import { type PushPayload, PushService } from "../src/push/pushService.ts";
import { clientAddress, isForwarded, planBind } from "../src/remote/network.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

function file(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "loom-push-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "push.json");
}

/** A device's side of a push subscription: its keys, and a way to read what arrives. */
function device(endpoint = `https://push.example.com/send/${randomBytes(4).toString("hex")}`) {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16).toString("base64url");
  const subscription: PushSubscriptionJson = { endpoint, keys: { p256dh: ecdh.getPublicKey("base64url"), auth } };
  const read = (body: Buffer) => JSON.parse(ece.decrypt(body, { version: "aes128gcm", privateKey: ecdh, authSecret: auth }).toString("utf8")) as PushPayload;
  return { subscription, read };
}

describe("PushService", () => {
  it("encrypts for the device and signs with this hub's VAPID key", async () => {
    const f = file();
    const received: Array<{ endpoint: string; headers: Record<string, string>; body: Buffer }> = [];
    const svc = new PushService({
      file: f,
      subject: "mailto:me@example.com",
      send: async (sub, payload, options) => {
        const details = webpush.generateRequestDetails({ endpoint: sub.endpoint, keys: sub.keys }, payload, options);
        received.push({ endpoint: details.endpoint, headers: details.headers as Record<string, string>, body: details.body as Buffer });
        return { statusCode: 201 };
      },
    });
    const phone = device();
    expect(svc.subscribe(phone.subscription, "Pixel")).toMatchObject({ label: "Pixel", service: "push.example.com" });
    const result = await svc.send({ title: "Loom", body: "Faye needs approval: Run: git push", tag: "approval-a1", url: "/#approval=a1" });
    expect(result).toEqual({ sent: 1, failed: 0 });
    expect(received[0]!.headers["Content-Encoding"]).toBe("aes128gcm");
    expect(received[0]!.headers.Authorization).toMatch(new RegExp(`^vapid t=.+, k=${svc.publicKey()}$`));
    expect(phone.read(received[0]!.body)).toEqual({ title: "Loom", body: "Faye needs approval: Run: git push", tag: "approval-a1", url: "/#approval=a1" });

    // The keys and devices survive a restart, in a file only this user can read.
    expect(new PushService({ file: f, subject: "mailto:x@y" }).publicKey()).toBe(svc.publicKey());
    if (process.platform !== "win32") expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(f, "utf8")).devices).toHaveLength(1);
  });

  it("drops devices the push service no longer knows, keeps the rest, and replaces by endpoint", async () => {
    const svc = new PushService({
      file: file(),
      subject: "mailto:me@example.com",
      send: async (sub) => {
        if (sub.endpoint.endsWith("gone")) throw Object.assign(new Error("Gone"), { statusCode: 410 });
        if (sub.endpoint.endsWith("flaky")) throw Object.assign(new Error("Server error"), { statusCode: 500 });
        return { statusCode: 201 };
      },
    });
    svc.subscribe(device("https://push.example.com/gone").subscription, "old phone");
    svc.subscribe(device("https://push.example.com/flaky").subscription, "tablet");
    svc.subscribe(device("https://push.example.com/ok").subscription, "phone");
    svc.subscribe(device("https://push.example.com/ok").subscription, "phone, renamed");
    expect(await svc.send({ title: "t", body: "b", tag: "x", url: "/" })).toEqual({ sent: 1, failed: 2 });
    expect(svc.devices().map((d) => d.label).sort()).toEqual(["phone, renamed", "tablet"]);
    expect(() => svc.subscribe(device("http://push.example.com/plain").subscription, "x")).toThrow(/https/);
    await expect(svc.send({ title: "t", body: "b", tag: "x", url: "/" }, "https://push.example.com/unknown")).rejects.toThrow(/not registered/);
  });
});

const request = (over: Partial<ApprovalRequest> = {}): ApprovalRequest =>
  ({ id: "a1", sessionId: "s1", requestedAt: 1, summary: "Run: git push origin main", kind: "permission", toolName: "Bash", input: { command: "git push origin main --token=SECRET" }, canAlwaysAllow: false, ...over }) as ApprovalRequest;
const evt = (event: HubEvent["event"]): HubEvent => ({ seq: 1, at: 1, sessionId: "s1", event }) as HubEvent;

function notifierHarness(delayMs = 30) {
  let listener: ((e: HubEvent) => void) | undefined;
  const pending = new Map<string, ApprovalRequest>();
  const sent: PushPayload[] = [];
  const notifier = new ApprovalNotifier({
    subscribe: (l) => {
      listener = l;
      return () => (listener = undefined);
    },
    pending: (id) => pending.get(id),
    sessionName: () => "Faye",
    send: async (p) => sent.push(p),
    delayMs,
  });
  cleanups.push(() => notifier.close());
  const emit = (e: HubEvent) => listener?.(e);
  return { pending, sent, emit };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("ApprovalNotifier", () => {
  it("pushes an approval still waiting after the delay, with the summary and never the input", async () => {
    const h = notifierHarness();
    h.pending.set("a1", request());
    h.emit(evt({ type: "approval.requested", request: request() }));
    expect(h.sent).toHaveLength(0);
    await wait(60);
    expect(h.sent).toEqual([{ title: "Loom", body: "Faye needs approval: Run: git push origin main", tag: "approval-a1", url: "/#approval=a1" }]);
    expect(JSON.stringify(h.sent)).not.toContain("SECRET");
  });

  it("stays quiet for approvals decided within the delay, and waits for the Steward", async () => {
    const h = notifierHarness();
    h.emit(evt({ type: "approval.requested", request: request() }));
    h.emit(evt({ type: "approval.resolved", approvalId: "a1", decision: { type: "allow" }, resolver: "human" } as HubEvent["event"]));
    await wait(60);
    expect(h.sent).toHaveLength(0);

    const reviewing = request({ id: "a2", steward: { status: "reviewing", mode: "decide" } });
    h.pending.set("a2", reviewing);
    h.emit(evt({ type: "approval.requested", request: reviewing }));
    await wait(60);
    expect(h.sent).toHaveLength(0);
    const escalated = { status: "done" as const, mode: "decide" as const, decision: "escalate" as const };
    h.pending.set("a2", { ...reviewing, steward: escalated });
    h.emit(evt({ type: "approval.updated", approvalId: "a2", steward: escalated }));
    await wait(60);
    expect(h.sent.map((p) => p.tag)).toEqual(["approval-a2"]);
  });

  it("words questions and clips long summaries", () => {
    const q = { id: "q1", sessionId: "s1", requestedAt: 1, summary: "", kind: "question", questions: [{ question: "Which database?", options: [], multiSelect: false }] } as unknown as ApprovalRequest;
    expect(approvalPayload(q, "Cleo").body).toBe("Cleo has a question: Which database?");
    expect(approvalPayload(request({ summary: "x".repeat(400) }), "Faye").body.length).toBe(180);
  });
});

describe("behind a proxy", () => {
  it("uses X-Forwarded-For only from loopback, and flags forwarded requests", () => {
    expect(clientAddress("127.0.0.1", { "x-forwarded-for": "100.70.1.2, 127.0.0.1" })).toBe("100.70.1.2");
    expect(clientAddress("192.168.1.9", { "x-forwarded-for": "127.0.0.1" })).toBe("192.168.1.9");
    expect(clientAddress("127.0.0.1", {})).toBe("127.0.0.1");
    expect(isForwarded({ "tailscale-user-login": "me@example.com" })).toBe(true);
    expect(isForwarded({ host: "127.0.0.1:7420" })).toBe(false);
  });

  it("allows a LAN address with TLS, and keeps loopback beside it", async () => {
    expect(await planBind("192.168.1.5", { allowUnencryptedNetwork: false, tls: true })).toEqual({ hosts: ["127.0.0.1", "192.168.1.5"], kind: "tls" });
    await expect(planBind("0.0.0.0", { allowUnencryptedNetwork: false, tls: true })).rejects.toThrow(/specific address/);
  });
});
