import { type ChildProcess, spawn } from "node:child_process";
import net from "node:net";

/**
 * `loom tunnel` (ADR-0008): reach a hub on another computer through OpenSSH port forwarding. Loom adds
 * no crypto of its own; SSH handles keys, host verification, and encryption. The hub keeps listening on
 * its own loopback address, so nothing on the remote machine is exposed.
 */

export interface TunnelOptions {
  /** `[user@]host`, or an alias from ~/.ssh/config. */
  target: string;
  /** Hub port on the remote machine. */
  remotePort: number;
  /** Port on this machine. */
  localPort: number;
  /** Extra `-o` options, e.g. `ProxyJump=bastion`. */
  sshOptions: string[];
  /** ssh binary; `ssh` on PATH by default (OpenSSH ships with Windows 10 and later). */
  ssh?: string;
}

export function tunnelArgs(o: TunnelOptions): string[] {
  if (o.target.startsWith("-")) throw new Error(`not an ssh destination: ${o.target}`);
  return [
    "-N",
    "-L",
    `127.0.0.1:${o.localPort}:127.0.0.1:${o.remotePort}`,
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    ...o.sshOptions.flatMap((opt) => ["-o", opt]),
    "--",
    o.target,
  ];
}

export type TunnelStatus =
  | { kind: "connecting"; attempt: number }
  | { kind: "up"; url: string }
  /** ssh forwards the port, but no Loom hub answers on the other side. */
  | { kind: "no-hub"; url: string; detail: string }
  | { kind: "down"; code: number | null; retryInMs: number }
  | { kind: "failed"; code: number | null };

export type ProbeResult = "hub" | "other" | "no-answer" | "unreachable";

function portOpen(url: string, timeoutMs: number): Promise<boolean> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve) => {
    const socket = net.connect({ host: hostname, port: Number(port) });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/**
 * What answers at `url`: a Loom hub, another server, an open port with nothing behind it (an ssh forward
 * whose remote end refuses), or nothing at all.
 */
export async function probeHub(url: string, timeoutMs = 2000): Promise<ProbeResult> {
  if (!(await portOpen(url, timeoutMs))) return "unreachable";
  try {
    const res = await fetch(`${url}/loom.json`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return "other";
    const body = (await res.json()) as { loom?: unknown };
    return body.loom === "hub" ? "hub" : "other";
  } catch {
    return "no-answer";
  }
}

export interface RunTunnelDeps {
  spawn?: (command: string, args: string[]) => ChildProcess;
  probe?: typeof probeHub;
  onStatus: (s: TunnelStatus) => void;
  signal?: AbortSignal;
  backoffMs?: (attempt: number) => number;
}

const defaultBackoff = (attempt: number) => Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));

/**
 * Runs ssh until aborted. When the tunnel drops after having worked, it reconnects with backoff. When
 * ssh exits before the forward ever opened (bad host, refused key, local port taken), it stops: retrying
 * would only repeat the error.
 */
export async function runTunnel(o: TunnelOptions, deps: RunTunnelDeps): Promise<number> {
  const run = deps.spawn ?? ((cmd, args) => spawn(cmd, args, { stdio: ["inherit", "inherit", "inherit"], windowsHide: true }));
  const probe = deps.probe ?? probeHub;
  const backoff = deps.backoffMs ?? defaultBackoff;
  const url = `http://127.0.0.1:${o.localPort}`;
  let forwarded = false;
  let attempt = 0;

  while (!deps.signal?.aborted) {
    attempt++;
    deps.onStatus({ kind: "connecting", attempt });
    const child = run(o.ssh ?? "ssh", tunnelArgs(o));
    const exited = new Promise<number | null>((resolve) => {
      child.once("exit", (code) => resolve(code));
      child.once("error", () => resolve(null));
    });
    const onAbort = () => child.kill();
    deps.signal?.addEventListener("abort", onAbort, { once: true });

    // Watch the forward while ssh runs. Only the first answer after each start is reported.
    let alive = true;
    void exited.then(() => {
      alive = false;
    });
    const watch = (async () => {
      let reported: ProbeResult | undefined;
      while (alive) {
        const r = await probe(url);
        if (!alive) return;
        if (r !== "unreachable") {
          forwarded = true;
          attempt = 0;
        }
        if (r !== "unreachable" && r !== reported) {
          reported = r;
          if (r === "hub") deps.onStatus({ kind: "up", url });
          else {
            const detail =
              r === "other"
                ? `something other than a Loom hub answers on remote port ${o.remotePort}`
                : `no hub is listening on remote port ${o.remotePort}; start it there (npm run hub)`;
            deps.onStatus({ kind: "no-hub", url, detail });
          }
        }
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([exited, new Promise((r2) => (timer = setTimeout(r2, reported === "hub" ? 5000 : 500)))]);
        clearTimeout(timer);
      }
    })();

    const code = await exited;
    await watch;
    deps.signal?.removeEventListener("abort", onAbort);
    if (deps.signal?.aborted) break;
    if (!forwarded) {
      deps.onStatus({ kind: "failed", code });
      return 1;
    }
    const retryInMs = backoff(attempt);
    deps.onStatus({ kind: "down", code, retryInMs });
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, retryInMs);
      deps.signal?.addEventListener("abort", () => {
        clearTimeout(t);
        resolve();
      }, { once: true });
    });
  }
  return 0;
}
