import type { PolicyFile } from "@loom/protocol";
import { describe, expect, it } from "vitest";
import { analyzeCommand, commandPatternMatches, denyVariants } from "../src/policy/command.ts";
import { domainMatches } from "../src/policy/domain.ts";
import { evaluate, policyProblems, suggestRule, type PolicySource } from "../src/policy/evaluate.ts";
import { type MatchContext, ruleMatches, type ToolCall } from "../src/policy/match.ts";
import { pathPatternMatches, toPosix } from "../src/policy/paths.ts";
import { parseRule } from "../src/policy/rules.ts";

const ctx: MatchContext = { cwd: "/home/kim/repo", home: "/home/kim", sourceAnchor: "/home/kim/repo", platform: "linux", realpath: () => undefined };

function matches(rule: string, list: "allow" | "deny" | "ask", call: ToolCall, c: MatchContext = ctx): boolean {
  const parsed = parseRule(rule, list);
  if (!parsed.ok) throw new Error(`${rule}: ${parsed.message}`);
  return ruleMatches(parsed.rule, list, call, c);
}
const bash = (command: string): ToolCall => ({ toolName: "Bash", input: { command } });

describe("parseRule", () => {
  it.each([
    ["Bash", "tool"],
    ["Bash(*)", "tool"],
    ["Bash(npm run *)", "command"],
    ["Bash(ls:*)", "command"],
    ["Read(./.env)", "path"],
    ["Edit(/src/**/*.ts)", "path"],
    ["WebFetch(domain:example.com)", "domain"],
    ["mcp__puppeteer", "tool"],
    ["mcp__puppeteer__*", "tool"],
  ])("%s parses as %s", (rule, kind) => {
    const p = parseRule(rule, "allow");
    expect(p.ok && p.rule.kind).toBe(kind);
  });

  it("allows parameter rules and bare tool globs only for deny and ask", () => {
    expect(parseRule("Bash(run_in_background:true)", "deny")).toMatchObject({ ok: true, rule: { kind: "param", param: "run_in_background" } });
    expect(parseRule("Bash(run_in_background:true)", "allow").ok).toBe(false);
    expect(parseRule("mcp__*", "deny").ok).toBe(true);
    expect(parseRule("mcp__*", "allow").ok).toBe(false);
    expect(parseRule("*", "allow").ok).toBe(false);
  });

  it.each([
    ["Bash(command:rm *)", "deny", /main input/],
    ["Write(docs/**)", "allow", /never consulted; use Edit/],
    ["Glob(src/**)", "deny", /use Read/],
    ["mcp__github__get(x)", "deny", /cannot have a specifier/],
    ["Bash(", "deny", /must end with/],
    ["Not a tool", "deny", /not a tool name/],
  ])("rejects %s", (rule, list, message) => {
    const p = parseRule(rule, list as "allow" | "deny");
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.message).toMatch(message);
  });

  it("reports problems per list", () => {
    const policy: PolicyFile = { allow: ["Bash(npm test)", "Bash(x:1)"], deny: ["Write(a)"], ask: [] };
    expect(policyProblems(policy).map((p) => [p.list, p.rule])).toEqual([
      ["deny", "Write(a)"],
      ["allow", "Bash(x:1)"],
    ]);
  });
});

describe("Bash wildcard patterns (Claude Code documentation table)", () => {
  it.each([
    ["npm run build", "npm run build", true],
    ["npm run build", "npm run build --watch", false],
    ["npm run *", "npm run build", true],
    ["npm run *", "npm run test --watch", true],
    ["npm run *", "npm run", true],
    ["npm run *", "npm install", false],
    ["git log * main", "git log --oneline main", true],
    ["git log * main", "git log main", false],
    ["git log * main", "git push origin main", false],
    ["git * main", "git merge main", true],
    ["git * main", "git log", false],
    ["* --version", "node --version", true],
    ["* --version", "node -v", false],
    ["ls *", "ls -la", true],
    ["ls *", "ls", true],
    ["ls *", "lsof", false],
    ["ls*", "lsof", true],
    ["* --help *", "npm --help x", true],
    ["* --help *", "npm --help", false],
    ["ls:*", "ls -la", true],
    ["ls:*", "lsof", false],
  ])("%s vs %s", (pattern, command, expected) => {
    expect(commandPatternMatches(pattern, command)).toBe(expected);
  });
});

