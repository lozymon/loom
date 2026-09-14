import acme from "acme-client";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createSecureContext, type SecureContext } from "node:tls";
import { X509Certificate } from "node:crypto";

export type CertificateSource = { files: { cert: string; key: string } } | { acme: { directory: string; email?: string | undefined; verifyChallenge: boolean } };

export interface CertificateOptions {
  hostname: string;
  /** Where ACME keys and certificates are kept. */
  dir: string;
  source: CertificateSource;
  log?: (line: string) => void;
  now?: () => number;
}

const RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000;

function writePrivate(file: string, data: string | Buffer): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/**
 * The hub's certificate for its relay name (ADR-0014): from files, or from an ACME CA with HTTP-01
 * answered through the relay. Signing and CSRs are acme-client's; the key never leaves this machine.
 */
export class RelayCertificates {
  #opts: CertificateOptions;
  #context: SecureContext | undefined;
  #notAfter: number | undefined;
  #challenges = new Map<string, string>();
  #busy: Promise<void> | undefined;
  #timer: NodeJS.Timeout | undefined;
  accountUrl: string | undefined;

  constructor(opts: CertificateOptions) {
    this.#opts = opts;
    this.#loadStored();
  }

  get #certFile() {
    return path.join(this.#opts.dir, `${this.#opts.hostname}.crt`);
  }
  get #keyFile() {
    return path.join(this.#opts.dir, `${this.#opts.hostname}.key`);
  }

  /** The current TLS context, or undefined before the first certificate. */
  context(): SecureContext | undefined {
    return this.#context;
  }

  notAfter(): Date | undefined {
    return this.#notAfter === undefined ? undefined : new Date(this.#notAfter);
  }

  /** The key authorization for an HTTP-01 token this hub is answering, if any. */
  challenge(token: string): string | undefined {
    return this.#challenges.get(token);
  }

  #use(cert: string | Buffer, key: string | Buffer): void {
    const info = new X509Certificate(cert);
    if (!info.checkHost(this.#opts.hostname)) throw new Error(`the certificate is not for ${this.#opts.hostname}`);
    this.#context = createSecureContext({ cert, key });
    this.#notAfter = Date.parse(info.validTo);
  }

  #loadStored(): void {
    const files = "files" in this.#opts.source ? this.#opts.source.files : { cert: this.#certFile, key: this.#keyFile };
    if (!existsSync(files.cert) || !existsSync(files.key)) return;
    try {
      this.#use(readFileSync(files.cert), readFileSync(files.key));
    } catch (err) {
      this.#opts.log?.(`relay certificate not usable: ${(err as Error).message}`);
    }
    const account = path.join(this.#opts.dir, "acme-account.json");
    if (existsSync(account)) this.accountUrl = (JSON.parse(readFileSync(account, "utf8")) as { url?: string }).url;
  }

  /** Gets or renews the certificate when needed. Safe to call often; runs one order at a time. */
  ensure(): Promise<void> {
    this.#busy ??= this.#ensure().finally(() => (this.#busy = undefined));
    return this.#busy;
  }

  async #ensure(): Promise<void> {
    if ("files" in this.#opts.source) {
      this.#use(readFileSync(this.#opts.source.files.cert), readFileSync(this.#opts.source.files.key));
      return;
    }
    const source = this.#opts.source.acme;
    const now = (this.#opts.now ?? Date.now)();
    if (this.#notAfter !== undefined && this.#notAfter - now > RENEW_BEFORE_MS) return;

    const accountKeyFile = path.join(this.#opts.dir, "acme-account.key");
    const accountFile = path.join(this.#opts.dir, "acme-account.json");
    if (!existsSync(accountKeyFile)) writePrivate(accountKeyFile, await acme.crypto.createPrivateEcdsaKey("P-256"));
    const stored = existsSync(accountFile) ? (JSON.parse(readFileSync(accountFile, "utf8")) as { url?: string; directory?: string }) : {};
    const client = new acme.Client({
      directoryUrl: source.directory,
      accountKey: readFileSync(accountKeyFile),
      ...(stored.url && stored.directory === source.directory ? { accountUrl: stored.url } : {}),
    });
    this.#opts.log?.(`requesting a certificate for ${this.#opts.hostname}`);
    const [key, csr] = await acme.crypto.createCsr({ commonName: this.#opts.hostname, altNames: [this.#opts.hostname] }, await acme.crypto.createPrivateEcdsaKey("P-256"));
    const cert = await client.auto({
      csr,
      ...(source.email ? { email: source.email } : {}),
      termsOfServiceAgreed: true,
      challengePriority: ["http-01"],
      skipChallengeVerification: !source.verifyChallenge,
      challengeCreateFn: async (_authz, challenge, keyAuthorization) => void this.#challenges.set(challenge.token, keyAuthorization),
      challengeRemoveFn: async (_authz, challenge) => void this.#challenges.delete(challenge.token),
    });
    this.accountUrl = client.getAccountUrl();
    writePrivate(accountFile, `${JSON.stringify({ url: this.accountUrl, directory: source.directory }, null, 2)}\n`);
    writePrivate(this.#keyFile, key);
    writePrivate(this.#certFile, cert);
    this.#use(cert, key);
    this.#opts.log?.(`certificate for ${this.#opts.hostname} valid until ${this.notAfter()?.toISOString()}`);
  }

  /** Checks twice a day. */
  startRenewal(): void {
    this.#timer = setInterval(() => void this.ensure().catch((err: unknown) => this.#opts.log?.(`certificate renewal failed: ${(err as Error).message}`)), 12 * 60 * 60 * 1000);
    this.#timer.unref();
  }

  close(): void {
    clearInterval(this.#timer);
  }
}
