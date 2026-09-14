import type { RuleListName } from "@loom/protocol";

/**
 * A parsed permission rule in Claude Code's syntax (ADR-0006). Loom implements a subset and errs
 * toward asking: forms it cannot judge safely are rejected with a problem message.
 */
export type ParsedRule =
  /** `Tool`, `Tool(*)`, or a tool-name glob such as `mcp__*`. */
  | { kind: "tool"; name: string; glob: boolean }
  /** `Bash(npm run *)`, `PowerShell(Get-ChildItem *)`. */
  | { kind: "command"; tool: "Bash" | "PowerShell"; pattern: string }
  /** `Read(./.env)`, `Edit(/src/**)`. */
  | { kind: "path"; tool: "Read" | "Edit"; pattern: string }
  /** `WebFetch(domain:example.com)`. */
  | { kind: "domain"; pattern: string }
  /** `Tool(param:value)`: deny and ask only. */
  | { kind: "param"; tool: string; param: string; value: string };

export type ParseResult = { ok: true; rule: ParsedRule } | { ok: false; message: string };

/** Fields a parameter rule may not name, because the tool's own specifier covers them safely. */
const PRIMARY_FIELDS: Record<string, string> = {
  Bash: "command",
  PowerShell: "command",
  Read: "file_path",
  Edit: "file_path",
  Write: "file_path",
  Grep: "path",
  Glob: "path",
  NotebookEdit: "notebook_path",
  WebFetch: "url",
};

const PATH_TOOLS_NOT_CONSULTED = new Set(["Write", "NotebookEdit", "Glob", "MultiEdit", "Grep"]);

const TOOL_NAME = /^[A-Za-z0-9_*-]+$/;
const PARAM = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*?)\s*$/s;

export function parseRule(text: string, list: RuleListName): ParseResult {
  const raw = text.trim();
  if (!raw) return { ok: false, message: "empty rule" };

  const open = raw.indexOf("(");
  let name: string;
  let spec: string | undefined;
  if (open === -1) {
    name = raw;
  } else {
    if (!raw.endsWith(")")) return { ok: false, message: "a specifier must end with )" };
    name = raw.slice(0, open).trim();
    spec = raw.slice(open + 1, -1);
  }

  if (!name || !TOOL_NAME.test(name)) return { ok: false, message: `"${name}" is not a tool name` };
  const glob = name.includes("*");

  if (glob) {
    if (spec !== undefined) return { ok: false, message: "a tool-name wildcard cannot have a specifier" };
    if (list === "allow" && !/^mcp__[^*]+__[^]*$/.test(name)) {
      return { ok: false, message: "allow rules accept a tool-name wildcard only after mcp__<server>__" };
    }
    return { ok: true, rule: { kind: "tool", name, glob: true } };
  }

  if (spec === undefined || spec.trim() === "" || spec.trim() === "*") {
    if (spec !== undefined && spec.trim() === "" ) return { ok: false, message: "empty specifier; use the bare tool name" };
    return { ok: true, rule: { kind: "tool", name, glob: false } };
  }

  if (name.startsWith("mcp__")) {
    return { ok: false, message: "MCP rules cannot have a specifier; use mcp__server or mcp__server__tool" };
  }

  if (name === "Bash" || name === "PowerShell") {
    const param = PARAM.exec(spec);
    // `ls:*` is the legacy trailing-wildcard form, not a parameter rule.
    const legacyPrefix = param && param[2] === "*" && !/\s/.test(spec);
    if (param && !legacyPrefix && !/\s/.test(param[1]!)) {
      return paramRule(name, param[1]!, param[2]!, list);
    }
    return { ok: true, rule: { kind: "command", tool: name, pattern: spec } };
  }

  if (name === "Read" || name === "Edit") {
    return { ok: true, rule: { kind: "path", tool: name, pattern: spec.trim() } };
  }

  if (name === "WebFetch") {
    const domain = /^\s*domain\s*:\s*(.+?)\s*$/.exec(spec);
    if (domain) return { ok: true, rule: { kind: "domain", pattern: domain[1]! } };
    const param = PARAM.exec(spec);
    if (param) return paramRule(name, param[1]!, param[2]!, list);
    return { ok: false, message: "WebFetch rules use WebFetch(domain:example.com)" };
  }

  if (PATH_TOOLS_NOT_CONSULTED.has(name) && !PARAM.test(spec)) {
    const use = name === "Glob" || name === "Grep" ? "Read" : "Edit";
    return { ok: false, message: `path rules for ${name} are never consulted; use ${use}(${spec})` };
  }

  if (name === "Agent" && !PARAM.test(spec)) {
    return paramRule("Agent", "subagent_type", spec.trim(), list);
  }

  const param = PARAM.exec(spec);
  if (param) return paramRule(name, param[1]!, param[2]!, list);
  return { ok: false, message: `${name} does not take a specifier here; use ${name} or ${name}(parameter:value)` };
}

function paramRule(tool: string, param: string, value: string, list: RuleListName): ParseResult {
  if (list === "allow") {
    return { ok: false, message: "allow rules cannot match by input parameter; use the tool's own specifier" };
  }
  if (PRIMARY_FIELDS[tool] === param) {
    return { ok: false, message: `${param} is ${tool}'s main input and cannot be matched as a parameter` };
  }
  if (value === "") return { ok: false, message: "empty parameter value" };
  return { ok: true, rule: { kind: "param", tool, param, value } };
}
