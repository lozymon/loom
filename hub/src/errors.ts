import type { ErrorCode } from "@loom/protocol";

/** An error with a protocol error code, safe to show to a client. */
export class HubError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "HubError";
    this.code = code;
  }
}

export function assertNever(value: never): never {
  throw new Error(`unhandled case: ${JSON.stringify(value)}`);
}
