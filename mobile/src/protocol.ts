// The slice of Loom's control-bus protocol the app speaks (mirrors src/ipc/protocol.ts). The
// deny-by-default policy (ADR-0012 rule 3) means the app only ever sends `list`, `read`, `send` — so
// this is deliberately a subset, not the whole ControlRequest union. Keeping it small is the point.

/** What the app can ask the fleet to do. `list` is unprompted; `send`/`read` fire a Clearance. */
export type AppRequest =
  | { op: "list" }
  | { op: "read"; target: string; lines?: number }
  | { op: "send"; target: string; text: string; enter?: boolean };

/** The bridge's reply, mirroring ControlResponse. */
export type AppResponse =
  | { ok: true; data?: unknown }
  | { ok: false; error: string };

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
}

/** The pairing payload the laptop's QR encodes (Rust `PairingInfo`). `key` is base64 of 32 bytes. */
export interface PairingInfo {
  url: string;
  host: string;
  port: number;
  key: string;
}
