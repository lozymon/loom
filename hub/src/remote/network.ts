import { execFile } from "node:child_process";
import net from "node:net";

export class BindError extends Error {
  override name = "BindError";
}

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

export function isLoopback(address: string): boolean {
  const a = address.replace(/^::ffff:/, "");
  if (a === "localhost" || a === "::1") return true;
  return net.isIPv4(a) && a.startsWith("127.");
}

/** Tailscale's address ranges: 100.64.0.0/10 and fd7a:115c:a1e0::/48. */
export function isTailnet(address: string): boolean {
  const a = address.replace(/^::ffff:/, "");
  if (net.isIPv4(a)) {
    const n = ipv4ToInt(a);
    return n >= ipv4ToInt("100.64.0.0") && n <= ipv4ToInt("100.127.255.255");
  }
  return net.isIPv6(a) && /^fd7a:115c:a1e0:/i.test(a);
}

/**
 * The client's address. Behind a local reverse proxy (`tailscale serve`, Caddy) the socket is
 * loopback, so the proxy's X-Forwarded-For is used; only local processes can reach loopback to set it.
 */
export function clientAddress(remote: string | undefined, headers: Record<string, string | string[] | undefined>): string {
  const socket = remote ?? "unknown";
  const forwarded = headers["x-forwarded-for"];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
  return isLoopback(socket) && first ? first : socket;
}

/** True when a request came through a proxy rather than straight from this machine. */
export function isForwarded(headers: Record<string, string | string[] | undefined>): boolean {
  return ["x-forwarded-for", "forwarded", "tailscale-user-login", "x-real-ip"].some((h) => headers[h] !== undefined);
}

export function tailscaleAddress(): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("tailscale", ["ip", "-4"], { timeout: 3000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(undefined);
      resolve(String(stdout).split(/\s+/).find((l) => net.isIPv4(l)));
    });
  });
}

export interface BindPlan {
  /** Addresses to listen on. Loopback is always first so local hooks and tools reach the hub. */
  hosts: string[];
  kind: "loopback" | "tailnet" | "tls" | "unencrypted";
  warning?: string;
}

/**
 * Where a hub may listen (ADR-0008): loopback, loopback plus a Tailscale address, or anything else only
 * with an explicit opt-in, because the protocol itself is not encrypted.
 */
export async function planBind(
  bind: string,
  opts: { allowUnencryptedNetwork: boolean; tls?: boolean; tailscale?: () => Promise<string | undefined> },
): Promise<BindPlan> {
  if (isLoopback(bind)) return { hosts: [bind === "localhost" ? "127.0.0.1" : bind], kind: "loopback" };

  if (bind === "tailscale") {
    const ip = await (opts.tailscale ?? tailscaleAddress)();
    if (!ip) throw new BindError('bind is "tailscale" but no Tailscale address was found. Is Tailscale running and logged in?');
    return { hosts: ["127.0.0.1", ip], kind: "tailnet" };
  }
  if (isTailnet(bind)) return { hosts: ["127.0.0.1", bind], kind: "tailnet" };

  if (!net.isIP(bind)) throw new BindError(`bind "${bind}" is not an IP address, "localhost", or "tailscale"`);
  const wildcard = bind === "0.0.0.0" || bind === "::";
  if (opts.tls) {
    // Loopback stays plain HTTP for hooks and local tools, which cannot check a certificate for 127.0.0.1.
    if (wildcard) throw new BindError(`with "tls", bind a specific address rather than ${bind}, so loopback can stay plain for local tools`);
    return { hosts: ["127.0.0.1", bind], kind: "tls" };
  }
  if (!opts.allowUnencryptedNetwork) {
    throw new BindError(
      `refusing to listen on ${bind}: Loom traffic is not encrypted, so a network address other than Tailscale would expose your token and sessions. ` +
        `Use an SSH tunnel (loom tunnel) or Tailscale instead, or set "allowUnencryptedNetwork": true if this network is trusted.`,
    );
  }
  return {
    hosts: wildcard ? [bind] : ["127.0.0.1", bind],
    kind: "unencrypted",
    warning: `listening on ${bind} without encryption; anyone on that network who sees the token can drive your sessions`,
  };
}
