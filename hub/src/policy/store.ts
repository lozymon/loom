import {
  type ApprovalTimeout,
  PolicyFile,
  type PolicyScope,
  type PolicySourceView,
  type PolicyView,
  type RuleRef,
} from "@loom/protocol";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { HubError } from "../errors.ts";
import { evaluate, policyProblems, type PolicySource, suggestRule, type Verdict } from "./evaluate.ts";
import type { ToolCall } from "./match.ts";
import { parseRule } from "./rules.ts";
import { projectRoot } from "../git/project.ts";
import { toPosix } from "./paths.ts";

export interface PolicyStoreOptions {
  /** The hub's policy.json, next to hub.json. `/path` rules in it anchor at its directory. */
  hubFile: string;
  /** Where trusted project allow lists are recorded. */
  trustFile: string;
  home?: string;
  platform?: NodeJS.Platform;
}

interface Loaded {
  policy: PolicyFile;
  exists: boolean;
  loadError?: string;
  stamp: string;
}

const EMPTY: PolicyFile = { allow: [], deny: [], ask: [] };
const TrustFile = z.object({ projects: z.record(z.string(), z.string()) });

/** Hash of an allow list, order-insensitive, so reordering does not ask for trust again. */
export function allowHash(allow: readonly string[]): string {
  const normal = [...new Set(allow.map((r) => r.trim()))].sort();
  return createHash("sha256").update(JSON.stringify(normal)).digest("hex").slice(0, 32);
}

export { projectRoot } from "../git/project.ts";

/**
 * Reads, evaluates, and writes Loom policy files (ADR-0006, ADR-0012). Files are re-read when they
 * change on disk, so an edit in an editor applies to the next approval without a hub restart.
 */
export class PolicyStore {
  readonly hubFile: string;
  #trustFile: string;
  #home: string;
  #platform: NodeJS.Platform;
  #cache = new Map<string, Loaded>();

  constructor(opts: PolicyStoreOptions) {
    this.hubFile = opts.hubFile;
    this.#trustFile = opts.trustFile;
    this.#home = opts.home ?? os.homedir();
    this.#platform = opts.platform ?? process.platform;
  }

  get trustFile(): string {
    return this.#trustFile;
  }

  /**
   * Files no agent may change without a person: Loom policy for this session's project and checkout,
   * the hub policy, and the trust record. Passed to Claude as ask rules and enforced by Loom too.
   */
  protectedFiles(cwd: string): string[] {
    const files = new Set([
      this.projectFile(cwd).file,
      path.join(path.resolve(cwd), ".loom", "policy.json"),
      this.hubFile,
      this.#trustFile,
    ]);
    return [...files];
  }

  /** `Edit(//abs/path)` rules for `protectedFiles`, in the form Claude Code and Loom both match. */
  protectionRules(cwd: string): string[] {
    return this.protectedFiles(cwd).map((f) => `Edit(//${toPosix(f, this.#platform).replace(/^\/+/, "")})`);
  }

  projectFile(cwd: string): { root: string; file: string } {
    const root = projectRoot(cwd);
    return { root, file: path.join(root, ".loom", "policy.json") };
  }

