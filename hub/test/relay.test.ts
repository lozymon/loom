import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { PROTOCOL_VERSION } from "@loom/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { HubRegistry } from "../../relay/src/registry.ts";
import { type Relay, startRelay } from "../../relay/src/server.ts";
import { hashToken } from "../src/auth.ts";
import { RelayClient, type RelayStatus } from "../src/relay/relayClient.ts";
import { startHubServer } from "../src/server/wsServer.ts";
import { testHub } from "./support/hub.ts";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function hasOpenssl(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** A throwaway CA with certificates for the relay's own name and for the hub's relay name. */
function certificates(dir: string) {
  const run = (...args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "ignore" });
  run("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1", "-subj", "/CN=Loom test CA", "-keyout", "ca.key", "-out", "ca.crt");
  for (const name of ["relay.test", "work.relay.test"]) {
    run("req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-subj", `/CN=${name}`, "-keyout", `${name}.key`, "-out", `${name}.csr`);
    writeFileSync(path.join(dir, `${name}.ext`), `subjectAltName=DNS:${name}\n`);
    run("x509", "-req", "-in", `${name}.csr`, "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-days", "1", "-extfile", `${name}.ext`, "-out", `${name}.crt`);
  }
  const read = (f: string) => readFileSync(path.join(dir, f));
  return { ca: read("ca.crt"), relay: { cert: read("relay.test.crt"), key: read("relay.test.key") }, hub: { cert: read("work.relay.test.crt"), key: read("work.relay.test.key") } };
}

const toLoopback: net.LookupFunction = (_host, options, cb) => {
  if ((options as { all?: boolean }).all) (cb as unknown as (e: null, a: Array<{ address: string; family: number }>) => void)(null, [{ address: "127.0.0.1", family: 4 }]);
  else cb(null, "127.0.0.1", 4);
};

