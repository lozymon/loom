#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { useSingleEntry } from "./loom/integration.ts";

/**
 * The bundled hub's one entry point (M9): `hub.mjs` runs the hub, `hub.mjs cli …` the `loom` command,
 * and `hub.mjs mcp` the stdio MCP server. Sessions' `loom` shim and MCP config point back here.
 */
const sub = process.argv[2];
useSingleEntry(fileURLToPath(import.meta.url));
if (sub === "cli" || sub === "mcp") process.argv.splice(2, 1);

if (sub === "cli") await import("./loom/cli.ts");
else if (sub === "mcp") await import("./loom/stdioServer.ts");
else await import("./main.ts");
