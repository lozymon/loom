//! Read-only discovery of past Claude Code sessions, for the "open any Claude session" picker.
//! Claude persists each conversation as `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`; we
//! enumerate those, pull a working folder + a short title + last-modified time from each, and let
//! the UI relaunch one in a fresh pane via `claude --resume <id>`.
//!
//! This reads *another tool's own on-disk session store* (much like `git.rs` reads `.git`) — it is
//! not parsing any pane's output, so it doesn't touch the opacity rule (ADR-0001). Strictly
//! read-only and Claude-specific. Filesystem access is an OS concern → Rust (CLAUDE.md).

use std::env;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::time::UNIX_EPOCH;

use serde::Serialize;

/// One resumable Claude conversation found on disk.
#[derive(Serialize)]
pub struct ClaudeSession {
    /// Session id — the `.jsonl` filename stem; feed verbatim to `claude --resume`.
    id: String,
    /// Working folder the session ran in (from the transcript's `cwd`, else a best-effort decode
    /// of the encoded directory name).
    cwd: String,
    /// A short title (the first real user prompt), or "" when none could be derived.
    title: String,
    /// Whole seconds since the Unix epoch of last modification (0 if unavailable) — for sorting.
    modified: u64,
}

#[cfg(unix)]
fn home_dir() -> Option<String> {
    env::var("HOME").ok()
}

#[cfg(windows)]
fn home_dir() -> Option<String> {
    env::var("USERPROFILE").ok()
}

/// Best-effort reconstruction of a cwd from Claude's encoded project directory name (slashes
/// become dashes, so `-home-lozymon-code` → `/home/lozymon/code`). Lossy for paths that already
/// contain dashes — only a fallback; the transcript's own `cwd` field is preferred when present.
fn decode_project_dir(name: &str) -> String {
    name.replace('-', "/")
}

/// Scan the head of a transcript for a cwd + a usable title. Stops as soon as both are found (or
/// after a bounded number of lines), so we never read a whole large conversation just to label it.
fn extract(path: &PathBuf) -> (Option<String>, Option<String>) {
    let Ok(file) = File::open(path) else {
        return (None, None);
    };
    let mut cwd: Option<String> = None;
    let mut title: Option<String> = None;
    for line in BufReader::new(file).lines().map_while(Result::ok).take(400) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if cwd.is_none() {
            if let Some(c) = v.get("cwd").and_then(|c| c.as_str()) {
                if !c.is_empty() {
                    cwd = Some(c.to_string());
                }
            }
        }
        // Title = the first non-meta user message's text. Content is either a plain string or an
        // array of typed blocks; we take text blocks. Skip `<…>`-prefixed tool/system noise.
        if title.is_none()
            && v.get("type").and_then(|t| t.as_str()) == Some("user")
            && !v.get("isMeta").and_then(|m| m.as_bool()).unwrap_or(false)
        {
            let content = v.get("message").and_then(|m| m.get("content"));
            let text = match content {
                Some(serde_json::Value::String(s)) => s.clone(),
                Some(serde_json::Value::Array(blocks)) => blocks
                    .iter()
                    .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
                    .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                    .collect::<Vec<_>>()
                    .join(" "),
                _ => String::new(),
            };
            let text = text.trim();
            if !text.is_empty() && !text.starts_with('<') {
                title = Some(text.chars().take(80).collect());
            }
        }
        if cwd.is_some() && title.is_some() {
            break;
        }
    }
    (cwd, title)
}

/// Token totals for one model within a session (summed across its assistant messages). Cost is
/// derived on the frontend from these + a pricing table (lib/claudeUsage.ts), so the Rust side stays
/// pricing-agnostic — it only counts tokens (from Claude's own transcript, never pane output).
#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct ModelUsage {
    model: String,
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write_5m: u64,
    cache_write_1h: u64,
}

/// One session's usage, broken down by model (a session usually has one, but can switch).
#[derive(Serialize)]
pub struct SessionUsage {
    id: String,
    models: Vec<ModelUsage>,
}

