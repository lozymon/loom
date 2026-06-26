//! Read-only markdown/doc access for the Docs panel (IDEAS #4): list the markdown files near a
//! pane's working folder and read one's text, so a passage can be marked and sent into an agent
//! pane (the same gesture the Source Control panel gives for diff lines). Filesystem access is an
//! OS concern → Rust (CLAUDE.md); strictly read-only, and nothing here parses pane *output*.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// One markdown file found under (or near) a workspace folder. `path` is absolute — what the UI
/// hands back to `read_doc`; `rel` is the display path relative to the scanned root; `name` is the
/// basename for the list's primary label.
#[derive(Serialize)]
pub struct DocEntry {
    path: String,
    rel: String,
    name: String,
}

/// How deep to walk below the working folder (0 = the folder itself). Four levels reaches docs
/// nested a few directories down (e.g. `docs/adr/0007/notes.md`) without turning into a whole-tree
/// crawl; the entry cap, dotfolder/build skips, and the panel's filter box keep it manageable.
const MAX_DEPTH: usize = 4;
/// Cap the listing so a giant monorepo can't flood the panel; the native picker covers the rest.
const MAX_ENTRIES: usize = 300;
/// Cap a single doc at 2 MiB — these are meant to be read/marked, not whole books.
const MAX_BYTES: u64 = 2 * 1024 * 1024;

fn is_markdown(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".md") || lower.ends_with(".markdown") || lower.ends_with(".mdx")
}

/// Directories the walk never descends into — VCS/build noise, and any dotfolder.
fn skip_dir(name: &str) -> bool {
    matches!(
        name,
        "node_modules" | "target" | "dist" | "build" | "out" | "vendor"
    ) || name.starts_with('.')
}

/// List markdown files at/under `cwd` (bounded depth + count), README-first then alphabetical.
#[tauri::command]
pub fn list_docs(cwd: String) -> Result<Vec<DocEntry>, String> {
    let root = PathBuf::from(&cwd);
    if !root.is_dir() {
        return Err(format!("not a folder: {cwd}"));
    }
    let mut out: Vec<DocEntry> = Vec::new();
    walk(&root, &root, 0, &mut out);
    // README* floats to the top, then case-insensitive by display path so nested docs group.
    out.sort_by(|a, b| {
        let ra = a.name.to_ascii_lowercase().starts_with("readme");
        let rb = b.name.to_ascii_lowercase().starts_with("readme");
        rb.cmp(&ra)
            .then_with(|| a.rel.to_ascii_lowercase().cmp(&b.rel.to_ascii_lowercase()))
    });
    Ok(out)
}

fn walk(root: &Path, dir: &Path, depth: usize, out: &mut Vec<DocEntry>) {
    if out.len() >= MAX_ENTRIES {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut subdirs: Vec<PathBuf> = Vec::new();
    for entry in entries.flatten() {
        if out.len() >= MAX_ENTRIES {
            return;
        }
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        if ft.is_dir() {
            if depth < MAX_DEPTH && !skip_dir(name) {
                subdirs.push(path);
            }
        } else if ft.is_file() && is_markdown(name) {
            let rel = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .into_owned();
            out.push(DocEntry {
                path: path.to_string_lossy().into_owned(),
                rel,
                name: name.to_string(),
            });
        }
    }
    for sub in subdirs {
        walk(root, &sub, depth + 1, out);
    }
}

/// Read one UTF-8 text file (markdown). Capped at `MAX_BYTES`; lossily decoded so a stray
/// non-UTF8 byte doesn't fail the read.
///
/// Containment: this command is reachable from the webview, so it must not become an arbitrary-file
/// read primitive (e.g. `~/.ssh/id_rsa`, `.env`). We restrict it to markdown files — the only thing
/// the Docs panel ever opens — and re-check the extension *after* `canonicalize()` so a `foo.md`
/// symlink can't point at a secret. The user-driven native picker is also markdown-filtered, so this
/// doesn't constrain any legitimate flow.
#[tauri::command]
pub fn read_doc(path: String) -> Result<String, String> {
    let p = Path::new(&path);
    let name_ok = p
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(is_markdown);
    if !name_ok {
        return Err(format!("not a markdown file: {path}"));
    }
    // Resolve symlinks/.. and confirm the real target is still a markdown file.
    let real = fs::canonicalize(p).map_err(|e| format!("cannot read {path}: {e}"))?;
    let real_ok = real
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(is_markdown);
    if !real_ok {
        return Err(format!("not a markdown file: {path}"));
    }
    let p = real.as_path();
    let meta = fs::metadata(p).map_err(|e| format!("cannot read {path}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("not a file: {path}"));
    }
    if meta.len() > MAX_BYTES {
        return Err(format!(
            "file too large ({} KiB > {} KiB cap)",
            meta.len() / 1024,
            MAX_BYTES / 1024
        ));
    }
    let bytes = fs::read(p).map_err(|e| format!("cannot read {path}: {e}"))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}