async function until<T>(check: () => T | undefined, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = check();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

function get(port: number, servername: string, pathname: string, ca: Buffer, method = "GET"): Promise<{ status: number; body: string; peer: string }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest({ host: "127.0.0.1", port, servername, path: pathname, method, ca, headers: { host: servername }, agent: false }, (res) => {
      let body = "";
      const peer = String((res.socket as tls.TLSSocket).getPeerCertificate().subject?.CN ?? "");
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, peer }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe.skipIf(!hasOpenssl())("relay end to end", () => {
  it("carries https and wss to the hub with TLS end to end, and nothing else", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "loom-relay-e2e-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const certs = certificates(dir);
    const registry = new HubRegistry(path.join(dir, "hubs.json"));
    const secret = registry.add("work");

    const startTheRelay = (httpsPort = 0, httpPort = 0) =>
      startRelay({ domain: "relay.test", tls: certs.relay, host: "127.0.0.1", httpsPort, httpPort, registry, limits: { dialBackMs: 3000 } });
    let relay: Relay = await startTheRelay();
    cleanups.push(() => relay.close());

    const hub = testHub();
    const server = await startHubServer({
      manager: hub.manager,
      hub: { id: "h1", name: "work", version: "0", platform: "linux", maxLevel: "accept-edits", defaultLevel: "supervised", stewardModel: false },
      tokenHash: hashToken("hub-token"),
      hosts: ["127.0.0.1"],
      port: 0,
      relay: { context: () => tls.createSecureContext(certs.hub), challenge: (t) => (t === "tok123" ? "tok123.thumbprint" : undefined) },
    });
    cleanups.push(() => server.close());

    const statuses: RelayStatus[] = [];
    const client = new RelayClient({
      url: `wss://relay.test:${relay.httpsPort}`,
      name: "work",
      secret,
      ca: [certs.ca],
      lookup: toLoopback,
      onStream: (kind, socket, visitor) => server.acceptRelayStream(kind, socket, visitor),
      onStatus: (s) => statuses.push(s),
    });
    cleanups.push(() => client.close());
    client.start();
    await until(() => statuses.find((s) => s.kind === "up"));
    expect(statuses.find((s) => s.kind === "up")).toEqual({ kind: "up", hostname: "work.relay.test" });

    // https through the relay, with the hub's own certificate.
    const loom = await get(relay.httpsPort, "work.relay.test", "/loom.json", certs.ca);
    expect(loom).toMatchObject({ status: 200, peer: "work.relay.test" });
    expect(JSON.parse(loom.body)).toMatchObject({ loom: "hub" });

    // The WebSocket protocol, signed in with the hub token.
    const welcome = await new Promise<{ t: string }>((resolve, reject) => {
      const ws = new WebSocket(`wss://work.relay.test:${relay.httpsPort}/ws`, { ca: certs.ca, lookup: toLoopback });
      ws.on("open", () => ws.send(JSON.stringify({ t: "hello", protocol: PROTOCOL_VERSION, client: { kind: "web", version: "t" }, token: "hub-token" })));
      ws.on("message", (d) => {
        resolve(JSON.parse(String(d)) as { t: string });
        ws.close();
      });
      ws.on("error", reject);
    });
    expect(welcome.t).toBe("welcome");

    // Hooks never work through the relay; the relay's own name is not the hub.
    expect((await get(relay.httpsPort, "work.relay.test", "/hooks/s1", certs.ca, "POST")).status).toBe(403);
    expect(await get(relay.httpsPort, "relay.test", "/", certs.ca)).toMatchObject({ status: 404, body: "Loom relay\n", peer: "relay.test" });

    // Unknown names get nothing.
    await expect(get(relay.httpsPort, "other.relay.test", "/", certs.ca)).rejects.toThrow();
    await expect(get(relay.httpsPort, "evil.example.com", "/", certs.ca)).rejects.toThrow();

    // Port 80: ACME challenges reach the hub; everything else redirects.
    const plain = (host: string, p: string) =>
      new Promise<string>((resolve) => {
        const s = net.connect(relay.httpPort!, "127.0.0.1", () => s.write(`GET ${p} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`));
        let out = "";
        s.on("data", (d) => (out += d));
        s.on("close", () => resolve(out));
      });
    const challenge = await plain("work.relay.test", "/.well-known/acme-challenge/tok123");
    expect(challenge).toMatch(/^HTTP\/1\.1 200/);
    expect(challenge).toContain("tok123.thumbprint");
    expect(await plain("work.relay.test", "/.well-known/acme-challenge/unknown")).toMatch(/^HTTP\/1\.1 404/);
    expect(await plain("work.relay.test", "/app")).toMatch(/301 Moved Permanently[\s\S]*Location: https:\/\/work\.relay\.test\/app/);

    // A relay restart: the hub comes back by itself.
    const { httpsPort, httpPort } = relay;
    await relay.close();
    await until(() => statuses.find((s) => s.kind === "down"));
    relay = await startTheRelay(httpsPort, httpPort);
    await until(() => (relay.connectedHubs().includes("work") ? true : undefined), 10_000);
    expect((await get(relay.httpsPort, "work.relay.test", "/loom.json", certs.ca)).status).toBe(200);
  }, 30_000);

  it("refuses a hub that is not enrolled", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "loom-relay-e2e-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const certs = certificates(dir);
    const relay = await startRelay({ domain: "relay.test", tls: certs.relay, host: "127.0.0.1", httpsPort: 0, registry: new HubRegistry(path.join(dir, "hubs.json")) });
    cleanups.push(() => relay.close());
    const statuses: RelayStatus[] = [];
    const client = new RelayClient({ url: `wss://relay.test:${relay.httpsPort}`, name: "work", secret: "x".repeat(40), ca: [certs.ca], lookup: toLoopback, onStream: () => undefined, onStatus: (s) => statuses.push(s) });
    cleanups.push(() => client.close());
    client.start();
    const down = await until(() => statuses.find((s): s is Extract<RelayStatus, { kind: "down" }> => s.kind === "down"));
    expect(down.reason).toMatch(/does not know this hub/);
    expect(relay.connectedHubs()).toEqual([]);
  }, 15_000);
});
