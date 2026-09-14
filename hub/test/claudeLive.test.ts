import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { claudeSdkFactory } from "../src/adapters/claude-sdk/claudeSdkAdapter.ts";
import { SessionManager } from "../src/core/sessionManager.ts";
import { EventLog } from "../src/log/eventLog.ts";

/**
 * Talks to the real Claude Agent SDK with this machine's login. Costs a few cents of usage, so it
 * only runs with LOOM_LIVE_SDK=1.
 */
const live = process.env.LOOM_LIVE_SDK === "1";

describe.skipIf(!live)("claude-sdk adapter against the real SDK", () => {
  it(
    "answers, asks for approval, writes after allow, and resumes after stop",
    async () => {
      const cwd = mkdtempSync(path.join(os.tmpdir(), "loom-live-"));
      const manager = new SessionManager({
        log: new EventLog(":memory:", "live"),
        defaultLevel: "supervised",
        maxLevel: "accept-edits",
        adapters: { "claude-sdk": claudeSdkFactory() },
      });
      manager.init();
      const waitFor = async (check: () => boolean) => {
        const end = Date.now() + 120_000;
        while (!check()) {
          if (Date.now() > end) throw new Error("timed out");
          await new Promise((r) => setTimeout(r, 100));
        }
      };

      try {
        const s = await manager.create({
          adapter: "claude-sdk",
          cwd,
          prompt: "Use the Write tool to create note.txt containing the word loom. Then reply with only DONE.",
        });
        await waitFor(() => manager.approvals().length > 0);
        const [approval] = manager.approvals();
        expect(approval).toMatchObject({ kind: "permission", summary: "Write note.txt" });
        manager.decide(approval!.id, { type: "allow" });
        await waitFor(() => manager.get(s.id).state === "idle");
        expect(manager.get(s.id).engineSessionId).toBeTruthy();
        expect(manager.get(s.id).costUsd).toBeGreaterThan(0);

        const before = manager.get(s.id).costUsd;
        await manager.stop(s.id);
        await manager.send(s.id, "What single word did you write into note.txt? Reply with only that word.");
        await waitFor(() => manager.get(s.id).state === "idle");
        const texts = manager.read(s.id).flatMap((e) => (e.event.type === "assistant.text" ? [e.event.text] : []));
        expect(texts.at(-1)?.toLowerCase()).toContain("loom");
        expect(manager.get(s.id).costUsd).toBeGreaterThan(before);
        await manager.shutdown();
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    300_000,
  );
});
