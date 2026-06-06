// Thin client over the Rust JSON-blob persistence commands (src-tauri/src/workspace.rs).
// Rust just stores an opaque string per key under the app config dir; the schema is ours.

import { invoke } from "@tauri-apps/api/core";

export const saveState = (key: string, json: string): Promise<void> =>
  invoke("state_save", { key, json });

export const loadState = (key: string): Promise<string | null> =>
  invoke<string | null>("state_load", { key });
