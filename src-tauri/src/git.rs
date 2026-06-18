//! Read-only git integration for the Source Control panel (a VSCode-style diff viewer).
//!
//! Shelling out to `git` is an OS concern, so it lives in Rust (CLAUDE.md: OS/syscalls in
//! Rust, UX/state in TS). These commands are strictly read-only — list the changed files and
//! return a file's unified diff text; all parsing/rendering of that diff happens in TS.
//!
//! Path handling, the one subtlety: `git status --porcelain` always prints paths relative to
//! the *repository root*, and `git diff -- <path>` only resolves those paths when run from the
//! root. So every command first resolves the root via `rev-parse --show-toplevel` and runs
//! there — keeping status paths and diff pathspecs in the same frame regardless of which
//! subfolder a workspace's `cwd` points at.

use std::path::Path;
use std::process::Command;

use serde::Serialize;

/// One changed path as reported by `git status`. `status` is the raw two-char porcelain code
/// (e.g. " M", "M ", "MM", "??", "A ", "R "); the flags decode which side(s) changed so the
/// UI can group files into "Staged" vs "Changes" without re-parsing the code.
#[derive(Serialize)]
pub struct GitFile {
    path: String,
    status: String,
    /// Index differs from HEAD (a staged change). False for untracked.
    staged: bool,
    /// Working tree differs from the index (an unstaged change).
    unstaged: bool,
    /// Not yet tracked by git (porcelain `??`).
    untracked: bool,
}

/// Result of `git_status`: whether `cwd` is in a repo, plus the repo root, current branch, and
/// the changed files. `is_repo: false` is a normal answer (the panel shows an empty state),
/// not an error.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    is_repo: bool,
    root: String,
    branch: String,
    files: Vec<GitFile>,
}

/// Run `git -C <dir> <args...>`, returning (success, stdout, stderr).
fn git(dir: &str, args: &[&str]) -> Result<(bool, String, String), String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;
    Ok((
        out.status.success(),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    ))
}

/// Parse `-z` porcelain-v1 output into changed-file entries. Records are NUL-terminated; a
/// rename/copy record is followed by an extra NUL-terminated original path which we skip (the
/// XY record already carries the new path, which is what we display).
fn parse_porcelain_z(out: &str) -> Vec<GitFile> {
    let parts: Vec<&str> = out.split('\0').collect();
    let mut files = Vec::new();
    let mut i = 0;
    while i < parts.len() {
        let rec = parts[i];
        i += 1;
        if rec.len() < 3 {
            continue; // trailing empty segment from the final NUL, or malformed
        }
        let bytes = rec.as_bytes();
        let x = bytes[0] as char;
        let y = bytes[1] as char;
        let path = rec[3..].to_string();
        // Rename/copy entries emit the original path as a separate following record — skip it.
        if x == 'R' || x == 'C' || y == 'R' || y == 'C' {
            i += 1;
        }
        files.push(GitFile {
            status: rec[..2].to_string(),
            path,
            staged: x != ' ' && x != '?',
            unstaged: y != ' ' && y != '?',
            untracked: x == '?',
        });
    }
    files
}

/// List the changed files in the repo containing `cwd` (plus its root + branch).
#[tauri::command]
pub async fn git_status(cwd: String) -> Result<GitStatus, String> {
    let (ok, root_out, _) = git(&cwd, &["rev-parse", "--show-toplevel"])?;
    if !ok {
        // Not a git repo (or git missing) — a normal empty state, not an error.
        return Ok(GitStatus {
            is_repo: false,
            root: String::new(),
            branch: String::new(),
            files: Vec::new(),
        });
    }
    let root = root_out.trim().to_string();

    let (_, branch_out, _) = git(&root, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    let branch = branch_out.trim().to_string();

    let (ok, status_out, err) = git(
        &root,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )?;
    if !ok {
        return Err(err);
    }

    Ok(GitStatus {
        is_repo: true,
        root,
        branch,
        files: parse_porcelain_z(&status_out),
    })
}

/// Current branch of the repo containing `cwd` — for the pane title bar. Deliberately
/// lightweight: a single `rev-parse`, none of `git_status`'s porcelain scan, since this is
/// polled per visible pane. Returns `None` when `cwd` isn't in a repo (or git is missing) —
/// a normal "no badge" state, not an error. A detached HEAD reports as `(<short-sha>)`.
#[tauri::command]
pub async fn git_branch(cwd: String) -> Result<Option<String>, String> {
    let (ok, out, _) = git(&cwd, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    if !ok {
        return Ok(None);
    }
    let branch = out.trim().to_string();
    if branch.is_empty() {
        return Ok(None);
    }
    if branch == "HEAD" {
        // Detached HEAD — surface the short commit instead of the literal "HEAD".
        if let (true, sha, _) = git(&cwd, &["rev-parse", "--short", "HEAD"])? {
            let sha = sha.trim();
            if !sha.is_empty() {
                return Ok(Some(format!("({sha})")));
            }
        }
    }
    Ok(Some(branch))
}

/// Return the unified diff text for one `path` (repo-root-relative, from `git_status`).
/// `staged` selects index-vs-HEAD (`--cached`) over worktree-vs-index; `untracked` files have
/// no index entry, so they're diffed against `/dev/null` to render the whole file as additions.
#[tauri::command]
pub async fn git_diff(
    cwd: String,
    path: String,
    staged: bool,
    untracked: bool,
) -> Result<String, String> {
    let (ok, root_out, err) = git(&cwd, &["rev-parse", "--show-toplevel"])?;
    if !ok {
        return Err(err);
    }
    let root = root_out.trim().to_string();

    if untracked {
        // `git diff --no-index <path>` prints the FULL contents of any file it's handed, so an
        // attacker-supplied `path` (this is a free-form command arg) would be an arbitrary-file-read
        // primitive — including absolute paths and `..` escapes. Confine it to the repo: resolve the
        // path against the root and require the canonical target to live inside the (canonical) root.
        // (`join` with an absolute `path` replaces the base, so absolute paths are caught here too.)
        let root_real =
            std::fs::canonicalize(&root).map_err(|e| format!("cannot resolve repo root: {e}"))?;
        let target = std::fs::canonicalize(Path::new(&root).join(&path))
            .map_err(|e| format!("cannot read {path}: {e}"))?;
        if !target.starts_with(&root_real) {
            return Err(format!("path escapes repository: {path}"));
        }
        // `--no-index` exits 1 when the files differ (the normal case here) — that's not an
        // error, so we return stdout regardless of the exit status.
        let out = Command::new("git")
            .arg("-C")
            .arg(&root)
            .args(["diff", "--no-index", "--color=never", "--", "/dev/null"])
            .arg(&target)
            .output()
            .map_err(|e| format!("failed to run git: {e}"))?;
        return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
    }

    let mut args = vec!["diff", "--color=never"];
    if staged {
        args.push("--cached");
    }
    args.push("--");
    let out = Command::new("git")
        .arg("-C")
        .arg(&root)
        .args(&args)
        .arg(&path)
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}
