import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { HubRegistry } from "./registry.ts";
import { startRelay } from "./server.ts";

const USAGE = `Usage: loom-relay <command> [--config /etc/loom-relay/relay.json]

  run                 start the relay
  add-hub <name>      enroll a hub, or give it a new secret; prints the secret once
  remove-hub <name>   stop a hub from registering
  list-hubs           enrolled hubs
`;

const Config = z
  .object({
    /** The relay's own name. Hubs become <name>.<domain>; DNS needs A records for both. */
    domain: z.string().regex(/^[a-z0-9.-]+$/),
    /** Certificate files for the domain itself (certbot or similar). Re-read on SIGHUP. */
    cert: z.string().min(1),
    key: z.string().min(1),
    dataDir: z.string().min(1).default("/var/lib/loom-relay"),
    host: z.string().min(1).default("0.0.0.0"),
    httpsPort: z.number().int().min(1).max(65535).default(443),
    /** Set to null when another server owns port 80 and forwards ACME paths here. */
    httpPort: z.number().int().min(1).max(65535).nullable().default(80),
  })
  .strict();

function loadConfig(file: string): z.infer<typeof Config> {
  const parsed = Config.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) throw new Error(`${file} is invalid:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { config: { type: "string" }, help: { type: "boolean" } } });
  const [command, name] = positionals;
  if (!command || values.help) {
    process.stdout.write(USAGE);
    return command ? 0 : 1;
  }
  const config = loadConfig(values.config ?? process.env.LOOM_RELAY_CONFIG ?? "/etc/loom-relay/relay.json");
  const registry = new HubRegistry(path.join(config.dataDir, "hubs.json"));

  switch (command) {
    case "add-hub": {
      if (!name) throw new Error("add-hub needs a name");
      const secret = registry.add(name);
      process.stdout.write(
        [
          `Enrolled ${name}. Its address is https://${name}.${config.domain}${config.httpsPort === 443 ? "" : `:${config.httpsPort}`}`,
          "Put this in that hub's hub.json. The secret is shown only now:",
          "",
          JSON.stringify({ relay: { url: `wss://${config.domain}${config.httpsPort === 443 ? "" : `:${config.httpsPort}`}`, name, secret } }, null, 2),
          "",
        ].join("\n"),
      );
      return 0;
    }
    case "remove-hub":
      if (!name) throw new Error("remove-hub needs a name");
      process.stdout.write(registry.remove(name) ? `Removed ${name}.\n` : `${name} was not enrolled.\n`);
      return 0;
    case "list-hubs":
      for (const h of registry.list()) process.stdout.write(`${h.name}\t${h.createdAt}\n`);
      return 0;
    case "run": {
      const readTls = () => ({ cert: readFileSync(config.cert), key: readFileSync(config.key) });
      const relay = await startRelay({
        domain: config.domain,
        tls: readTls(),
        host: config.host,
        httpsPort: config.httpsPort,
        httpPort: config.httpPort ?? undefined,
        registry,
        log: (line) => process.stdout.write(`${new Date().toISOString()} ${line}\n`),
      });
      process.on("SIGHUP", () => {
        try {
          relay.setCertificate(readTls());
          process.stdout.write("certificate reloaded\n");
        } catch (err) {
          process.stderr.write(`certificate reload failed: ${(err as Error).message}\n`);
        }
      });
      const stop = () => void relay.close().then(() => process.exit(0));
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      return new Promise<number>(() => undefined);
    }
    default:
      process.stderr.write(USAGE);
      return 1;
  }
}

main().then(
  (code) => {
    if (code !== undefined) process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`loom-relay: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
