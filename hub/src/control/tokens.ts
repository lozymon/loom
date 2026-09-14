import { createHash, randomBytes } from "node:crypto";
import type { SessionRole } from "./actor.ts";

interface Entry {
  sessionId: string;
  role: SessionRole;
}

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Tokens that identify an engine process as one session with one role. A new token is issued at each
 * launch; the previous one stops working. In memory only: no engine outlives the hub.
 */
export class SessionTokens {
  #byHash = new Map<string, Entry>();
  #bySession = new Map<string, string>();

  issue(sessionId: string, role: SessionRole): string {
    this.revoke(sessionId);
    const token = `ls_${randomBytes(32).toString("base64url")}`;
    const h = hash(token);
    this.#byHash.set(h, { sessionId, role });
    this.#bySession.set(sessionId, h);
    return token;
  }

  verify(token: string | undefined): Entry | undefined {
    if (!token?.startsWith("ls_")) return undefined;
    return this.#byHash.get(hash(token));
  }

  revoke(sessionId: string): void {
    const h = this.#bySession.get(sessionId);
    if (h) this.#byHash.delete(h);
    this.#bySession.delete(sessionId);
  }
}
