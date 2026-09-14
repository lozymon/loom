import os from "node:os";
import path from "node:path";

export interface HubPaths {
  configDir: string;
  dataDir: string;
  configFile: string;
  authFile: string;
  dbFile: string;
}

export interface PathInputs {
  /** One directory for config and data, e.g. `.loom-dev`. Overrides platform locations. */
  home?: string | undefined;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
}

/**
 * Where the hub keeps its files (ADR-0012).
 *
 * - Linux: `$XDG_CONFIG_HOME/loom` (default `~/.config/loom`) and `$XDG_DATA_HOME/loom` (default `~/.local/share/loom`)
 * - Windows: `%APPDATA%\loom` for both
 * - `home` set: that directory for both
 */
export function resolvePaths(inputs: PathInputs = {}): HubPaths {
  const platform = inputs.platform ?? process.platform;
  const env = inputs.env ?? process.env;
  const homedir = inputs.homedir ?? os.homedir();
  const p = platform === "win32" ? path.win32 : path.posix;

  let configDir: string;
  let dataDir: string;
  if (inputs.home) {
    configDir = dataDir = p.resolve(inputs.home);
  } else if (platform === "win32") {
    configDir = dataDir = p.join(env.APPDATA ?? p.join(homedir, "AppData", "Roaming"), "loom");
  } else {
    configDir = p.join(env.XDG_CONFIG_HOME || p.join(homedir, ".config"), "loom");
    dataDir = p.join(env.XDG_DATA_HOME || p.join(homedir, ".local", "share"), "loom");
  }

  return {
    configDir,
    dataDir,
    configFile: p.join(configDir, "hub.json"),
    authFile: p.join(dataDir, "auth.json"),
    dbFile: p.join(dataDir, "events.db"),
  };
}
