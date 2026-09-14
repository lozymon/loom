import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Bearer tokens for TCP clients (ADR-0008). The hub stores only a SHA-256 hash; the token itself
 * is printed once, when created or rotated.
 */

export function createToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function verifyToken(token: string | undefined, expectedHash: string): boolean {
  if (!token) return false;
  const a = Buffer.from(hashToken(token), "hex");
  const b = Buffer.from(expectedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface AuthState {
  tokenHash: string;
  /** Present only when a token was created or rotated during this call. */
  newToken?: string;
}

export function loadOrCreateAuth(file: string, opts: { rotate?: boolean } = {}): AuthState {
  if (!opts.rotate && existsSync(file)) {
    const stored = JSON.parse(readFileSync(file, "utf8")) as { tokenHash?: unknown };
    if (typeof stored.tokenHash === "string" && /^[0-9a-f]{64}$/.test(stored.tokenHash)) {
      return { tokenHash: stored.tokenHash };
    }
  }
  const token = createToken();
  const tokenHash = hashToken(token);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ tokenHash }, null, 2)}\n`, { mode: 0o600 });
  return { tokenHash, newToken: token };
}
