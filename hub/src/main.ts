#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { claudeSdkFactory } from "./adapters/claude-sdk/claudeSdkAdapter.ts";
import { ptyFactory } from "./adapters/pty/ptyAdapter.ts";
import { locatePtySidecar, terminalBaseEnv } from "./pty/locate.ts";
import { SidecarProvider } from "./pty/sidecar.ts";
import { PolicyStore } from "./policy/store.ts";
import { BoardService } from "./board/boardService.ts";
import { ClaudeStewardModel } from "./steward/claudeModel.ts";
import { Steward } from "./steward/steward.ts";
import { installLoomShim, loomIntegration } from "./loom/integration.ts";
import { BindError, planBind } from "./remote/network.ts";
import { locateVoceSidecar, VoiceService } from "./voice/voiceService.ts";
import { PushService } from "./push/pushService.ts";
import { ApprovalNotifier } from "./push/approvalNotifier.ts";
import { RelayCertificates } from "./relay/certificates.ts";
import { loadManifests } from "./heuristics/manifest.ts";
import { RelayClient, type RelayStatus } from "./relay/relayClient.ts";
import { isLoopback } from "./remote/network.ts";
import { hashToken, loadOrCreateAuth } from "./auth.ts";
import { resolveOnPath } from "./adapters/pty/launch.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { SessionManager } from "./core/sessionManager.ts";
import { EventLog } from "./log/eventLog.ts";
import { resolvePaths } from "./paths.ts";
import { startHubServer } from "./server/wsServer.ts";
import { HUB_VERSION } from "./version.ts";

const USAGE = `Usage: loom-hub [options]

  --home <dir>    keep config and data in <dir> instead of the platform locations
  --port <n>      listen on this port instead of hub.json's
  --new-token     create a new access token and print it (old token stops working)
  --help          show this help
`;

