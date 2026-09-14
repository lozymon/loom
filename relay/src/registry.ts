import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface EnrolledHub {
  name: string;
  secretHash: string;
  createdAt: string;
}

const NAME = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const hash = (secret: string) => createHash("sha256").update(secret, "utf8").digest("hex");

/** The hubs allowed to register a name on this relay, with their enrollment secrets hashed. */
export class HubRegistry {
  #file: string;
  #hubs: EnrolledHub[] = [];
  #loaded = "";

  constructor(file: string) {
    this.#file = file;
    this.#reload();
  }

  /** Picks up `add-hub` and `remove-hub` run by another process while the relay is running. */
  #reload(): void {
    const stamp = existsSync(this.#file) ? ((st) => `${st.mtimeMs}:${st.size}:${st.ino}`)(statSync(this.#file)) : "none";
    if (stamp === this.#loaded) return;
    this.#hubs = stamp === "none" ? [] : (JSON.parse(readFileSync(this.#file, "utf8")) as EnrolledHub[]);
    this.#loaded = stamp;
  }

  #save(): void {
    mkdirSync(path.dirname(this.#file), { recursive: true });
    const tmp = `${this.#file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.#hubs, null, 2)}\n`, { mode: 0o600 });
    if (process.platform !== "win32") chmodSync(tmp, 0o600);
    renameSync(tmp, this.#file);
    this.#loaded = "";
    this.#reload();
  }

  /** Enrolls a hub, or replaces its secret. Returns the secret, which is never stored. */
  add(name: string, now = new Date()): string {
    this.#reload();
    if (!NAME.test(name)) throw new Error("a hub name is 1–32 lowercase letters, digits, and inner hyphens");
    const secret = randomBytes(32).toString("base64url");
    this.#hubs = [...this.#hubs.filter((h) => h.name !== name), { name, secretHash: hash(secret), createdAt: now.toISOString() }];
    this.#save();
    return secret;
  }

  remove(name: string): boolean {
    this.#reload();
    const before = this.#hubs.length;
    this.#hubs = this.#hubs.filter((h) => h.name !== name);
    if (this.#hubs.length !== before) this.#save();
    return this.#hubs.length !== before;
  }

  list(): EnrolledHub[] {
    this.#reload();
    return [...this.#hubs];
  }

  verify(name: string, secret: string | undefined): boolean {
    this.#reload();
    const hub = this.#hubs.find((h) => h.name === name);
    if (!hub || !secret) return false;
    const a = Buffer.from(hash(secret), "hex");
    const b = Buffer.from(hub.secretHash, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