/// Locate the transcript file for a session id under any `~/.claude/projects/*` folder.
fn find_session_file(session_id: &str) -> Option<PathBuf> {
    let home = home_dir()?;
    let root = PathBuf::from(home).join(".claude").join("projects");
    let target = format!("{session_id}.jsonl");
    for project in fs::read_dir(&root).ok()?.flatten() {
        let p = project.path().join(&target);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

/// The current-work label for a live Claude pane: the conversation's latest `aiTitle` and the most
/// recent tool it invoked. Lets a pane show *what the agent is doing* — the piece `claude_usage`
/// (tokens) doesn't cover, and which nothing surfaces for a hookless agent. Read from the agent's
/// own transcript, never pane output (opacity-safe, ADR-0001).
#[derive(Serialize, Default, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptLabel {
    /// Claude's own `aiTitle` (latest wins), else the first user prompt; `None` if neither found.
    title: Option<String>,
    /// Name of the most recent assistant `tool_use` block — "what it's doing right now".
    tool: Option<String>,
}

/// Read the last `max_bytes` of a file as lossy UTF-8 lines, dropping the first (partial) line when
/// the window didn't start at byte 0. Bounded so a multi-gigabyte transcript costs the same as a
/// small one — a documented hazard for these files.
fn tail_lines(path: &PathBuf, max_bytes: u64) -> Vec<String> {
    let Ok(mut file) = File::open(path) else {
        return Vec::new();
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(max_bytes);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return Vec::new();
    }
    let mut buf = Vec::new();
    if file.read_to_end(&mut buf).is_err() {
        return Vec::new();
    }
    let mut lines: Vec<String> = String::from_utf8_lossy(&buf)
        .lines()
        .map(str::to_owned)
        .collect();
    if start > 0 && !lines.is_empty() {
        lines.remove(0); // the window cut this line mid-record
    }
    lines
}

/// Fold a transcript's tail into a current-work label: the latest `aiTitle` and the most recent
/// assistant `tool_use`. Pure over the lines, so it's unit-testable without a file.
fn fold_label(lines: &[String]) -> TranscriptLabel {
    let mut label = TranscriptLabel::default();
    for line in lines {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if let Some(t) = v.get("aiTitle").and_then(|x| x.as_str()) {
            if !t.is_empty() {
                label.title = Some(t.chars().take(120).collect());
            }
        }
        if v.get("type").and_then(|t| t.as_str()) == Some("assistant") {
            if let Some(blocks) = v
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_array())
            {
                for b in blocks {
                    if b.get("type").and_then(|t| t.as_str()) == Some("tool_use") {
                        if let Some(name) = b.get("name").and_then(|n| n.as_str()) {
                            label.tool = Some(name.to_string());
                        }
                    }
                }
            }
        }
    }
    label
}

/// The current-work label for a Claude pane by session id. Reads a bounded tail for the latest
/// aiTitle + last tool, falling back to the head's first-prompt title (`extract`) when the tail
/// carries no aiTitle yet. `None` when there's no transcript / nothing to show.
#[tauri::command]
pub fn claude_title(session_id: String) -> Result<Option<TranscriptLabel>, String> {
    let Some(path) = find_session_file(&session_id) else {
        return Ok(None);
    };
    let mut label = fold_label(&tail_lines(&path, 128 * 1024));
    if label.title.is_none() {
        label.title = extract(&path).1; // head fallback: the first user prompt
    }
    if label.title.is_none() && label.tool.is_none() {
        return Ok(None);
    }
    Ok(Some(label))
}

