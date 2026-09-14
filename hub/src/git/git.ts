import { execFile } from "node:child_process";

export class GitError extends Error {
  override name = "GitError";
  readonly stderr: string;
  readonly code: number | string | undefined;

  constructor(message: string, stderr: string, code: number | string | undefined) {
    super(message);
    this.stderr = stderr;
    this.code = code;
  }
}

/**
 * Runs git with an argument array, never through a shell, with prompts disabled so a credential or
 * editor prompt cannot hang the hub.
 */
export function git(args: string[], cwd: string, timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_EDITOR: "true" },
      },
      (err, stdout, stderr) => {
        if (err) {
          const text = String(stderr).trim() || err.message;
          reject(new GitError(`git ${args[0]} failed: ${text}`, String(stderr), (err as NodeJS.ErrnoException).code));
        } else {
          resolve(String(stdout));
        }
      },
    );
  });
}