describe("compound commands", () => {
  it("requires every subcommand to match an allow rule", () => {
    expect(matches("Bash(safe-cmd *)", "allow", bash("safe-cmd && other-cmd"))).toBe(false);
    expect(matches("Bash(npm *)", "allow", bash("npm ci && npm test"))).toBe(true);
    expect(matches("Bash(npm *)", "allow", bash("npm test | tee out"))).toBe(false);
  });

  it("applies deny and ask rules to any subcommand, including nested ones", () => {
    expect(matches("Bash(git clean *)", "ask", bash("cd /tmp && git clean -f"))).toBe(true);
    expect(matches("Bash(git clean *)", "ask", bash('echo "$(git clean -f)"'))).toBe(true);
    expect(matches("Bash(rm *)", "deny", bash("for f in a; do (rm -rf $f); done"))).toBe(true);
    expect(matches("Bash(rm *)", "deny", bash("echo `rm -rf x`"))).toBe(true);
  });

  it("does not allow a command with a dangling operator, a substitution, or a file redirect", () => {
    expect(matches("Bash(npm *)", "allow", bash("npm test &&"))).toBe(false);
    expect(matches("Bash(echo *)", "allow", bash("echo $(whoami)"))).toBe(false);
    expect(matches("Bash(echo *)", "allow", bash("echo hi > ~/.bashrc"))).toBe(false);
    expect(matches("Bash(npm test *)", "allow", bash("npm test 2>&1"))).toBe(true);
    expect(matches("Bash(npm test *)", "allow", bash("npm test > /dev/null"))).toBe(true);
  });

  it("treats separators inside quotes as text", () => {
    expect(analyzeCommand("echo 'a && b' ; ls").subcommands).toEqual(["echo 'a && b'", "ls"]);
    expect(analyzeCommand('grep "x|y" file').subcommands).toEqual(['grep "x|y" file']);
  });

  it("splits on every documented separator", () => {
    expect(analyzeCommand("a && b || c ; d | e |& f & g\nh").subcommands).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
  });
});

describe("wrappers and environment assignments", () => {
  it("deny and ask see through wrappers and any assignment", () => {
    expect(matches("Bash(rm *)", "deny", bash("FOO=bar rm -rf tmp/"))).toBe(true);
    expect(matches("Bash(npm test *)", "deny", bash("timeout 30 npm test"))).toBe(true);
    expect(matches("Bash(git push *)", "ask", bash("nohup nice -n 5 git push origin main"))).toBe(true);
    expect(denyVariants("command -v git")).toEqual(["command -v git"]);
  });

  it("allow does not see through them", () => {
    expect(matches("Bash(npm test *)", "allow", bash("FOO=1 npm test"))).toBe(false);
  });

  it("does not claim to stop other spellings of a program", () => {
    expect(matches("Bash(rm *)", "deny", bash("/bin/rm -rf build/"))).toBe(false);
  });
});

