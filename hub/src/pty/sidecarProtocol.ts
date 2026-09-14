// Mirrors sidecars/pty/src/protocol.rs. One JSON object per line in each direction.

export type SidecarCommand =
  | {
      op: "spawn";
      id: number;
      program: string;
      args: string[];
      cwd?: string;
      env: Record<string, string>;
      cols: number;
      rows: number;
    }
  | { op: "write"; id: number; data: string }
  | { op: "resize"; id: number; cols: number; rows: number }
  | { op: "kill"; id: number };

export type SidecarEvent =
  | { ev: "ready"; version: string; platform: string }
  | { ev: "spawned"; id: number; pid: number | null }
  | { ev: "output"; id: number; data: string }
  | { ev: "exit"; id: number; code: number }
  | { ev: "error"; id?: number; message: string };
