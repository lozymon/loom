import type { Claim, Note } from "@loom/protocol";
import { HubError } from "../errors.ts";
import { projectRoot } from "../git/project.ts";

/**
 * Shared notes and advisory file claims per project, in memory (v1 blackboard and claims). Coordination
 * state for sessions working side by side, not history.
 */
export class Blackboard {
  #notes = new Map<string, Map<string, Note>>();
  #claims = new Map<string, Map<string, Claim>>();
  #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  #project<T>(store: Map<string, Map<string, T>>, cwd: string): Map<string, T> {
    const root = projectRoot(cwd);
    let m = store.get(root);
    if (!m) {
      m = new Map();
      store.set(root, m);
    }
    return m;
  }

  setNote(cwd: string, key: string, value: string, by: string): Note {
    const note = { key, value, by, at: this.#now() };
    this.#project(this.#notes, cwd).set(key, note);
    return note;
  }

  getNote(cwd: string, key: string): Note | null {
    return this.#project(this.#notes, cwd).get(key) ?? null;
  }

  listNotes(cwd: string): Note[] {
    return [...this.#project(this.#notes, cwd).values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  deleteNote(cwd: string, key: string): void {
    this.#project(this.#notes, cwd).delete(key);
  }

  /** Test-and-set: fails if someone else holds the path. Re-claiming your own path refreshes it. */
  claim(cwd: string, path: string, holder: string, holderName: string, note?: string): Claim {
    const claims = this.#project(this.#claims, cwd);
    const existing = claims.get(path);
    if (existing && existing.holder !== holder) {
      throw new HubError("invalid", `${path} is claimed by ${existing.holderName}${existing.note ? ` (${existing.note})` : ""}`);
    }
    const claim: Claim = { path, holder, holderName, at: this.#now(), ...(note ? { note } : {}) };
    claims.set(path, claim);
    return claim;
  }

  release(cwd: string, path: string, holder: string, force: boolean): void {
    const claims = this.#project(this.#claims, cwd);
    const existing = claims.get(path);
    if (!existing) return;
    if (existing.holder !== holder && !force) throw new HubError("invalid", `${path} is claimed by ${existing.holderName}; release it with force`);
    claims.delete(path);
  }

  listClaims(cwd: string): Claim[] {
    return [...this.#project(this.#claims, cwd).values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Drops every claim a session holds, e.g. when it ends. */
  releaseAll(holder: string): void {
    for (const claims of this.#claims.values()) for (const [p, c] of claims) if (c.holder === holder) claims.delete(p);
  }
}