describe("Read and Edit path patterns", () => {
  const read = (file_path: string): ToolCall => ({ toolName: "Read", input: { file_path } });
  const edit = (file_path: string): ToolCall => ({ toolName: "Edit", input: { file_path } });

  it("anchors //, ~/, /, and relative patterns", () => {
    expect(matches("Read(//etc/**)", "deny", read("/etc/hosts"))).toBe(true);
    expect(matches("Read(~/.zshrc)", "deny", read("/home/kim/.zshrc"))).toBe(true);
    expect(matches("Edit(/docs/**)", "allow", edit("/home/kim/repo/docs/a.md"))).toBe(true);
    expect(matches("Edit(/docs/**)", "allow", edit("/docs/a.md"))).toBe(false);
    expect(matches("Read(./.env)", "deny", read("/home/kim/repo/.env"))).toBe(true);
  });

  it("matches bare names at any depth under the anchor, and nothing outside it", () => {
    expect(matches("Read(.env)", "deny", read("/home/kim/repo/services/api/.env"))).toBe(true);
    expect(matches("Read(.env)", "deny", read("/home/kim/.env"))).toBe(false);
    expect(matches("Read(//**/.env)", "deny", read("/home/kim/.env"))).toBe(true);
  });

  it("treats a single directory segment differently for allow and deny (documentation table)", () => {
    const app = "/home/kim/repo/src/app.ts";
    const lib = "/home/kim/repo/vendor/pkg/src/lib.js";
    expect([matches("Edit(src/**)", "allow", edit(app)), matches("Edit(src/**)", "allow", edit(lib))]).toEqual([true, false]);
    expect([matches("Edit(src/**)", "deny", edit(app)), matches("Edit(src/**)", "deny", edit(lib))]).toEqual([true, true]);
    expect([matches("Edit(/src/**)", "deny", edit(app)), matches("Edit(/src/**)", "deny", edit(lib))]).toEqual([true, false]);
    expect([matches("Edit(**/src/**)", "allow", edit(app)), matches("Edit(**/src/**)", "allow", edit(lib))]).toEqual([true, true]);
  });

  it("covers every editing tool with Edit rules, and edits with Read deny rules", () => {
    expect(matches("Edit(./notes.md)", "allow", { toolName: "Write", input: { file_path: "/home/kim/repo/notes.md" } })).toBe(true);
    expect(matches("Read(./.env)", "deny", { toolName: "Write", input: { file_path: "/home/kim/repo/.env" } })).toBe(true);
    expect(matches("Read(./.env)", "allow", { toolName: "Write", input: { file_path: "/home/kim/repo/.env" } })).toBe(false);
  });

  it("applies Read deny rules to Grep and Glob, including the directory itself", () => {
    expect(matches("Read(secrets/**)", "deny", { toolName: "Grep", input: { pattern: "x", path: "/home/kim/repo/a/secrets" } })).toBe(true);
    expect(matches("Read(./**)", "allow", { toolName: "Grep", input: { pattern: "x" } })).toBe(false);
  });

  it("checks symlink targets for deny", () => {
    const c = { ...ctx, realpath: (p: string) => (p === "/home/kim/repo/key" ? "/home/kim/.ssh/id_rsa" : undefined) };
    expect(matches("Read(~/.ssh/**)", "deny", read("/home/kim/repo/key"), c)).toBe(true);
  });

  it("supports character classes and escapes", () => {
    expect(pathPatternMatches("./logs/app-[0-9].log", "/home/kim/repo/logs/app-3.log", ctx, true)).toBe(true);
    expect(pathPatternMatches("./\\[2024\\] Reports/**", "/home/kim/repo/[2024] Reports/q1.pdf", ctx, true)).toBe(true);
  });

  it("normalizes Windows paths to POSIX form", () => {
    expect(toPosix("C:\\Users\\alice\\repo\\.env", "win32")).toBe("/c/Users/alice/repo/.env");
    const win: MatchContext = { cwd: "C:\\Users\\alice\\repo", home: "C:\\Users\\alice", sourceAnchor: "C:\\Users\\alice\\repo", platform: "win32", realpath: () => undefined };
    expect(matches("Read(//c/**/.env)", "deny", read("C:\\Users\\alice\\repo\\.env"), win)).toBe(true);
    expect(matches("Edit(./src/**)", "allow", edit("C:\\Users\\alice\\repo\\SRC\\a.ts"), win)).toBe(true);
  });
});

describe("WebFetch domains", () => {
  it.each([
    ["example.com", "https://example.com/x", true],
    ["example.com", "https://EXAMPLE.com./x", true],
    ["*.example.com", "https://api.example.com", true],
    ["*.example.com", "https://a.b.example.com", true],
    ["*.example.com", "https://example.com", false],
    ["example.*", "https://example.org", true],
    ["example.*", "https://example.evil.com", false],
    ["*", "https://anything.test", true],
  ])("%s vs %s", (pattern, url, expected) => {
    expect(domainMatches(pattern, url)).toBe(expected);
  });
});