/// Fold a transcript's tail into "everything the agent has said since your last message" — the
/// text you'd want read back to you. Assistant turns arrive as several records (text, a `tool_use`,
/// more text), so we accumulate their `text` blocks and reset the buffer at each real user message,
/// leaving the whole latest reply rather than its final fragment. Sidechain records (subagent
/// chatter) and meta records are skipped — you asked the main agent, not its helpers.
///
/// Pure over the lines, so it's unit-testable without a file (sibling of `fold_label`).
fn fold_last_reply(lines: &[String]) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    for line in lines {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if v.get("isSidechain")
            .and_then(|s| s.as_bool())
            .unwrap_or(false)
        {
            continue; // a subagent's turn, not the reply to you
        }
        match v.get("type").and_then(|t| t.as_str()) {
            Some("user") => {
                // A real user message starts a new turn; tool *results* also arrive typed "user",
                // so only reset on one that carries actual prose.
                if v.get("isMeta").and_then(|m| m.as_bool()).unwrap_or(false) {
                    continue;
                }
                if user_has_prose(&v) {
                    parts.clear();
                }
            }
            Some("assistant") => {
                if let Some(blocks) = v
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_array())
                {
                    for b in blocks {
                        if b.get("type").and_then(|t| t.as_str()) != Some("text") {
                            continue; // skip `thinking` and `tool_use` — not part of the spoken reply
                        }
                        if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
                            let t = t.trim();
                            if !t.is_empty() {
                                parts.push(t.to_string());
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }
    let joined = parts.join("\n\n");
    let joined = joined.trim();
    (!joined.is_empty()).then(|| joined.to_string())
}

/// Does this `user` record carry a typed prompt (rather than a tool result / `<…>` system noise)?
fn user_has_prose(v: &serde_json::Value) -> bool {
    let content = v.get("message").and_then(|m| m.get("content"));
    let text = match content {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(serde_json::Value::Array(blocks)) => blocks
            .iter()
            .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join(" "),
        _ => String::new(),
    };
    let text = text.trim();
    !text.is_empty() && !text.starts_with('<')
}

/// The agent's latest reply in `session_id`, as plain text — what the read-aloud action speaks.
/// Reads a bounded tail of Claude's own transcript, never pane output (ADR-0001 carve-out, same as
/// `claude_title`). `None` when there's no transcript or the agent hasn't said anything yet.
///
/// The tail window is larger than `claude_title`'s: a label only needs the last few records, but a
/// full reply can be long and we'd rather re-read a little than speak half a sentence.
#[tauri::command]
pub fn claude_last_reply(session_id: String) -> Result<Option<String>, String> {
    let Some(path) = find_session_file(&session_id) else {
        return Ok(None);
    };
    Ok(fold_last_reply(&tail_lines(&path, 512 * 1024)))
}

/// Sum token usage per model for each of `session_ids`, reading the on-disk transcripts. Missing
/// sessions are skipped (a pane whose Claude never conversed just has no entry). Used by the Fleet
/// panel's usage HUD. Opacity-safe: reads Claude's own session store, not pane output (ADR-0001).
#[tauri::command]
pub fn claude_usage(session_ids: Vec<String>) -> Result<Vec<SessionUsage>, String> {
    let mut out: Vec<SessionUsage> = Vec::new();
    for id in session_ids {
        let Some(path) = find_session_file(&id) else {
            continue;
        };
        let Ok(file) = File::open(&path) else {
            continue;
        };
        let mut by_model: std::collections::HashMap<String, ModelUsage> =
            std::collections::HashMap::new();
        for line in BufReader::new(file).lines().map_while(Result::ok) {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            let Some(usage) = v.get("message").and_then(|m| m.get("usage")) else {
                continue;
            };
            let model = v
                .get("message")
                .and_then(|m| m.get("model"))
                .and_then(|m| m.as_str())
                .unwrap_or("");
            if model.is_empty() || model == "<synthetic>" {
                continue;
            }
            let g = |k: &str| usage.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
            let e = by_model
                .entry(model.to_string())
                .or_insert_with(|| ModelUsage {
                    model: model.to_string(),
                    ..Default::default()
                });
            e.input += g("input_tokens");
            e.output += g("output_tokens");
            e.cache_read += g("cache_read_input_tokens");
            // Prefer the 5m/1h split (different cache-write prices); fall back to the flat total.
            if let Some(cc) = usage.get("cache_creation") {
                e.cache_write_5m += cc
                    .get("ephemeral_5m_input_tokens")
                    .and_then(|x| x.as_u64())
                    .unwrap_or(0);
                e.cache_write_1h += cc
                    .get("ephemeral_1h_input_tokens")
                    .and_then(|x| x.as_u64())
                    .unwrap_or(0);
            } else {
                e.cache_write_5m += g("cache_creation_input_tokens");
            }
        }
        let mut models: Vec<ModelUsage> = by_model.into_values().collect();
        models.sort_by_key(|m| std::cmp::Reverse(m.output));
        out.push(SessionUsage { id, models });
    }
    Ok(out)
}

/// Whether a Claude conversation transcript exists on disk for `session_id` (any project folder).
/// Lets the launcher pick `--resume` only when there's really something to resume — a session that
/// was pinned via `--session-id` but never conversed in (e.g. blocked at the trust dialog) has no
/// file, so resuming it would fail with "No conversation found". A blank/garbage id is just false.
#[tauri::command]
pub fn claude_session_exists(session_id: String) -> Result<bool, String> {
    if session_id.is_empty() {
        return Ok(false);
    }
    let home = home_dir().ok_or_else(|| "home directory not set".to_string())?;
    let root = PathBuf::from(home).join(".claude").join("projects");
    let project_dirs = match fs::read_dir(&root) {
        Ok(e) => e,
        Err(_) => return Ok(false),
    };
    let target = format!("{session_id}.jsonl");
    for project in project_dirs.flatten() {
        if project.path().join(&target).is_file() {
            return Ok(true);
        }
    }
    Ok(false)
}

/// List resumable Claude sessions under `~/.claude/projects`, newest-modified first (capped). An
/// absent directory (Claude never run) is a normal empty result, not an error.
#[tauri::command]
pub fn list_claude_sessions() -> Result<Vec<ClaudeSession>, String> {
    let home = home_dir().ok_or_else(|| "home directory not set".to_string())?;
    let root = PathBuf::from(home).join(".claude").join("projects");
    let project_dirs = match fs::read_dir(&root) {
        Ok(e) => e,
        Err(_) => return Ok(Vec::new()),
    };
    let mut out: Vec<ClaudeSession> = Vec::new();
    for project in project_dirs.flatten() {
        let dir = project.path();
        if !dir.is_dir() {
            continue;
        }
        let Ok(files) = fs::read_dir(&dir) else {
            continue;
        };
        let decoded = project.file_name().to_string_lossy().into_owned();
        for entry in files.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            if !meta.is_file() {
                continue;
            }
            let id = match path.file_stem().and_then(|s| s.to_str()) {
                Some(s) => s.to_string(),
                None => continue,
            };
            let modified = meta
                .modified()
                .ok()
                .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let (cwd, title) = extract(&path);
            out.push(ClaudeSession {
                id,
                cwd: cwd.unwrap_or_else(|| decode_project_dir(&decoded)),
                title: title.unwrap_or_default(),
                modified,
            });
        }
    }
    out.sort_by_key(|s| std::cmp::Reverse(s.modified));
    out.truncate(200);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(ls: &[&str]) -> Vec<String> {
        ls.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn last_reply_is_the_whole_turn_since_your_message() {
        let l = lines(&[
            r#"{"type":"user","message":{"content":"first question"}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"old answer"}]}}"#,
            r#"{"type":"user","message":{"content":"second question"}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Let me look."}]}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Grep"}]}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Found it."}]}}"#,
        ]);
        // Both halves of the latest turn, and nothing from the previous one.
        assert_eq!(
            fold_last_reply(&l).as_deref(),
            Some("Let me look.\n\nFound it.")
        );
    }

    #[test]
    fn last_reply_skips_thinking_tool_results_meta_and_subagents() {
        let l = lines(&[
            r#"{"type":"user","message":{"content":"go"}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"hmm"},{"type":"text","text":"Working on it."}]}}"#,
            // A tool *result* is typed "user" but carries no prose — it must not reset the turn.
            r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"ok"}]}}"#,
            r#"{"type":"user","isMeta":true,"message":{"content":"system note"}}"#,
            r#"{"type":"assistant","isSidechain":true,"message":{"content":[{"type":"text","text":"subagent chatter"}]}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"All done."}]}}"#,
        ]);
        assert_eq!(
            fold_last_reply(&l).as_deref(),
            Some("Working on it.\n\nAll done.")
        );
    }

    #[test]
    fn last_reply_is_none_when_the_agent_has_not_spoken() {
        assert!(fold_last_reply(&lines(&[])).is_none());
        assert!(
            fold_last_reply(&lines(&[r#"{"type":"user","message":{"content":"hi"}}"#])).is_none()
        );
        // Tool-only turns have nothing speakable in them.
        assert!(fold_last_reply(&lines(&[
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read"}]}}"#
        ]))
        .is_none());
    }

    #[test]
    fn latest_ai_title_wins_and_last_tool_is_taken() {
        let l = lines(&[
            r#"{"type":"ai-title","aiTitle":"Investigating the auth bug"}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"x"},{"type":"tool_use","name":"Grep"}]}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit"}]}}"#,
            r#"{"type":"ai-title","aiTitle":"Refactoring auth middleware"}"#,
        ]);
        let label = fold_label(&l);
        assert_eq!(label.title.as_deref(), Some("Refactoring auth middleware"));
        assert_eq!(label.tool.as_deref(), Some("Edit"));
    }

    #[test]
    fn no_ai_title_leaves_title_none_for_the_head_fallback() {
        let l = lines(&[
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash"}]}}"#,
        ]);
        let label = fold_label(&l);
        assert!(label.title.is_none());
        assert_eq!(label.tool.as_deref(), Some("Bash"));
    }

    #[test]
    fn garbage_and_non_assistant_lines_are_ignored() {
        let l = lines(&[
            "not json",
            r#"{"type":"user","message":{"content":"hi"}}"#,
            r#"{"type":"ai-title","aiTitle":"Working"}"#,
        ]);
        let label = fold_label(&l);
        assert_eq!(label.title.as_deref(), Some("Working"));
        assert!(label.tool.is_none());
    }

    #[test]
    fn tail_lines_drops_the_partial_first_line_when_windowed() {
        let mut path = std::env::temp_dir();
        path.push(format!("loom-title-test-{}.jsonl", std::process::id()));
        // Two whole lines; a tiny window forces start>0 so the first (partial) line is dropped.
        std::fs::write(&path, "AAAAAAAAAA\nBBBBBBBBBB\n").unwrap();
        let got = tail_lines(&path, 12);
        assert_eq!(got, vec!["BBBBBBBBBB".to_string()]);
        let _ = std::fs::remove_file(&path);
    }
}
