// Gathers what the desktop app ships (M9): the hub bundle, the built client, a Node runtime, the
// sidecars, and the Agent SDK's `claude` binary. Tauri needs them in place before it builds.
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktop = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repo = path.dirname(desktop);
const tauriDir = path.join(desktop, "src-tauri");
const win = process.platform === "win32";
const exe = (name) => (win ? `${name}.exe` : name);
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", cwd: repo, shell: win, ...opts });

const triple = /host: (\S+)/.exec(execFileSync("rustc", ["-vV"], { encoding: "utf8" }))?.[1];
if (!triple) throw new Error("cannot read the Rust host target from rustc -vV");

// Hub and client.
const resources = path.join(tauriDir, "bundle-resources");
rmSync(resources, { recursive: true, force: true });
run(process.execPath, [path.join(repo, "hub", "scripts", "bundle.mjs"), path.join(resources, "hub")]);
run("npm", ["run", "build", "-w", "@loom/client"]);
cpSync(path.join(repo, "client", "dist"), path.join(resources, "client"), { recursive: true });

// Binaries, named with the target triple as Tauri's externalBin expects.
const binaries = path.join(tauriDir, "binaries");
mkdirSync(binaries, { recursive: true });
const place = (from, name) => {
  if (!existsSync(from)) throw new Error(`missing ${from}`);
  const to = path.join(binaries, exe(`${name}-${triple}`));
  copyFileSync(from, to);
  if (!win) chmodSync(to, 0o755);
  console.log(`${name} <- ${from}`);
};

place(process.execPath, "loom-node");

const pty = path.join(repo, "sidecars", "pty", "target", "release", exe("loom-pty"));
if (!existsSync(pty)) run("npm", ["run", "build:pty"]);
place(pty, "loom-pty");

if (!win) {
  const voce = path.join(repo, "sidecars", "voce", "target", "release", exe("loom-voce"));
  if (!existsSync(voce)) {
    console.log("building loom-voce (whisper.cpp; needs cmake)…");
    run("npm", ["run", "build:voce"]);
  }
  place(voce, "loom-voce");
}

const platform = process.platform === "linux" ? `linux-${process.arch}` : `${process.platform}-${process.arch}`;
const claude = path.join(repo, "node_modules", "@anthropic-ai", `claude-agent-sdk-${platform}`, exe("claude"));
place(claude, "loom-claude");
console.log("desktop bundle prepared");
