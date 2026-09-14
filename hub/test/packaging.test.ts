import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PROTOCOL_VERSION } from "@loom/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { hashToken } from "../src/auth.ts";
import { installLoomShim, useSingleEntry } from "../src/loom/integration.ts";
import { CloseCode, startHubServer } from "../src/server/wsServer.ts";
import { testHub } from "./support/hub.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function tmp(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "loom-pack-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function hello(port: number, token: string): Promise<{ welcome: boolean; code?: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.on("open", () => ws.send(JSON.stringify({ t: "hello", protocol: PROTOCOL_VERSION, client: { kind: "web", version: "t" }, token })));
    ws.on("message", (d) => {
      if (JSON.parse(d.toString()).t === "welcome") {
        ws.close();
        resolve({ welcome: true });
      }
    });
    ws.on("close", (code) => resolve({ welcome: false, code }));
  });
}

describe("desktop sign-in", () => {
  it("accepts the one-run desktop token next to the stored one", async () => {
    const hub = testHub();
    const server = await startHubServer({
      manager: hub.manager,
      hub: { id: "h", name: "t", version: "0", platform: "linux", maxLevel: "accept-edits", defaultLevel: "supervised", stewardModel: false },
      tokenHash: hashToken("stored"),
      extraTokenHashes: [hashToken("desktop-once")],
      hosts: ["127.0.0.1"],
      port: 0,
    });
    cleanups.push(() => server.close());
    expect(await hello(server.port, "stored")).toEqual({ welcome: true });
    expect(await hello(server.port, "desktop-once")).toEqual({ welcome: true });
    expect(await hello(server.port, "guess")).toEqual({ welcome: false, code: CloseCode.unauthorized });
  });
});

describe("single entry", () => {
  it("points the loom shim at the bundled entry's cli subcommand", () => {
    const dir = tmp();
    useSingleEntry("/opt/loom/hub/hub.mjs");
    installLoomShim(dir, "linux");
    expect(readFileSync(path.join(dir, "loom"), "utf8")).toBe(`#!/bin/sh\nexec "${process.execPath}" "/opt/loom/hub/hub.mjs" "cli" "$@"\n`);
    installLoomShim(dir, "win32");
    expect(readFileSync(path.join(dir, "loom.cmd"), "utf8")).toBe(`@echo off\r\n"${process.execPath}" "/opt/loom/hub/hub.mjs" "cli" %*\r\n`);
  });
});

describe("hub bundle", () => {
  it("builds and runs its cli and mcp entries without the repository", () => {
    const out = tmp();
    execFileSync(process.execPath, [path.join(import.meta.dirname, "..", "scripts", "bundle.mjs"), out], { stdio: "pipe" });
    const cwd = tmp();
    const help = execFileSync(process.execPath, [path.join(out, "hub.mjs"), "cli", "help"], { cwd, encoding: "utf8" });
    expect(help).toMatch(/Usage: loom <command>/);
    const hubHelp = execFileSync(process.execPath, [path.join(out, "hub.mjs"), "--help"], { cwd, encoding: "utf8" });
    expect(hubHelp).toMatch(/Usage: loom-hub/);
    let mcpError = "";
    try {
      execFileSync(process.execPath, [path.join(out, "hub.mjs"), "mcp"], { cwd, encoding: "utf8", stdio: "pipe", env: { PATH: process.env.PATH ?? "" } });
    } catch (err) {
      mcpError = String((err as { stderr?: string }).stderr);
    }
    expect(mcpError).toMatch(/LOOM_HUB_URL and LOOM_SESSION_TOKEN must be set/);
  }, 60_000);
});
