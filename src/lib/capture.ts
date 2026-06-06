// Client for the Rust `capture_region` command: pops the desktop region selector and
// resolves to the saved PNG's absolute path (rejects if the user cancels the selection).

import { invoke } from "@tauri-apps/api/core";

export const captureRegion = (): Promise<string> => invoke<string>("capture_region");
