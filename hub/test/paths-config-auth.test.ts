import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashToken, loadOrCreateAuth, verifyToken } from "../src/auth.ts";
import { ConfigError, loadConfig } from "../src/config.ts";
import { resolvePaths } from "../src/paths.ts";
import { allocName, NAME_POOL } from "../src/core/names.ts";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), "loom-hub-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("resolvePaths", () => {
  it("uses XDG locations on Linux", () => {
    const p = resolvePaths({ platform: "linux", env: {}, homedir: "/home/kim" });
    expect(p.configFile).toBe("/home/kim/.config/loom/hub.json");
    expect(p.dbFile).toBe("/home/kim/.local/share/loom/events.db");
    const xdg = resolvePaths({ platform: "linux", env: { XDG_CONFIG_HOME: "/cfg", XDG_DATA_HOME: "/data" }, homedir: "/h" });
    expect([xdg.configDir, xdg.dataDir]).toEqual(["/cfg/loom", "/data/loom"]);
  });

  it("uses APPDATA on Windows", () => {
    const p = resolvePaths({ platform: "win32", env: { APPDATA: "C:\\Users\\kim\\AppData\\Roaming" }, homedir: "C:\\Users\\kim" });
    expect(p.configFile).toBe("C:\\Users\\kim\\AppData\\Roaming\\loom\\hub.json");
    expect(p.dbFile).toBe("C:\\Users\\kim\\AppData\\Roaming\\loom\\events.db");
  });

  it("puts everything in one directory when home is given", () => {
    const p = resolvePaths({ platform: "linux", home: "/tmp/dev", env: {}, homedir: "/h" });
    expect(p.configDir).toBe(p.dataDir);
    expect(p.authFile).toBe("/tmp/dev/auth.json");
  });
});

describe("loadConfig", () => {
  it("creates cautious defaults on first run and reads them back", () => {
    const paths = resolvePaths({ home: tmp() });
    const first = loadConfig(paths);
    expect(first.created).toBe(true);
    expect(first.config).toMatchObject({ bind: "127.0.0.1", defaultLevel: "supervised", maxLevel: "accept-edits", stewardModel: false });
    const second = loadConfig(paths);
    expect(second).toEqual({ config: first.config, created: false });
  });

  it("rejects unknown keys and a default above the max", () => {
    const paths = resolvePaths({ home: tmp() });
    const { config } = loadConfig(paths);
    writeFileSync(paths.configFile, JSON.stringify({ ...config, surprise: true }));
    expect(() => loadConfig(paths)).toThrow(ConfigError);
    writeFileSync(paths.configFile, JSON.stringify({ ...config, defaultLevel: "full", maxLevel: "supervised" }));
    expect(() => loadConfig(paths)).toThrow(/defaultLevel/);
  });
});

describe("auth", () => {
  it("creates a token once, stores only its hash, and rotates on request", () => {
    const file = path.join(tmp(), "auth.json");
    const created = loadOrCreateAuth(file);
    expect(created.newToken).toBeDefined();
    expect(readFileSync(file, "utf8")).not.toContain(created.newToken);
    expect(verifyToken(created.newToken, created.tokenHash)).toBe(true);

    expect(loadOrCreateAuth(file)).toEqual({ tokenHash: created.tokenHash });
    const rotated = loadOrCreateAuth(file, { rotate: true });
    expect(rotated.tokenHash).not.toBe(created.tokenHash);
  });

  it("rejects wrong and missing tokens", () => {
    const hash = hashToken("right");
    expect(verifyToken("wrong", hash)).toBe(false);
    expect(verifyToken(undefined, hash)).toBe(false);
  });
});

describe("allocName", () => {
  it("walks the pool case-insensitively, then numbers", () => {
    expect(allocName(["faye"])).toBe("Cleo");
    expect(allocName(NAME_POOL)).toBe("Session 1");
  });
});