/** The built client: LOOM_CLIENT_DIR, the repo's build in development, or `client/` next to the bundled hub. */
function clientDir(): string {
  const candidates = [process.env.LOOM_CLIENT_DIR, fileURLToPath(new URL("../../client/dist/", import.meta.url)), fileURLToPath(new URL("../client/", import.meta.url))];
  const found = candidates.find((dir) => dir && existsSync(path.join(dir, "index.html")));
  return found ?? candidates[1]!;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      home: { type: "string" },
      port: { type: "string" },
      "new-token": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }

  const paths = resolvePaths({ home: values.home });
  const { config, created } = loadConfig(paths);
  const auth = loadOrCreateAuth(paths.authFile, { rotate: values["new-token"] });
  const port = values.port !== undefined ? Number(values.port) : config.port;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigError(`invalid --port ${values.port}`);

  // Set by the desktop app that started this hub (M9). Taken out of the environment before any session starts.
  const desktopToken = process.env.LOOM_DESKTOP_TOKEN;
  delete process.env.LOOM_DESKTOP_TOKEN;
  const exitWithStdin = process.env.LOOM_EXIT_WITH_STDIN === "1";
  delete process.env.LOOM_EXIT_WITH_STDIN;
  // A packaged hub has no node_modules for the Agent SDK to find its `claude` binary in.
  const claudeExecutable = process.env.LOOM_CLAUDE_EXECUTABLE || undefined;
  const claudeProgram =
    claudeExecutable && !resolveOnPath("claude", { platform: process.platform, env: process.env as Record<string, string> }) ? claudeExecutable : undefined;

  let tls: { cert: Buffer; key: Buffer } | undefined;
  if (config.tls) {
    try {
      tls = { cert: readFileSync(config.tls.cert), key: readFileSync(config.tls.key) };
    } catch (err) {
      throw new ConfigError(`cannot read the TLS certificate or key: ${(err as Error).message}`);
    }
  }
  const bind = await planBind(config.bind, { allowUnencryptedNetwork: config.allowUnencryptedNetwork, tls: tls !== undefined });
  const log = new EventLog(paths.dbFile, config.id);
  const sidecarBinary = locatePtySidecar();
  const sidecars = new SidecarProvider(() => sidecarBinary, () => terminalBaseEnv());
  // Hooks must reach the hub from the same machine, so they use loopback unless the hub is bound to one address.
  let localUrl = "";
  const steward = new Steward({ ...config.steward, enabled: config.stewardModel }, new ClaudeStewardModel({ workDir: path.join(paths.dataDir, "steward"), claudeExecutable }));
  let boards: BoardService | undefined;
  const binDir = path.join(paths.dataDir, "bin");
  installLoomShim(binDir);
  const manifestsDir = path.join(paths.configDir, "manifests");
  const screens = loadManifests(manifestsDir, config.heuristics.enabled);
  let managerRef: SessionManager | undefined;
  const manager = new SessionManager({
    log,
    defaultLevel: config.defaultLevel,
    maxLevel: config.maxLevel,
    dataDir: paths.dataDir,
    steward,
    cockpitDir: path.join(paths.dataDir, "cockpit"),
    manifests: screens.manifests,
    integration: loomIntegration({ manager: () => managerRef!, boards: () => boards, hubUrl: () => localUrl, binDir }),
    cardFor: (s) => {
      if (!s.cardId || !boards) return undefined;
      const card = boards.view(s.projectRoot).cards.find((c) => c.id === s.cardId);
      return card ? { title: card.title, prompt: card.prompt } : undefined;
    },
    policy: new PolicyStore({ hubFile: path.join(paths.configDir, "policy.json"), trustFile: path.join(paths.dataDir, "trust.json") }),
    adapters: {
      "claude-sdk": claudeSdkFactory(claudeExecutable ? { sdkOptions: { pathToClaudeCodeExecutable: claudeExecutable } } : {}),
      pty: ptyFactory({
        sidecar: () => sidecars.get(),
        hookUrl: (id) => `${localUrl}/hooks/${encodeURIComponent(id)}`,
        hubUrl: () => localUrl,
        sessionDir: (id) => path.join(paths.dataDir, "sessions", id),
        ...(claudeProgram ? { claudeProgram } : {}),
      }),
    },
  });
  managerRef = manager;
  manager.init();
  boards = new BoardService({ manager });
  const push = config.push.enabled ? new PushService({ file: path.join(paths.dataDir, "push.json"), subject: config.push.subject }) : undefined;
  const notifier = push
    ? new ApprovalNotifier({
        subscribe: (l) => manager.subscribe(l),
        pending: (id) => manager.approvals().find((a) => a.id === id),
        sessionName: (id) => manager.get(id).name,
        send: (payload) => push.send(payload),
        delayMs: config.push.delaySeconds * 1000,
      })
    : undefined;
  const voice = new VoiceService(config.voice, { dataDir: paths.dataDir, voceBinary: locateVoceSidecar() });

  const relayHostname = config.relay ? `${config.relay.name}.${new URL(config.relay.url).hostname}` : undefined;
  const logLine = (line: string) => process.stdout.write(`${new Date().toISOString()} ${line}\n`);
  const certificates =
    config.relay && relayHostname
      ? new RelayCertificates({
          hostname: relayHostname,
          dir: path.join(paths.dataDir, "relay"),
          source: config.relay.certificate === "acme" ? { acme: config.relay.acme } : { files: config.relay.certificate },
          log: logLine,
        })
      : undefined;

  const server = await startHubServer({
    ...(certificates ? { relay: { context: () => certificates.context(), challenge: (t: string) => certificates.challenge(t) } } : {}),
    manager,
    boards,
    voice,
    ...(push ? { push } : {}),
    ...(tls ? { tls: { ...tls, hosts: bind.hosts.filter((h) => !isLoopback(h)) } } : {}),
    hub: {
      id: config.id,
      name: config.name,
      version: HUB_VERSION,
      platform: process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux",
      maxLevel: config.maxLevel,
      defaultLevel: manager.defaultLevel,
      stewardModel: config.stewardModel,
      ...(config.stewardModel ? { steward: { mode: config.steward.mode, model: config.steward.model } } : {}),
      voice: voice.info,
    },
    tokenHash: auth.tokenHash,
    ...(desktopToken ? { extraTokenHashes: [hashToken(desktopToken)] } : {}),
    hosts: bind.hosts,
    port,
    staticDir: clientDir(),
  });

  const urlFor = (h: string) => `${tls && !isLoopback(h) ? "https" : "http"}://${h.includes(":") ? `[${h}]` : h}:${server.port}`;
  const reachable = bind.hosts.map((h) => (h === "0.0.0.0" || h === "::" ? "127.0.0.1" : h));
  const url = urlFor(reachable[0]!);
  localUrl = url;
  const lines = [
    `Loom hub "${config.name}" ${HUB_VERSION}`,
    `  listening   ${reachable.map(urlFor).join(", ")}${bind.kind === "tailnet" ? " (loopback and Tailscale)" : ""}`,
    `  config      ${paths.configFile}${created ? " (created)" : ""}`,
    `  data        ${paths.dataDir}`,
    `  levels      default ${manager.defaultLevel}, max ${config.maxLevel}`,
    `  steward     ${config.stewardModel ? `${config.steward.mode} with ${config.steward.model}` : "off"}`,
    `  sessions    ${manager.list().length}`,
    `  terminals   ${sidecarBinary ?? "unavailable: run npm run build:pty"}`,
    `  voice       ${voice.summary}`,
    ...(config.heuristics.enabled.length ? [`  heuristics  ${screens.manifests.map((m) => m.manifest.id).join(", ") || "none loaded"} (from ${manifestsDir})`] : []),
    ...screens.problems.map((p) => `              ${p}`),
    ...voice.notes.map((n) => `              ${n}`),
  ];
  if (bind.warning) lines.push(`  WARNING     ${bind.warning}`);
  if (auth.newToken) {
    lines.push(
      "",
      "  New access token. It is shown only now; run with --new-token to replace it.",
      ...reachable.map((h) => `  open        ${urlFor(h)}/#token=${auth.newToken}`),
      `  dev client  http://localhost:5173/#token=${auth.newToken}`,
    );
  }
  if (relayHostname) lines.push(`  relay       https://${relayHostname} (connecting to ${config.relay!.url})`);
  process.stdout.write(`${lines.join("\n")}\n`);

  let relayClient: RelayClient | undefined;
  if (config.relay && certificates) {
    let lastStatus = "";
    relayClient = new RelayClient({
      url: config.relay.url,
      name: config.relay.name,
      secret: config.relay.secret,
      onStream: (kind, socket, visitor) => server.acceptRelayStream(kind, socket, visitor),
      onStatus: (status: RelayStatus) => {
        const text = status.kind === "up" ? `relay up: https://${status.hostname}` : status.kind === "down" ? `relay down (${status.reason}); retrying in ${Math.round(status.retryInMs / 1000)}s` : "";
        if (text && text !== lastStatus) logLine(text);
        lastStatus = text;
        if (status.kind === "up") {
          void certificates.ensure().then(
            () => certificates.accountUrl && logLine(`relay certificate ok until ${certificates.notAfter()?.toISOString()}; CAA accounturi: ${certificates.accountUrl}`),
            (err: unknown) => logLine(`relay certificate failed: ${err instanceof Error ? err.message : String(err)}`),
          );
        }
      },
    });
    relayClient.start();
    certificates.startRenewal();
  }

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`\n${signal}: stopping sessions…\n`);
    await server.close();
    await manager.shutdown();
    voice.close();
    notifier?.close();
    manager.heuristics.close();
    relayClient?.close();
    certificates?.close();
    await sidecars.close();
    log.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  // The desktop app holds our stdin open; when it quits or dies, stdin ends and the hub stops with it.
  if (exitWithStdin) {
    process.stdin.on("end", () => void shutdown("app closed"));
    process.stdin.on("error", () => void shutdown("app closed"));
    process.stdin.resume();
  }
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError || err instanceof BindError) process.stderr.write(`${err.message}\n`);
  else if ((err as NodeJS.ErrnoException)?.code === "EADDRINUSE") {
    process.stderr.write(`Port already in use. Is another hub running? ${(err as Error).message}\n`);
  } else process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
