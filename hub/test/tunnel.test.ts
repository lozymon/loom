import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { probeHub, runTunnel, tunnelArgs, type TunnelStatus } from "../src/remote/tunnel.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const base = { target: "me@work", remotePort: 7420, localPort: 17420, sshOptions: [] };

describe("tunnelArgs", () => {
  it("forwards loopback to loopback and keeps the connection alive", () => {
    expect(tunnelArgs({ ...base, sshOptions: ["ProxyJump=bastion"] })).toEqual([
      "-N",
      "-L",
      "127.0.0.1:17420:127.0.0.1:7420",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      "-o",
      "ProxyJump=bastion",
      "--",
      "me@work",
    ]);
  });

  it("refuses a destination that looks like an option", () => {
    expect(() => tunnelArgs({ ...base, target: "-oProxyCommand=evil" })).toThrow(/destination/);
  });
});

function fakeChild(): ChildProcess & { exit(code: number): void } {
  const child = new EventEmitter() as ChildProcess & { exit(code: number): void };
  child.kill = () => {
    queueMicrotask(() => child.emit("exit", null));
    return true;
  };
  child.exit = (code) => child.emit("exit", code);
  return child;
}

describe("runTunnel", () => {
  it("stops when ssh exits before the forward ever opened", async () => {
    const statuses: TunnelStatus[] = [];
    const code = await runTunnel(base, {
      spawn: () => {
        const c = fakeChild();
        setTimeout(() => c.exit(255), 20);
        return c;
      },
      probe: async () => "unreachable",
      onStatus: (s) => statuses.push(s),
    });
    expect(code).toBe(1);
    expect(statuses.map((s) => s.kind)).toEqual(["connecting", "failed"]);
  });

  it("reports the hub, reconnects after a drop, and stops on abort", async () => {
    const statuses: TunnelStatus[] = [];
    const abort = new AbortController();
    let spawns = 0;
    let current: ReturnType<typeof fakeChild> | undefined;
    const done = runTunnel(base, {
      spawn: () => {
        spawns++;
        current = fakeChild();
        return current;
      },
      probe: async () => "hub",
      onStatus: (s) => {
        statuses.push(s);
        if (s.kind === "up" && spawns === 1) setTimeout(() => current!.exit(255), 10);
        if (s.kind === "up" && spawns === 2) abort.abort();
      },
      backoffMs: () => 10,
      signal: abort.signal,
    });
    expect(await done).toBe(0);
    expect(statuses.map((s) => s.kind)).toEqual(["connecting", "up", "down", "connecting", "up"]);
  });

  it("says when the forward works but no hub answers", async () => {
    const statuses: TunnelStatus[] = [];
    const abort = new AbortController();
    await runTunnel(base, {
      spawn: () => fakeChild(),
      probe: async () => "no-answer",
      onStatus: (s) => {
        statuses.push(s);
        if (s.kind === "no-hub") abort.abort();
      },
      signal: abort.signal,
    });
    expect(statuses[1]).toMatchObject({ kind: "no-hub", detail: expect.stringMatching(/no hub is listening on remote port 7420/) });
  });
});

async function listen(server: Server | net.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  return (server.address() as AddressInfo).port;
}

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

describe("probeHub", () => {
  it("tells a hub from another server and from nothing", async () => {
    const hub = createServer((_req, res) => res.end(JSON.stringify({ loom: "hub", protocol: 1 })));
    const other = createServer((_req, res) => res.writeHead(404).end());
    const silent = net.createServer((socket) => socket.destroy());
    expect(await probeHub(`http://127.0.0.1:${await listen(hub)}`)).toBe("hub");
    expect(await probeHub(`http://127.0.0.1:${await listen(other)}`)).toBe("other");
    expect(await probeHub(`http://127.0.0.1:${await listen(silent)}`)).toBe("no-answer");
    expect(await probeHub(`http://127.0.0.1:${await freePort()}`)).toBe("unreachable");
  });
});

// A real OpenSSH round trip against a throwaway sshd running as this user on a free port. It never
// touches ~/.ssh or the system sshd.
const SSHD = ["/usr/sbin/sshd", "/usr/bin/sshd"].find((p) => existsSync(p));
const haveOpenSsh = process.platform !== "win32" && SSHD !== undefined && hasCommand("ssh") && hasCommand("ssh-keygen");

function hasCommand(cmd: string): boolean {
  try {
    execFileSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!haveOpenSsh)("runTunnel with OpenSSH", () => {
  it("reaches a hub through a real ssh forward", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "loom-sshd-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const key = (name: string) => execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path.join(dir, name)]);
    key("host");
    key("client");
    writeFileSync(path.join(dir, "authorized_keys"), execFileSync("cat", [path.join(dir, "client.pub")]));
    const sshPort = await freePort();
    writeFileSync(
      path.join(dir, "sshd_config"),
      [
        `Port ${sshPort}`,
        "ListenAddress 127.0.0.1",
        `HostKey ${path.join(dir, "host")}`,
        `AuthorizedKeysFile ${path.join(dir, "authorized_keys")}`,
        `PidFile ${path.join(dir, "sshd.pid")}`,
        "PasswordAuthentication no",
        "KbdInteractiveAuthentication no",
        "UsePAM no",
        "StrictModes no",
        "AllowTcpForwarding local",
        "",
      ].join("\n"),
    );
    const sshd = spawn(SSHD!, ["-D", "-e", "-f", path.join(dir, "sshd_config")], { stdio: ["ignore", "ignore", "pipe"] });
    let sshdLog = "";
    sshd.stderr.on("data", (d) => (sshdLog += d));
    cleanups.push(() => void sshd.kill());
    for (let i = 0; i < 50 && (await probeHub(`http://127.0.0.1:${sshPort}`, 200)) === "unreachable"; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }

    const hub = createServer((_req, res) => res.end(JSON.stringify({ loom: "hub", protocol: 1 })));
    const remotePort = await listen(hub);
    const localPort = await freePort();

    const statuses: TunnelStatus[] = [];
    const abort = new AbortController();
    const code = await runTunnel(
      {
        target: `${os.userInfo().username}@127.0.0.1`,
        remotePort,
        localPort,
        sshOptions: [
          `Port=${sshPort}`,
          `IdentityFile=${path.join(dir, "client")}`,
          "IdentitiesOnly=yes",
          "BatchMode=yes",
          "StrictHostKeyChecking=no",
          `UserKnownHostsFile=${path.join(dir, "known_hosts")}`,
          "LogLevel=ERROR",
        ],
      },
      {
        spawn: (cmd, args) => spawn(cmd, ["-F", "/dev/null", ...args], { stdio: "ignore" }),
        onStatus: (s) => {
          statuses.push(s);
          if (s.kind === "up" || s.kind === "failed") abort.abort();
        },
        signal: abort.signal,
      },
    );
    expect(statuses.map((s) => s.kind), sshdLog).toEqual(["connecting", "up"]);
    expect(code).toBe(0);
  }, 20_000);
});
