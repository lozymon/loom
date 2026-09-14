// Bundles the relay into one ES module for the VPS: relay/dist/loom-relay.mjs. Needs only Node 24 there.
import { rm } from "node:fs/promises";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "rolldown";

const relayDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(relayDir, "dist");
const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

await rm(outDir, { recursive: true, force: true });
await build({
  input: path.join(relayDir, "src", "main.ts"),
  platform: "node",
  external: (id) => builtins.has(id) || id.startsWith("node:"),
  output: {
    file: path.join(outDir, "loom-relay.mjs"),
    format: "esm",
    codeSplitting: false,
    banner: '#!/usr/bin/env node\nimport { createRequire as __loomCreateRequire } from "node:module"; const require = __loomCreateRequire(import.meta.url);',
  },
});
console.log(`relay bundled into ${path.join(outDir, "loom-relay.mjs")}`);