  evaluate(cwd: string, call: ToolCall): Verdict {
    return evaluate(call, this.#sources(cwd), { cwd, home: this.#home, platform: this.#platform });
  }

  suggest(cwd: string, call: ToolCall): string | undefined {
    return suggestRule(call, cwd);
  }

  /** Project timeout, else hub timeout. */
  timeoutFor(cwd: string): ApprovalTimeout | undefined {
    return this.#load(this.projectFile(cwd).file).policy.approvalTimeout ?? this.#load(this.hubFile).policy.approvalTimeout;
  }

  view(cwd: string): PolicyView {
    const { root, file } = this.projectFile(cwd);
    const project = this.#load(file);
    const hash = allowHash(project.policy.allow);
    return {
      hub: this.#sourceView(this.hubFile, this.#load(this.hubFile)),
      project: { ...this.#sourceView(file, project), root, trusted: this.#isTrusted(root, project.policy), allowHash: hash },
    };
  }

  save(scope: PolicyScope, cwd: string, input: PolicyFile): PolicyView {
    const policy = PolicyFile.parse(input);
    if (scope === "hub") {
      this.#write(this.hubFile, policy);
    } else {
      const { root, file } = this.projectFile(cwd);
      this.#write(file, policy);
      this.#trust(root, allowHash(policy.allow));
    }
    return this.view(cwd);
  }

  trust(cwd: string, expectedHash: string): PolicyView {
    const { root, file } = this.projectFile(cwd);
    const current = allowHash(this.#load(file).policy.allow);
    if (current !== expectedHash) {
      throw new HubError("invalid", "the project's allow rules changed since they were shown; review them again");
    }
    this.#trust(root, current);
    return this.view(cwd);
  }

  /** Adds an allow rule, from "always allow in Loom policy". Trusts the result for project policy. */
  appendAllow(scope: PolicyScope, cwd: string, rule: string): RuleRef {
    const text = rule.trim();
    const parsed = parseRule(text, "allow");
    if (!parsed.ok) throw new HubError("invalid", `cannot save rule ${text}: ${parsed.message}`);
    const file = scope === "hub" ? this.hubFile : this.projectFile(cwd).file;
    const current = this.#load(file);
    if (current.loadError) throw new HubError("invalid", `cannot update ${file}: ${current.loadError}`);
    const policy = current.policy.allow.includes(text) ? current.policy : { ...current.policy, allow: [...current.policy.allow, text] };
    // Trust only what was trusted before plus this rule; an untrusted list stays untrusted.
    if (scope === "project") {
      const root = this.projectFile(cwd).root;
      const wasTrusted = this.#isTrusted(root, current.policy);
      this.#write(file, policy);
      if (wasTrusted) this.#trust(root, allowHash(policy.allow));
    } else {
      this.#write(file, policy);
    }
    return { list: "allow", rule: text, scope, path: file };
  }

  // -------------------------------------------------------------------------

  #sources(cwd: string): PolicySource[] {
    const { root, file } = this.projectFile(cwd);
    const project = this.#load(file);
    const hub = this.#load(this.hubFile);
    const builtin: PolicyFile = { allow: [], deny: [], ask: [...this.protectionRules(cwd), "Bash(*.loom/policy.json*)", "Bash(*trust.json*)"] };
    return [
      { scope: "builtin", path: "built in", anchor: root, policy: builtin, allowTrusted: false },
      { scope: "hub", path: this.hubFile, anchor: path.dirname(this.hubFile), policy: hub.policy, allowTrusted: true },
      { scope: "project", path: file, anchor: root, policy: project.policy, allowTrusted: this.#isTrusted(root, project.policy) },
    ];
  }

  #sourceView(file: string, loaded: Loaded): PolicySourceView {
    return {
      path: file,
      exists: loaded.exists,
      policy: loaded.policy,
      ...(loaded.loadError ? { loadError: loaded.loadError } : {}),
      problems: policyProblems(loaded.policy),
    };
  }

  #load(file: string): Loaded {
    let stamp = "missing";
    try {
      const st = statSync(file);
      stamp = `${st.mtimeMs}:${st.size}`;
    } catch {
      // missing file: empty policy
    }
    const cached = this.#cache.get(file);
    if (cached && cached.stamp === stamp) return cached;

    let loaded: Loaded;
    if (stamp === "missing") {
      loaded = { policy: EMPTY, exists: false, stamp };
    } else {
      try {
        const parsed = PolicyFile.safeParse(JSON.parse(readFileSync(file, "utf8")));
        loaded = parsed.success
          ? { policy: parsed.data, exists: true, stamp }
          : { policy: EMPTY, exists: true, stamp, loadError: z.prettifyError(parsed.error) };
      } catch (err) {
        loaded = { policy: EMPTY, exists: true, stamp, loadError: `not valid JSON: ${(err as Error).message}` };
      }
    }
    // A policy that fails to load must not silently drop its deny rules: keep the last good deny and ask lists.
    if (loaded.loadError && cached && !cached.loadError) {
      loaded = { ...loaded, policy: { allow: [], deny: cached.policy.deny, ask: cached.policy.ask } };
    }
    this.#cache.set(file, loaded);
    return loaded;
  }

  #write(file: string, policy: PolicyFile): void {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    const clean: PolicyFile = {
      allow: policy.allow,
      deny: policy.deny,
      ask: policy.ask,
      ...(policy.approvalTimeout ? { approvalTimeout: policy.approvalTimeout } : {}),
    };
    writeFileSync(tmp, `${JSON.stringify(clean, null, 2)}\n`);
    renameSync(tmp, file);
    this.#cache.delete(file);
  }

  #readTrust(): Record<string, string> {
    try {
      return TrustFile.parse(JSON.parse(readFileSync(this.#trustFile, "utf8"))).projects;
    } catch {
      return {};
    }
  }

  #isTrusted(root: string, policy: PolicyFile): boolean {
    if (policy.allow.length === 0) return true;
    return this.#readTrust()[root] === allowHash(policy.allow);
  }

  #trust(root: string, hash: string): void {
    const projects = { ...this.#readTrust(), [root]: hash };
    mkdirSync(path.dirname(this.#trustFile), { recursive: true });
    writeFileSync(this.#trustFile, `${JSON.stringify({ projects }, null, 2)}\n`, { mode: 0o600 });
  }
}
