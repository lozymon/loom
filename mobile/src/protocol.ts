// The slice of Loom's control-bus protocol the app speaks (mirrors src/ipc/protocol.ts). The
// deny-by-default policy (ADR-0012 rule 3) means the app only ever sends `list`, `read`, `send` — so
// this is deliberately a subset, not the whole ControlRequest union. Keeping it small is the point.

/** What the app can ask the fleet to do. `list` is unprompted; `send`/`read` fire a Clearance. */
export type AppRequest =
  | { op: "list" }
  | { op: "read"; target: string; lines?: number }
  | { op: "send"; target: string; text: string; enter?: boolean }
  // Upload an image (base64) to the laptop; the reply's `data.path` is where it was saved, which we
  // then reference to an agent (a terminal can't take an image, but a path it can). ADR-0012 `approve`.
  | { op: "upload"; target: string; filename: string; data: string };

/** The bridge's reply, mirroring ControlResponse. */
export type AppResponse =
  | { ok: true; data?: unknown }
  | { ok: false; error: string };

/** One selectable answer for a `choice` approval — the real options an agent pushed (Claude Code's
 *  AskUserQuestion). Tapping one sends its 1-based ordinal to the pane (the menu's number-key select). */
export interface ApprovalOption {
  label: string;
  description?: string;
}

/** The blocked-approval a pane carries, so we can show the real prompt + choices and answer them. */
export interface PaneApproval {
  prompt: string;
  kind: "permission" | "question" | "choice";
  options?: ApprovalOption[];
}

/** One pane in a `list` reply — the enriched payload from P0c (status/attention/sessionState added). */
export interface PaneInfo {
  name: string;
  workspace: string;
  focused: boolean;
  live: boolean;
  role?: string;
  gated?: boolean;
  status?: string;
  attention?: boolean;
  sessionState?: "running" | "idle" | "blocked" | "done" | "failed";
  /** Present when the pane's active Task is blocked — the actual prompt + choices to answer. */
  approval?: PaneApproval;
}

/** The pairing payload the laptop's QR encodes (Rust `PairingInfo`). `key` is base64 of 32 bytes. */
export interface PairingInfo {
  url: string;
  host: string;
  port: number;
  key: string;
}
