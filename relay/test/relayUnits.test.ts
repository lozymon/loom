import { mkdtempSync, rmSync, statSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { afterEach, describe, expect, it } from "vitest";
import { parseClientHello, parseHttpHead } from "../src/clientHello.ts";
import { HubRegistry } from "../src/registry.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

/** A real ClientHello from Node's TLS client, captured by a server that never answers. */
async function captureHello(servername?: string): Promise<Buffer> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.once("data", (d) => {
        resolve(d);
        socket.destroy();
        server.close();
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      const client = tls.connect({ host: "127.0.0.1", port, ...(servername ? { servername } : {}), rejectUnauthorized: false });
      client.on("error", () => undefined);
    });
  });
}

describe("parseClientHello", () => {
  it("reads the server name from a real ClientHello, including when it arrives in pieces", async () => {
    const hello = await captureHello("Work.Relay.Example.com");
    expect(parseClientHello(hello)).toEqual({ kind: "hello", serverName: "work.relay.example.com" });
    expect(parseClientHello(hello.subarray(0, 3))).toEqual({ kind: "need-more" });
    expect(parseClientHello(hello.subarray(0, hello.length - 1))).toEqual({ kind: "need-more" });
  });

  it("handles a hello without a name, and things that are not TLS", async () => {
    expect(parseClientHello(await captureHello())).toEqual({ kind: "hello", serverName: undefined });
    expect(parseClientHello(Buffer.from("GET / HTTP/1.1\r\n"))).toEqual({ kind: "not-tls" });
    expect(parseClientHello(Buffer.from([22, 3, 1, 0, 4, 2, 0, 0, 0]))).toEqual({ kind: "not-tls" });
  });

  it("joins a handshake split across two records", async () => {
    const hello = await captureHello("a.relay.example.com");
    const body = hello.subarray(5);
    const half = Math.floor(body.length / 2);
    const record = (part: Buffer) => Buffer.concat([Buffer.from([22, 3, 1, part.length >> 8, part.length & 0xff]), part]);
    expect(parseClientHello(Buffer.concat([record(body.subarray(0, half)), record(body.subarray(half))]))).toEqual({ kind: "hello", serverName: "a.relay.example.com" });
  });
});

describe("parseHttpHead", () => {
  it("reads host and path", () => {
    expect(parseHttpHead(Buffer.from("GET /.well-known/acme-challenge/x HTTP/1.1\r\nHost: Work.Relay.Example.com:80\r\n\r\n"))).toEqual({ kind: "request", host: "work.relay.example.com", path: "/.well-known/acme-challenge/x" });
    expect(parseHttpHead(Buffer.from("GET / HTTP/1.1\r\nHost: x"))).toEqual({ kind: "need-more" });
    expect(parseHttpHead(Buffer.from("nonsense\r\n\r\n"))).toEqual({ kind: "bad" });
  });
});

describe("HubRegistry", () => {
  it("stores only secret hashes, verifies, replaces, and removes", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "loom-relay-reg-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "hubs.json");
    const reg = new HubRegistry(file);
    const secret = reg.add("work");
    expect(reg.verify("work", secret)).toBe(true);
    expect(reg.verify("work", "wrong")).toBe(false);
    expect(reg.verify("home", secret)).toBe(false);
    expect(JSON.stringify(reg.list())).not.toContain(secret);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    const again = reg.add("work");
    expect(new HubRegistry(file).verify("work", secret)).toBe(false);
    expect(new HubRegistry(file).verify("work", again)).toBe(true);
    expect(() => reg.add("Bad.Name")).toThrow(/lowercase/);
    // Another process (the CLI) changes the file while the relay runs.
    const other = new HubRegistry(file);
    const later = other.add("home", new Date(Date.now() + 5000));
    expect(reg.verify("home", later)).toBe(true);
    other.remove("home");
    expect(reg.verify("home", later)).toBe(false);
    expect(reg.remove("work")).toBe(true);
    expect(reg.list()).toEqual([]);
  });
});
