// Bundles the hub into plain ES modules for packaging (M9): `hub/dist/hub.mjs` plus chunks.
// Node built-ins stay external; everything from node_modules is inlined, so the output runs with
// only a Node runtime next to it.
import { rm } from "node:fs/promises";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "rolldown";

const hubDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(hubDir, "dist");
const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

await rm(outDir, { recursive: true, force: true });
await build({
  input: path.join(hubDir, "src", "bin.ts"),
  platform: "node",
  external: (id) => builtins.has(id) || id.startsWith("node:"),
  output: {
    dir: outDir,
    format: "esm",
    entryFileNames: "hub.mjs",
    chunkFileNames: "[name]-[hash].mjs",
    // Some dependencies still call require(); give ESM output a working one.
    banner: 'import { createRequire as __loomCreateRequire } from "node:module"; const require = __loomCreateRequire(import.meta.url);',
  },
});
console.log(`hub bundled into ${outDir}`);
