// Loom v2 — Agent SDK smoke test.
//
// Answers one question before any hub code is written: does the Claude Agent SDK
// work on this machine, with this login and this organization's policies, in the
// ways Loom v2 needs? Each step below maps to a design assumption in PLAN.md.
//
//   node smoke.mjs                 run all steps
//   node smoke.mjs --model <id>    force a model (default: whatever Claude Code picks)
//   node smoke.mjs --only 1,5      run a subset
//
// Writes smoke-report.json next to this file. Paste that file back into the plan
// discussion. It contains no credentials; it does contain paths and model names.

import { query } from "@anthropic-ai/claude-agent-sdk";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORK = join(HERE, ".smoke-work");
const STEP_TIMEOUT_MS = 180_000;

const args = process.argv.slice(2);
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const MODEL = argValue("--model");
const ONLY = argValue("--only")?.split(",").map((s) => Number(s.trim()));

const report = {
  startedAt: new Date().toISOString(),
  environment: environment(),
  steps: [],
};

// ---------------------------------------------------------------------------
// helpers

function environment() {
  const claude = spawnSync("claude", ["--version"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  const env = {
    platform: process.platform,
    release: os.release(),
    isWSL: process.platform === "linux" && /microsoft/i.test(os.release()),
    arch: process.arch,
    node: process.version,
    claudeCliOnPath: claude.status === 0 ? claude.stdout.trim() : null,
    anthropicApiKeySet: Boolean(process.env.ANTHROPIC_API_KEY),
    anthropicAuthTokenSet: Boolean(process.env.ANTHROPIC_AUTH_TOKEN),
    cloudProviderEnv: ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"].filter(
      (k) => process.env[k],
    ),
  };
  if (process.platform === "win32") {
    const bash = spawnSync("where", ["bash"], { encoding: "utf8", shell: true });
    env.gitBash = process.env.CLAUDE_CODE_GIT_BASH_PATH ?? (bash.status === 0 ? bash.stdout.trim() : null);
  }
  return env;
}

function freshWorkDir() {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  return WORK;
}

function baseOptions(extra = {}) {
  return {
    cwd: freshWorkDir(),
    ...(MODEL ? { model: MODEL } : {}),
    ...extra,
  };
}

/** Runs one query to completion, collecting the init frame, result, and every message type seen. */
async function run(prompt, options) {
  const out = { init: null, result: null, messageTypes: {}, authErrors: [] };
  const q = query({ prompt, options });
  const timer = setTimeout(() => q.close(), STEP_TIMEOUT_MS);
  try {
    for await (const msg of q) {
      const key = msg.subtype ? `${msg.type}/${msg.subtype}` : msg.type;
      out.messageTypes[key] = (out.messageTypes[key] ?? 0) + 1;
      if (msg.type === "system" && msg.subtype === "init") out.init = msg;
      if (msg.type === "auth_status" && msg.error) out.authErrors.push(msg.error);
      if (msg.type === "result") out.result = msg;
    }
  } finally {
    clearTimeout(timer);
  }
  return out;
}

function summarizeInit(init) {
  if (!init) return null;
  return {
    claudeCodeVersion: init.claude_code_version,
    apiKeySource: init.apiKeySource,
    model: init.model,
    permissionMode: init.permissionMode,
    toolCount: init.tools?.length,
    mcpServers: init.mcp_servers?.map((s) => `${s.name}:${s.status}`),
    plugins: init.plugins?.map((p) => p.name),
  };
}

function summarizeResult(result) {
  if (!result) return null;
  return {
    subtype: result.subtype,
    isError: result.is_error,
    text: typeof result.result === "string" ? result.result.slice(0, 300) : undefined,
    errors: result.errors,
    numTurns: result.num_turns,
    costUsd: result.total_cost_usd,
    sessionId: result.session_id,
    permissionDenials: result.permission_denials,
  };
}

async function step(n, name, why, fn) {
  if (ONLY && !ONLY.includes(n)) return undefined;
  process.stdout.write(`\n[${n}] ${name}\n    ${why}\n`);
  const entry = { n, name, why, pass: false };
  const t0 = Date.now();
  try {
    Object.assign(entry, await fn());
  } catch (err) {
    entry.pass = false;
    entry.exception = String(err?.stack ?? err);
  }
  entry.durationMs = Date.now() - t0;
  report.steps.push(entry);
  process.stdout.write(`    ${entry.pass ? "PASS" : entry.optional ? "SKIP/FAIL (optional)" : "FAIL"} in ${entry.durationMs} ms\n`);
  if (entry.note) process.stdout.write(`    note: ${entry.note}\n`);
  if (entry.exception) process.stdout.write(`    exception: ${entry.exception.split("\n")[0]}\n`);
  return entry;
}

/** A push-driven async iterable of user messages, so one session stays open across turns. */
function inputQueue() {
  const pending = [];
  let wake = null;
  let closed = false;
  return {
    push(text) {
      pending.push({
        type: "user",
        message: { role: "user", content: text },
        parent_tool_use_id: null,
        origin: { kind: "human" },
      });
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (pending.length) {
          yield pending.shift();
          continue;
        }
        if (closed) return;
        await new Promise((r) => (wake = r));
        wake = null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// steps

let firstSessionId;

await step(1, "Basic query with this machine's login", "Can the SDK authenticate at all? (PLAN §4.1 auth risk)", async () => {
  const r = await run("Reply with exactly the text LOOM_SMOKE_OK and nothing else.", baseOptions({ maxTurns: 1, tools: [] }));
  firstSessionId = r.result?.session_id;
  return {
    pass: Boolean(r.result && !r.result.is_error && r.result.result?.includes("LOOM_SMOKE_OK")),
    init: summarizeInit(r.init),
    result: summarizeResult(r.result),
    authErrors: r.authErrors,
    messageTypes: r.messageTypes,
    note: r.init ? `apiKeySource=${r.init.apiKeySource} (\"none\" means claude.ai login), model=${r.init.model}` : "no init frame",
  };
});

await step(2, "Permission prompt reaches canUseTool and can be allowed", "The Steward and approval cards depend on this callback (PLAN §5)", async () => {
  const seen = [];
  const r = await run(
    "Use the Write tool to create a file named loom-smoke.txt in the current directory containing the text ok. Then reply DONE.",
    baseOptions({
      permissionMode: "default",
      maxTurns: 4,
      canUseTool: async (toolName, input, opts) => {
        seen.push({ toolName, title: opts.title, decisionReason: opts.decisionReason, suggestions: opts.suggestions?.length ?? 0 });
        return { behavior: "allow", updatedInput: input };
      },
    }),
  );
  const created = existsSync(join(WORK, "loom-smoke.txt"));
  return {
    pass: seen.some((s) => s.toolName === "Write") && created,
    callbacks: seen,
    fileCreated: created,
    init: summarizeInit(r.init),
    result: summarizeResult(r.result),
  };
});

await step(3, "Permission prompt can be denied", "Deny rules and the human Deny button must actually block the tool", async () => {
  const seen = [];
  const r = await run(
    "Use the Write tool to create a file named loom-denied.txt in the current directory containing the text no. If you are not allowed, reply BLOCKED and stop.",
    baseOptions({
      permissionMode: "default",
      maxTurns: 3,
      canUseTool: async (toolName) => {
        seen.push({ toolName });
        return { behavior: "deny", message: "Denied by Loom smoke test." };
      },
    }),
  );
  const created = existsSync(join(WORK, "loom-denied.txt"));
  return {
    pass: seen.length > 0 && !created,
    callbacks: seen,
    fileCreated: created,
    result: summarizeResult(r.result),
  };
});

await step(4, "Shell command approval", "Bash (Linux/WSL) or PowerShell (Windows) approvals are the main thing blocked at work", async () => {
  const seen = [];
  const cmd = `node -e "require('fs').writeFileSync('loom-shell.txt','ok')"`;
  const r = await run(
    `Run this exact shell command in the current directory using your shell tool: ${cmd}\nThen reply DONE.`,
    baseOptions({
      permissionMode: "default",
      maxTurns: 4,
      canUseTool: async (toolName, input, opts) => {
        seen.push({ toolName, command: input.command, title: opts.title });
        return { behavior: "allow", updatedInput: input };
      },
    }),
  );
  const created = existsSync(join(WORK, "loom-shell.txt"));
  return {
    pass: seen.some((s) => /bash|powershell/i.test(s.toolName)) && created,
    callbacks: seen,
    fileCreated: created,
    result: summarizeResult(r.result),
  };
});

await step(5, "AskUserQuestion reaches canUseTool and can be answered", "The Steward and Cockpit answer clarifying questions (PLAN §5, §6)", async () => {
  const seen = [];
  const r = await run(
    "Before anything else, use the AskUserQuestion tool to ask me whether I prefer Red or Blue, with exactly those two options. After you get my answer, reply with only the color I chose, in uppercase.",
    baseOptions({
      maxTurns: 4,
      canUseTool: async (toolName, input) => {
        seen.push({ toolName });
        if (toolName === "AskUserQuestion") {
          const answers = {};
          for (const q of input.questions ?? []) {
            const blue = q.options?.find((o) => /blue/i.test(o.label));
            answers[q.question] = blue?.label ?? q.options?.[0]?.label ?? "Blue";
          }
          return { behavior: "allow", updatedInput: { questions: input.questions, answers } };
        }
        return { behavior: "deny", message: "Only AskUserQuestion is allowed in this step." };
      },
    }),
  );
  const asked = seen.some((s) => s.toolName === "AskUserQuestion");
  return {
    optional: true,
    pass: asked && /BLUE/.test(r.result?.result ?? ""),
    callbacks: seen,
    result: summarizeResult(r.result),
    note: asked ? undefined : "model did not call AskUserQuestion; not a blocker, the callback path is proven by step 2",
  };
});

await step(6, "Resume a session by id", "Hub restarts and 'open as terminal' both resume sessions (PLAN §4.1)", async () => {
  if (!firstSessionId) return { pass: false, note: "step 1 produced no session id" };
  const r = await run(
    "What exact token did you reply with in your previous message? Reply with only that token.",
    baseOptions({ resume: firstSessionId, maxTurns: 1, tools: [] }),
  );
  return {
    pass: Boolean(r.result?.result?.includes("LOOM_SMOKE_OK")),
    resumedFrom: firstSessionId,
    result: summarizeResult(r.result),
    note: "a failure here can also mean the cwd changed between steps; the hub will pin cwd per session",
  };
});

await step(7, "One long-lived session across two turns (streaming input)", "The hub keeps every session open this way (PLAN §3.1)", async () => {
  const input = inputQueue();
  const q = query({ prompt: input, options: baseOptions({ tools: [] }) });
  const timer = setTimeout(() => q.close(), STEP_TIMEOUT_MS);
  const results = [];
  input.push("Remember the number 4217. Reply with only OK.");
  try {
    for await (const msg of q) {
      if (msg.type !== "result") continue;
      results.push(summarizeResult(msg));
      if (results.length === 1) input.push("What number did I ask you to remember? Reply with only the number.");
      else input.close();
    }
  } finally {
    clearTimeout(timer);
  }
  return {
    pass: results.length === 2 && Boolean(results[1]?.text?.includes("4217")),
    turns: results,
  };
});

await step(8, "Change permission mode on a live session", "Per-session levels change at runtime (PLAN §5 table)", async () => {
  const input = inputQueue();
  const q = query({ prompt: input, options: baseOptions({ tools: [], permissionMode: "default" }) });
  const timer = setTimeout(() => q.close(), STEP_TIMEOUT_MS);
  const outcome = {};
  input.push("Reply with only OK.");
  try {
    for await (const msg of q) {
      if (msg.type !== "result") continue;
      for (const mode of ["acceptEdits", "plan", "default"]) {
        try {
          await q.setPermissionMode(mode);
          outcome[mode] = "ok";
        } catch (err) {
          outcome[mode] = `error: ${String(err?.message ?? err)}`;
        }
      }
      input.close();
    }
  } finally {
    clearTimeout(timer);
  }
  return {
    pass: Object.values(outcome).length === 3 && Object.values(outcome).every((v) => v === "ok"),
    setPermissionMode: outcome,
  };
});

// ---------------------------------------------------------------------------
// report

rmSync(WORK, { recursive: true, force: true });
report.finishedAt = new Date().toISOString();
const required = report.steps.filter((s) => !s.optional);
report.verdict = required.length && required.every((s) => s.pass) ? "PASS" : "FAIL";
report.totalCostUsd = report.steps.reduce(
  (sum, s) => sum + (s.result?.costUsd ?? 0) + (s.turns?.reduce((a, t) => a + (t?.costUsd ?? 0), 0) ?? 0),
  0,
);
const file = join(HERE, "smoke-report.json");
writeFileSync(file, JSON.stringify(report, null, 2));
process.stdout.write(`\nVerdict: ${report.verdict}\nReport written to ${file}\n`);
process.exit(report.verdict === "PASS" ? 0 : 1);
