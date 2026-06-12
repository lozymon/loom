// Client for the read-only docs commands (src-tauri/src/docs.rs): list the markdown files near a
// working folder and read one's text. Filesystem access is an OS concern (Rust); this is just the
// thin invoke wrapper. The DocsPanel marks a passage of the returned text and sends it to a pane.

import { invoke } from "@tauri-apps/api/core";

/** One markdown file from `list_docs` (see Rust `DocEntry`). */
export interface DocEntry {
  /** Absolute path — feed back to `readDoc` verbatim. */
  path: string;
  /** Display path relative to the scanned working folder. */
  rel: string;
  /** Basename, for the file row's primary label. */
  name: string;
}

/** List markdown files at/under `cwd` (bounded walk, README-first). */
export const listDocs = (cwd: string): Promise<DocEntry[]> =>
  invoke<DocEntry[]>("list_docs", { cwd });

/** Read one markdown file's raw text (capped + lossily decoded in Rust). */
export const readDoc = (path: string): Promise<string> =>
  invoke<string>("read_doc", { path });
