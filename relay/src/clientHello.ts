/**
 * Reads the server name from a TLS ClientHello (RFC 8446 §4.1.2, RFC 6066 §3). Only lengths and the
 * name are read; nothing is decrypted or checked. The relay routes on the result (ADR-0014).
 */

export const MAX_HELLO_BYTES = 16 * 1024;

export type HelloResult =
  | { kind: "need-more" }
  | { kind: "not-tls" }
  | { kind: "hello"; serverName: string | undefined };

/** Joins the handshake bytes carried by the leading TLS records, or says more bytes are needed. */
function handshakeBytes(buf: Buffer): Buffer | "need-more" | "not-tls" {
  const parts: Buffer[] = [];
  let offset = 0;
  let total = 0;
  let needed: number | undefined;
  while (offset + 5 <= buf.length) {
    if (buf[offset] !== 22) return parts.length ? Buffer.concat(parts) : "not-tls";
    const length = buf.readUInt16BE(offset + 3);
    if (offset + 5 + length > buf.length) return "need-more";
    parts.push(buf.subarray(offset + 5, offset + 5 + length));
    total += length;
    offset += 5 + length;
    if (needed === undefined && total >= 4) {
      const joined = Buffer.concat(parts);
      needed = 4 + ((joined[1]! << 16) | (joined[2]! << 8) | joined[3]!);
    }
    if (needed !== undefined && total >= needed) return Buffer.concat(parts);
  }
  if (offset === 0 && buf.length >= 1 && buf[0] !== 22) return "not-tls";
  return "need-more";
}

export function parseClientHello(buf: Buffer): HelloResult {
  if (buf.length > MAX_HELLO_BYTES) return { kind: "not-tls" };
  const hs = handshakeBytes(buf);
  if (hs === "need-more") return { kind: "need-more" };
  if (hs === "not-tls" || hs[0] !== 1) return { kind: "not-tls" };
  try {
    let p = 4 + 2 + 32; // handshake header, legacy_version, random
    p += 1 + hs.readUInt8(p); // session id
    p += 2 + hs.readUInt16BE(p); // cipher suites
    p += 1 + hs.readUInt8(p); // compression methods
    if (p === hs.length) return { kind: "hello", serverName: undefined };
    const end = p + 2 + hs.readUInt16BE(p);
    p += 2;
    while (p + 4 <= end) {
      const type = hs.readUInt16BE(p);
      const size = hs.readUInt16BE(p + 2);
      p += 4;
      if (type === 0) {
        let q = p + 2;
        const listEnd = p + 2 + hs.readUInt16BE(p);
        while (q + 3 <= listEnd) {
          const nameType = hs.readUInt8(q);
          const nameLength = hs.readUInt16BE(q + 1);
          if (nameType === 0) {
            const name = hs.toString("ascii", q + 3, q + 3 + nameLength).toLowerCase();
            return { kind: "hello", serverName: /^[a-z0-9.-]{1,253}$/.test(name) ? name : undefined };
          }
          q += 3 + nameLength;
        }
      }
      p += size;
    }
    return { kind: "hello", serverName: undefined };
  } catch {
    return { kind: "not-tls" };
  }
}

/** Host header and path from the start of an HTTP/1.1 request, for port 80. */
export function parseHttpHead(buf: Buffer): { kind: "need-more" } | { kind: "bad" } | { kind: "request"; host: string; path: string } {
  const end = buf.indexOf("\r\n\r\n");
  if (end < 0) return buf.length > 8192 ? { kind: "bad" } : { kind: "need-more" };
  const lines = buf.toString("latin1", 0, end).split("\r\n");
  const request = /^[A-Z]+ (\S+) HTTP\/1\.[01]$/.exec(lines[0] ?? "");
  const host = lines.find((l) => /^host:/i.test(l))?.slice(5).trim().toLowerCase().replace(/:\d+$/, "");
  if (!request?.[1] || !host) return { kind: "bad" };
  return { kind: "request", host, path: request[1] };
}
