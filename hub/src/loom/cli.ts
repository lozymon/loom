#!/usr/bin/env node
import { runTunnel, type TunnelStatus } from "../remote/tunnel.ts";
import { HubClient } from "./hubClient.ts";
import { loomTools, runTool } from "./tools.ts";

/**
 * The `loom` command (ADR-0007): the same tools as the MCP server, for terminals and scripts.
 * Inside a Loom session it uses LOOM_HUB_URL and LOOM_SESSION_TOKEN. People can pass --hub and --token.
 */

const USAGE = `Usage: loom <command> [arguments]

  loom list                          sessions on this hub
  loom read <session> [limit]        what a session has been doing
  loom wait <session> [seconds]      wait until it is idle, blocked, done, or errored
  loom send <session> <text…>        message another session
  loom notes [key [value…]]          list, get, or set a shared note
  loom unnote <key>                  delete a note
  loom claim <path> [note…]          claim a file; fails if someone else holds it
  loom release <path>                release your claim
  loom claims                        list claims
  loom cards                         the project board
  loom card <title> [prompt…]        add a to-do card
  loom search <words…>               search what sessions said and did
  loom say <text…>                   say something out loud to the developer (also shown as text)
  loom whoami
  loom tools                         every tool available to you, by name
  loom <tool> --arg value …          call any tool directly

Options: --hub <url> --token <token> --project <path>

  loom tunnel <[user@]host> [--port 7420] [--local-port 17420] [--ssh-option Key=Value]
                                     reach a hub on another computer over SSH; keeps reconnecting
`;

function argvOptions(argv: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}` && argv[i + 1]) out.push(argv[++i]!);
    else if (argv[i]!.startsWith(`--${name}=`)) out.push(argv[i]!.slice(name.length + 3));
  }
  return out;
}

function port(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${label} must be a port number, got ${value}`);
  return n;
}

async function tunnel(target: string | undefined, flags: Record<string, string>): Promise<number> {
  if (!target) {
    process.stderr.write("loom tunnel: which computer? For example: loom tunnel me@work-pc\n");
    return 1;
  }
  const remotePort = port(flags.port, 7420, "--port");
  const localPort = port(flags["local-port"], remotePort + 10000, "--local-port");
  const abort = new AbortController();
  process.once("SIGINT", () => abort.abort());
  process.once("SIGTERM", () => abort.abort());
  const say = (line: string) => process.stdout.write(`loom tunnel: ${line}\n`);
  let announced = false;
  const onStatus = (s: TunnelStatus) => {
    if (s.kind === "connecting") say(s.attempt === 1 ? `connecting to ${target}…` : `reconnecting to ${target} (attempt ${s.attempt})…`);
    else if (s.kind === "up") {
      say(announced ? `hub reachable again at ${s.url}` : `hub reachable at ${s.url}. Add it in the Loom client with that address and the remote hub's token. Ctrl+C stops the tunnel.`);
      announced = true;
    }
    else if (s.kind === "no-hub") say(`${s.detail}.`);
    else if (s.kind === "down") say(`connection lost${s.code ? ` (ssh exit ${s.code})` : ""}; retrying in ${Math.round(s.retryInMs / 1000)}s`);
    else say(`ssh exited (${s.code ?? "could not start ssh"}) before the tunnel opened. Check that \`ssh ${target}\` works and that local port ${localPort} is free.`);
  };
  return runTunnel(
    { target, remotePort, localPort, sshOptions: argvOptions(process.argv.slice(2), "ssh-option"), ...(flags.ssh ? { ssh: flags.ssh } : {}) },
    { onStatus, signal: abort.signal },
  );
}

function parse(argv: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split("=", 2);
      flags[k!] = inline ?? (argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[++i]! : "true");
    } else positional.push(a);
  }
  return { positional, flags };
}

function coerce(v: string): unknown {
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+$/.test(v)) return Number(v);
  if (/^[[{]/.test(v)) {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
}

/**
 * Exit codes stay 0 or 1. Claude Code hooks treat exit code 2 as "block", and a user's Claude settings may
 * still run Loom v1's `loom hook …` commands, which reach this command inside v2 sessions.
 */
async function main(): Promise<number> {
  const { positional, flags } = parse(process.argv.slice(2));
  const [command, ...rest] = positional;
  if (command === "hook") {
    // Loom v1 hook (`loom hooks --install`). Inside a v2 session it has nowhere to go; do nothing, quickly.
    process.stdin.resume();
    process.stdin.on("error", () => undefined);
    return 0;
  }
  if (!command || command === "help" || flags.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (command === "tunnel") return tunnel(rest[0], flags);
  const url = flags.hub ?? process.env.LOOM_HUB_URL;
  const token = flags.token ?? process.env.LOOM_SESSION_TOKEN ?? process.env.LOOM_TOKEN;
  if (!url || !token) {
    process.stderr.write("loom: not inside a Loom session. Pass --hub and --token, or set LOOM_HUB_URL and LOOM_TOKEN.\n");
    return 1;
  }
  const hub = await HubClient.connect(url, token, "cli");
  try {
    const me = await hub.request({ cmd: "hub.whoami" });
    const caller =
      me.kind === "session"
        ? me
        : { sessionId: "human", name: "you", role: "cockpit" as const, cwd: process.cwd(), projectRoot: flags.project ?? process.cwd() };
    const tools = loomTools(caller);
    const project = flags.project ? { project: flags.project } : {};

    const call: Record<string, [string, Record<string, unknown>]> = {
      list: ["list_sessions", {}],
      read: ["read_session", { session: rest[0], ...(rest[1] ? { limit: Number(rest[1]) } : {}) }],
      wait: ["wait_for", { session: rest[0], ...(rest[1] ? { timeout_seconds: Number(rest[1]) } : {}) }],
      send: ["send_message", { session: rest[0], text: rest.slice(1).join(" ") }],
      notes: rest.length === 0 ? ["notes", { action: "list", ...project }] : rest.length === 1 ? ["notes", { action: "get", key: rest[0], ...project }] : ["notes", { action: "set", key: rest[0], value: rest.slice(1).join(" "), ...project }],
      unnote: ["notes", { action: "delete", key: rest[0], ...project }],
      claim: ["claims", { action: "claim", path: rest[0], ...(rest.length > 1 ? { note: rest.slice(1).join(" ") } : {}), ...project }],
      release: ["claims", { action: "release", path: rest[0], ...project }],
      claims: ["claims", { action: "list", ...project }],
      cards: ["board", { action: "list", ...project }],
      card: ["board", { action: "add", title: rest[0], prompt: rest.slice(1).join(" "), ...project }],
      whoami: ["whoami", {}],
      say: ["speak", { text: rest.join(" ") }],
      search: ["search_history", { query: rest.join(" ") }],
    };

    if (command === "tools") {
      process.stdout.write(`${tools.map((t) => `${t.name}: ${t.description}`).join("\n")}\n`);
      return 0;
    }
    const [name, args] = call[command] ?? [command, Object.fromEntries(Object.entries(flags).filter(([k]) => !["hub", "token"].includes(k)).map(([k, v]) => [k, coerce(v)]))];
    const tool = tools.find((t) => t.name === name);
    if (!tool) {
      process.stderr.write(`loom: unknown command ${command}. Run loom help.\n`);
      return 1;
    }
    const result = await runTool(tool, args, hub);
    (result.isError ? process.stderr : process.stdout).write(`${result.text}\n`);
    return result.isError ? 1 : 0;
  } finally {
    hub.close();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`loom: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
