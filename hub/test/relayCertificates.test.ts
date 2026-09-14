import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RelayCertificates } from "../src/relay/certificates.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function hasOpenssl(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!hasOpenssl())("RelayCertificates", () => {
  it("uses certificate files for the relay name and refuses ones for another name", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "loom-relay-cert-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const make = (name: string) => {
      writeFileSync(path.join(dir, `${name}.ext`), `subjectAltName=DNS:${name}\n`);
      execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "2", "-subj", `/CN=${name}`, "-addext", `subjectAltName=DNS:${name}`, "-keyout", `${name}.key`, "-out", `${name}.crt`], { cwd: dir, stdio: "ignore" });
      return { cert: path.join(dir, `${name}.crt`), key: path.join(dir, `${name}.key`) };
    };
    const good = new RelayCertificates({ hostname: "work.relay.test", dir, source: { files: make("work.relay.test") } });
    await good.ensure();
    expect(good.context()).toBeDefined();
    expect(good.notAfter()!.getTime()).toBeGreaterThan(Date.now());
    expect(good.challenge("anything")).toBeUndefined();

    const wrong = new RelayCertificates({ hostname: "work.relay.test", dir, source: { files: make("home.relay.test") } });
    await expect(wrong.ensure()).rejects.toThrow(/not for work\.relay\.test/);
    expect(wrong.context()).toBeUndefined();
  });
});