describe("MCP and tool names", () => {
  const mcp = (toolName: string): ToolCall => ({ toolName, input: {} });
  it("matches servers, tools, and globs", () => {
    expect(matches("mcp__puppeteer", "allow", mcp("mcp__puppeteer__puppeteer_navigate"))).toBe(true);
    expect(matches("mcp__puppeteer__*", "allow", mcp("mcp__puppeteer__x"))).toBe(true);
    expect(matches("mcp__github__get_*", "allow", mcp("mcp__github__create_issue"))).toBe(false);
    expect(matches("mcp__*", "deny", mcp("mcp__anything__x"))).toBe(true);
    expect(matches("mcp__pup", "allow", mcp("mcp__puppeteer__x"))).toBe(false);
  });

  it("matches parameter rules on scalar inputs only", () => {
    expect(matches("Agent(model:opus)", "deny", { toolName: "Agent", input: { model: "opus" } })).toBe(true);
    expect(matches("Agent(isolation:*)", "deny", { toolName: "Agent", input: {} })).toBe(false);
    expect(matches("Agent(Explore)", "ask", { toolName: "Agent", input: { subagent_type: "Explore" } })).toBe(true);
  });
});

describe("evaluate", () => {
  const hub: PolicySource = { scope: "hub", path: "/cfg/policy.json", anchor: "/cfg", allowTrusted: true, policy: { allow: ["Bash(git *)"], deny: [], ask: ["Bash(git push *)"] } };
  const project = (allowTrusted: boolean): PolicySource => ({
    scope: "project",
    path: "/home/kim/repo/.loom/policy.json",
    anchor: "/home/kim/repo",
    allowTrusted,
    policy: { allow: ["Bash(npm test)", "Bash(rm -rf build)"], deny: ["Bash(rm *)"], ask: [] },
  });

  it("puts deny before ask before allow, across sources", () => {
    expect(evaluate(bash("rm -rf build"), [hub, project(true)], ctx)).toMatchObject({ kind: "deny", rule: { rule: "Bash(rm *)", scope: "project" } });
    expect(evaluate(bash("git push origin main"), [hub, project(true)], ctx)).toMatchObject({ kind: "ask", rule: { rule: "Bash(git push *)", scope: "hub" } });
    expect(evaluate(bash("git status"), [hub, project(true)], ctx)).toMatchObject({ kind: "allow", rule: { scope: "hub" } });
    expect(evaluate(bash("make"), [hub, project(true)], ctx)).toEqual({ kind: "none" });
  });

  it("ignores allow rules from an untrusted project but still applies its deny rules", () => {
    expect(evaluate(bash("npm test"), [hub, project(false)], ctx)).toEqual({ kind: "none" });
    expect(evaluate(bash("rm x"), [hub, project(false)], ctx)).toMatchObject({ kind: "deny" });
  });

  it("skips invalid rules instead of failing", () => {
    const broken: PolicySource = { ...hub, policy: { allow: ["Bash(command:ls)", "Write(x)"], deny: ["("], ask: [] } };
    expect(evaluate(bash("ls"), [broken], ctx)).toEqual({ kind: "none" });
  });
});

describe("suggestRule", () => {
  it("proposes narrow rules", () => {
    expect(suggestRule(bash("npm run lint"), ctx.cwd)).toBe("Bash(npm run lint)");
    expect(suggestRule(bash("a\nb"), ctx.cwd)).toBeUndefined();
    expect(suggestRule({ toolName: "Write", input: { file_path: "/home/kim/repo/src/[id].ts" } }, ctx.cwd)).toBe("Edit(./src/\\[id\\].ts)");
    expect(suggestRule({ toolName: "Edit", input: { file_path: "/etc/hosts" } }, ctx.cwd)).toBe("Edit(//etc/hosts)");
    expect(suggestRule({ toolName: "WebFetch", input: { url: "https://docs.rs/x" } }, ctx.cwd)).toBe("WebFetch(domain:docs.rs)");
    expect(suggestRule({ toolName: "Agent", input: {} }, ctx.cwd)).toBeUndefined();
  });

  it("suggested rules match the call they came from", () => {
    const calls: ToolCall[] = [bash("npm run lint"), { toolName: "Write", input: { file_path: "/home/kim/repo/src/[id].ts" } }, { toolName: "WebFetch", input: { url: "https://docs.rs/x" } }];
    for (const call of calls) {
      const rule = suggestRule(call, ctx.cwd)!;
      expect(matches(rule, "allow", call)).toBe(true);
    }
  });
});
