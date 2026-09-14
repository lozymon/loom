/**
 * Shell command analysis for Bash and PowerShell rules. Deliberately conservative: when Loom cannot
 * read a command with confidence, allow rules do not match it and deny and ask rules still do.
 */

export interface CommandAnalysis {
  /** Top-level subcommands split at &&, ||, ;, |, |&, &, and newlines. */
  subcommands: string[];
  /** Commands found inside $(...), `...`, <(...), >(...), and ( ... ) groups, split the same way. */
  nested: string[];
  /** False when the command could not be split with confidence (unbalanced quotes, dangling operators). */
  parsed: boolean;
  /** Anything that makes an allow rule unsafe to apply: substitutions, groups, heredocs, file redirects. */
  allowUnsafe: boolean;
}

const HARMLESS_REDIRECT = /(?:^|\s)(?:\d*>&\d+|\d*>&-|&?\d*>{1,2}\s*\/dev\/null)(?=\s|$)/g;

export function analyzeCommand(command: string): CommandAnalysis {
  const subcommands: string[] = [];
  const nested: string[] = [];
  let parsed = true;
  let allowUnsafe = false;

  let cur = "";
  let quote: "'" | '"' | null = null;
  let i = 0;
  const push = () => {
    subcommands.push(cur.trim());
    cur = "";
  };

  while (i < command.length) {
    const ch = command[i]!;
    const next = command[i + 1];

    if (quote === "'") {
      cur += ch;
      if (ch === "'") quote = null;
      i++;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      cur += ch + next;
      i += 2;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "$" && next === "(") {
        const end = matchParen(command, i + 1);
        if (end === -1) return { subcommands: [command.trim()], nested, parsed: false, allowUnsafe: true };
        nested.push(...analyzeCommand(command.slice(i + 2, end)).subcommands);
        allowUnsafe = true;
        cur += command.slice(i, end + 1);
        i = end + 1;
        continue;
      } else if (ch === "`") {
        const end = command.indexOf("`", i + 1);
        if (end === -1) return { subcommands: [command.trim()], nested, parsed: false, allowUnsafe: true };
        nested.push(...analyzeCommand(command.slice(i + 1, end)).subcommands);
        allowUnsafe = true;
        cur += command.slice(i, end + 1);
        i = end + 1;
        continue;
      }
      cur += ch;
      i++;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      i++;
      continue;
    }

    // Substitutions and groups outside quotes.
    if ((ch === "$" || ch === "<" || ch === ">") && next === "(") {
      const end = matchParen(command, i + 1);
      if (end === -1) return { subcommands: [command.trim()], nested, parsed: false, allowUnsafe: true };
      const inner = analyzeCommand(command.slice(i + 2, end));
      nested.push(...inner.subcommands, ...inner.nested);
      allowUnsafe = true;
      cur += command.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (ch === "`") {
      const end = command.indexOf("`", i + 1);
      if (end === -1) return { subcommands: [command.trim()], nested, parsed: false, allowUnsafe: true };
      const inner = analyzeCommand(command.slice(i + 1, end));
      nested.push(...inner.subcommands, ...inner.nested);
      allowUnsafe = true;
      cur += command.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (ch === "(") {
      const end = matchParen(command, i);
      if (end === -1) return { subcommands: [command.trim()], nested, parsed: false, allowUnsafe: true };
      const inner = analyzeCommand(command.slice(i + 1, end));
      nested.push(...inner.subcommands, ...inner.nested);
      allowUnsafe = true;
      cur += command.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (ch === "{" || ch === "}") allowUnsafe = true;

    // Separators.
    if ((ch === "&" && next === "&") || (ch === "|" && next === "|") || (ch === "|" && next === "&")) {
      push();
      i += 2;
      continue;
    }
    if (ch === "&" && (next === ">" || command[i - 1] === ">")) {
      cur += ch;
      i++;
      continue;
    }
    if (ch === "|" || ch === ";" || ch === "&" || ch === "\n") {
      push();
      i++;
      continue;
    }
    if (ch === "<" && next === "<") allowUnsafe = true;

    cur += ch;
    i++;
  }

  if (quote) parsed = false;
  subcommands.push(cur.trim());

  // A dangling operator (`npm test &&`) or an empty part makes the command unparseable for allow.
  const empties = subcommands.filter((s) => s === "");
  if (empties.length > 0) {
    const trailingBackground = subcommands.length > 1 && subcommands[subcommands.length - 1] === "" && /(?:^|[^&])&\s*$/.test(command);
    if (!(trailingBackground && empties.length === 1)) parsed = false;
  }
  const parts = subcommands.filter((s) => s !== "");

  for (const part of parts) {
    const withoutHarmless = part.replace(HARMLESS_REDIRECT, " ");
    if (/[<>]/.test(stripQuoted(withoutHarmless))) allowUnsafe = true;
  }

  return { subcommands: parts, nested, parsed, allowUnsafe: allowUnsafe || !parsed };
}

function stripQuoted(s: string): string {
  return s.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, "");
}

/** Index of the parenthesis closing the one at `open`, honoring quotes. -1 if unbalanced. */
function matchParen(s: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < s.length; i++) {
    const ch = s[i]!;
    if (quote) {
      if (ch === "\\" && quote === '"') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const WRAPPERS = new Set(["timeout", "time", "nice", "nohup", "stdbuf", "command", "builtin", "noglob", "xargs"]);
const OPTION_WITH_VALUE: Record<string, RegExp> = {
  timeout: /^-(?:s|k|-signal|-kill-after)$/,
  nice: /^-(?:n|-adjustment)$/,
  stdbuf: /^-(?:i|o|e)$/,
};

/** Splits on whitespace outside quotes, keeping quotes in the words. */
function words(s: string): string[] {
  return s.match(/(?:[^\s'"]+|'[^']*'|"(?:\\.|[^"\\])*")+/g) ?? [];
}

/**
 * Forms of a subcommand a deny or ask rule should also see: leading environment assignments removed
 * and wrappers such as `timeout 30` or `nohup` stripped, repeatedly.
 */
export function denyVariants(sub: string): string[] {
  const out = new Set<string>([sub]);
  let w = words(sub);
  for (let guard = 0; guard < 10 && w.length > 0; guard++) {
    let changed = false;
    while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]!)) {
      w = w.slice(1);
      changed = true;
    }
    const head = w[0];
    if (head && WRAPPERS.has(head) && !(head === "command" && w[1] === "-v")) {
      w = w.slice(1);
      while (w.length && w[0]!.startsWith("-")) {
        const opt = w[0]!;
        w = w.slice(1);
        if (OPTION_WITH_VALUE[head]?.test(opt) && w.length) w = w.slice(1);
      }
      if (head === "timeout" && w.length && /^\d/.test(w[0]!)) w = w.slice(1);
      changed = true;
    }
    if (!changed) break;
    if (w.length) out.add(w.join(" "));
  }
  return [...out];
}

/** Claude Code's command pattern: `*` is any text; a lone trailing ` *` (or `:*`) also matches the bare command. */
export function commandPatternMatches(pattern: string, command: string, caseInsensitive = false): boolean {
  let p = pattern.trim();
  if (p.endsWith(":*") && !p.slice(0, -2).includes("*")) p = `${p.slice(0, -2)} *`;
  const cmd = command.trim();
  const stars = (p.match(/\*/g) ?? []).length;
  const flags = caseInsensitive ? "is" : "s";
  const re = new RegExp(`^${p.split("*").map(escapeRegex).join(".*")}$`, flags);
  if (re.test(cmd)) return true;
  if (stars === 1 && p.endsWith(" *")) {
    const bare = p.slice(0, -2);
    return caseInsensitive ? bare.toLowerCase() === cmd.toLowerCase() : bare === cmd;
  }
  return false;
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
