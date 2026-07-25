//! `loom doctor` — a diagnostic face of the binary. Every Loom integration point (the control bus,
//! Claude hooks, the transcript store, the process floor) fails silently and, from the outside,
//! identically: the fleet panel is empty and nobody knows why. This turns each into one command.
//!
//! std + serde_json only, like `cli.rs`/`mcp.rs` — it returns before any Tauri/WebKitGTK setup, so
//! an agent can run `loom doctor --json` from inside its own pane to check (and later repair) its
//! own integration. Reuses the bus client (`control_sock`/`control_transport`) for the reachability
//! check; every other check is a cheap env/filesystem read.

use std::env;
use std::path::PathBuf;
use std::process::exit;
use std::time::Instant;

use serde_json::{json, Value};

use crate::{control_sock, control_transport};

/// A check's outcome. `Fail` sets the process exit code to 1 (so scripts/CI can gate on it); `Warn`
/// is a heads-up that doesn't fail the run (e.g. "not inside a pane" is normal on the CLI).
#[derive(Clone, Copy, PartialEq)]
enum Level {
    Ok,
    Warn,
    Fail,
}

impl Level {
    fn glyph(self) -> &'static str {
        match self {
            Level::Ok => "✓",
            Level::Warn => "⚠",
            Level::Fail => "✗",
        }
    }
    fn word(self) -> &'static str {
        match self {
            Level::Ok => "ok",
            Level::Warn => "warn",
            Level::Fail => "fail",
        }
    }
}

struct Check {
    name: &'static str,
    level: Level,
    detail: String,
    /// One-line fix, shown under a non-ok check. A check without a remedy is just informational.
    remedy: Option<String>,
}

impl Check {
    fn ok(name: &'static str, detail: impl Into<String>) -> Self {
        Self {
            name,
            level: Level::Ok,
            detail: detail.into(),
            remedy: None,
        }
    }
    fn warn(name: &'static str, detail: impl Into<String>, remedy: impl Into<String>) -> Self {
        Self {
            name,
            level: Level::Warn,
            detail: detail.into(),
            remedy: Some(remedy.into()),
        }
    }
    fn fail(name: &'static str, detail: impl Into<String>, remedy: impl Into<String>) -> Self {
        Self {
            name,
            level: Level::Fail,
            detail: detail.into(),
            remedy: Some(remedy.into()),
        }
    }
}

#[cfg(unix)]
fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME").map(PathBuf::from)
}
#[cfg(windows)]
fn home_dir() -> Option<PathBuf> {
    env::var_os("USERPROFILE").map(PathBuf::from)
}

/// Does a Claude `settings.json` value wire any hook command to `loom`? Pure, so it's unit-tested
/// against fixtures. Walks `hooks.<Event>[].hooks[].command` looking for the `loom` program word.
fn hooks_reference_loom(settings: &Value) -> bool {
    let Some(hooks) = settings.get("hooks").and_then(|h| h.as_object()) else {
        return false;
    };
    for matchers in hooks.values() {
        let Some(matchers) = matchers.as_array() else {
            continue;
        };
        for m in matchers {
            let Some(inner) = m.get("hooks").and_then(|h| h.as_array()) else {
                continue;
            };
            for h in inner {
                if let Some(cmd) = h.get("command").and_then(|c| c.as_str()) {
                    if command_runs_loom(cmd) {
                        return true;
                    }
                }
            }
        }
    }
    false
}

/// Whether a hook command line actually invokes the `loom` program (not merely mentions the word,
/// e.g. a path like `/home/loom-user/x`). Matches `loom` bounded by start/whitespace and end/space.
fn command_runs_loom(cmd: &str) -> bool {
    cmd.split(|c: char| c.is_whitespace() || c == '&' || c == '|' || c == ';')
        .any(|tok| {
            let prog = tok.rsplit(['/', '\\']).next().unwrap_or(tok);
            prog == "loom" || prog == "loom.exe"
        })
}

/// Does a Claude config value register a `loom` MCP server anywhere? Pure + tested. Walks the value
/// looking for any `mcpServers` object with a `loom` key — which covers both `~/.claude.json`'s
/// top-level `mcpServers` and its per-project `projects.<path>.mcpServers`, plus a `.mcp.json`.
fn config_has_loom_mcp(v: &Value) -> bool {
    match v {
        Value::Object(map) => {
            if let Some(servers) = map.get("mcpServers").and_then(|s| s.as_object()) {
                if servers.contains_key("loom") {
                    return true;
                }
            }
            map.values().any(config_has_loom_mcp)
        }
        Value::Array(arr) => arr.iter().any(config_has_loom_mcp),
        _ => false,
    }
}

/// The floor kind for the current platform (both work now — Unix pgrp, Windows process-tree walk).
fn platform_floor() -> &'static str {
    #[cfg(windows)]
    {
        "Windows — process-tree walk (ConPTY has no pgrp)"
    }
    #[cfg(unix)]
    {
        "Unix — foreground process-group"
    }
    #[cfg(not(any(windows, unix)))]
    {
        "unknown platform"
    }
}

fn check_binary() -> Check {
    let ver = env!("CARGO_PKG_VERSION");
    match env::var("LOOM_BIN") {
        Ok(bin) if !bin.is_empty() => Check::ok("binary", format!("loom {ver} — $LOOM_BIN={bin}")),
        _ => Check::ok(
            "binary",
            format!("loom {ver} — $LOOM_BIN unset (fine outside a pane)"),
        ),
    }
}

fn check_bus() -> Check {
    let addr = control_transport::endpoint();
    let env_set = env::var("LOOM_SOCK")
        .map(|s| !s.is_empty())
        .unwrap_or(false);
    if !control_transport::probe_alive(&addr) {
        return Check::warn(
            "bus",
            format!("no running Loom on the bus ({addr})"),
            if env_set {
                "start Loom (the app owns the socket); a stale socket clears on next launch"
            } else {
                "start Loom, or run `loom doctor` from inside a pane so $LOOM_SOCK is set"
            },
        );
    }
    // Reachable — do a real round-trip and time it.
    let t = Instant::now();
    match control_sock::send(&json!({ "op": "list" })) {
        Ok(resp) => {
            let ms = t.elapsed().as_millis();
            let panes = resp
                .get("panes")
                .and_then(|p| p.as_array())
                .map(|a| a.len());
            match panes {
                Some(n) => Check::ok("bus", format!("reachable — {n} pane(s), {ms}ms round-trip")),
                None => Check::ok("bus", format!("reachable — {ms}ms round-trip")),
            }
        }
        Err(e) => Check::fail(
            "bus",
            format!("socket alive but the request failed: {e}"),
            "check the Loom version matches this binary; restart Loom",
        ),
    }
}

fn check_pane() -> Check {
    match env::var("LOOM_PANE") {
        Ok(p) if !p.is_empty() => Check::ok("pane", format!("inside pane '{p}'")),
        _ => Check::warn(
            "pane",
            "not running inside a Loom pane",
            "run this from a pane so an agent can address others (LOOM_PANE is set there)",
        ),
    }
}

fn check_claude_hooks() -> Check {
    let Some(home) = home_dir() else {
        return Check::warn(
            "claude-hooks",
            "home directory not set",
            "set $HOME / %USERPROFILE%",
        );
    };
    let path = home.join(".claude").join("settings.json");
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Check::warn(
            "claude-hooks",
            "no ~/.claude/settings.json",
            "install Loom's Claude hooks so panes self-report — see `loom hooks`",
        );
    };
    let Ok(v) = serde_json::from_str::<Value>(&text) else {
        return Check::warn(
            "claude-hooks",
            "~/.claude/settings.json isn't valid JSON",
            "fix the file, then re-check — see `loom hooks`",
        );
    };
    if hooks_reference_loom(&v) {
        Check::ok(
            "claude-hooks",
            "loom hooks installed in ~/.claude/settings.json",
        )
    } else {
        Check::warn(
            "claude-hooks",
            "settings.json has no loom hooks (Claude panes won't self-report state)",
            "run `loom hooks --install` to wire them in",
        )
    }
}

fn check_transcripts() -> Check {
    let Some(home) = home_dir() else {
        return Check::warn(
            "transcripts",
            "home directory not set",
            "set $HOME / %USERPROFILE%",
        );
    };
    let dir = home.join(".claude").join("projects");
    if dir.is_dir() {
        Check::ok(
            "transcripts",
            "~/.claude/projects readable (usage + current-work captions)",
        )
    } else {
        Check::warn(
            "transcripts",
            "no ~/.claude/projects yet",
            "run Claude Code at least once; a nested launch may need CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1",
        )
    }
}

fn check_platform() -> Check {
    Check::ok(
        "platform",
        format!("{} · floor: {}", std::env::consts::OS, platform_floor()),
    )
}

fn check_mcp() -> Check {
    // Registered either in ~/.claude.json (`claude mcp add`, user or per-project scope) or a
    // project-root .mcp.json. A hit in either means the model can call loom's tools.
    let mut found = false;
    if let Some(home) = home_dir() {
        if let Ok(text) = std::fs::read_to_string(home.join(".claude.json")) {
            if let Ok(v) = serde_json::from_str::<Value>(&text) {
                found = config_has_loom_mcp(&v);
            }
        }
    }
    if !found {
        if let Ok(text) = std::fs::read_to_string(".mcp.json") {
            if let Ok(v) = serde_json::from_str::<Value>(&text) {
                found = config_has_loom_mcp(&v);
            }
        }
    }
    if found {
        Check::ok(
            "mcp",
            "loom MCP server registered (model-native tools available)",
        )
    } else {
        Check::warn(
            "mcp",
            "loom MCP server not registered (the model can't call loom's tools)",
            "run `claude mcp add --transport stdio loom -- loom mcp` in a pane, or add a .mcp.json",
        )
    }
}

/// WSL heads-up (Windows only; `wsl_distros` is empty elsewhere, so this returns `None`). A WSL2
/// pane is a Linux process in a separate VM: it can't open the Windows named pipe `$LOOM_SOCK`
/// points at, and Loom doesn't propagate its env across the boundary — so `loom` (the bus, hooks,
/// MCP) doesn't work *inside* a WSL pane. Worth surfacing for a Windows user running agents there.
fn check_wsl() -> Option<Check> {
    let distros = crate::pty::wsl_distros();
    if distros.is_empty() {
        return None; // no WSL / not Windows — nothing to report
    }
    Some(Check::warn(
        "wsl",
        format!(
            "{} WSL distro(s) — the loom bus doesn't reach inside a WSL pane",
            distros.len()
        ),
        "an agent in a WSL pane can't drive the fleet; run agents in a native Windows pane for full loom integration",
    ))
}

fn run_checks() -> Vec<Check> {
    let mut checks = vec![
        check_binary(),
        check_platform(),
        check_bus(),
        check_pane(),
        check_claude_hooks(),
        check_mcp(),
        check_transcripts(),
    ];
    if let Some(wsl) = check_wsl() {
        checks.push(wsl);
    }
    checks
}

fn print_human(checks: &[Check]) {
    println!("loom doctor");
    for c in checks {
        println!("  {} {:<14} {}", c.level.glyph(), c.name, c.detail);
        if c.level != Level::Ok {
            if let Some(r) = &c.remedy {
                println!("      → {r}");
            }
        }
    }
    let fails = checks.iter().filter(|c| c.level == Level::Fail).count();
    let warns = checks.iter().filter(|c| c.level == Level::Warn).count();
    if fails == 0 && warns == 0 {
        println!("\nall good.");
    } else {
        println!("\n{fails} fail, {warns} warn.");
    }
}

fn print_json(checks: &[Check]) {
    let arr: Vec<Value> = checks
        .iter()
        .map(|c| {
            json!({
                "name": c.name,
                "level": c.level.word(),
                "detail": c.detail,
                "remedy": c.remedy,
            })
        })
        .collect();
    let out = json!({
        "ok": checks.iter().all(|c| c.level != Level::Fail),
        "checks": arr,
    });
    println!("{out}");
}

/// The `loom doctor` entry point, dispatched from `main.rs`. Prints the report (human or `--json`)
/// and exits 1 if any check failed, 0 otherwise.
pub fn run() {
    let json_mode = env::args().any(|a| a == "--json");
    let checks = run_checks();
    if json_mode {
        print_json(&checks);
    } else {
        print_human(&checks);
    }
    let failed = checks.iter().any(|c| c.level == Level::Fail);
    exit(i32::from(failed));
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn command_runs_loom_matches_the_program_word_only() {
        assert!(command_runs_loom("loom attention"));
        assert!(command_runs_loom("loom attention 2>/dev/null || true"));
        assert!(command_runs_loom("/usr/bin/loom status running"));
        assert!(command_runs_loom("loom.exe attention"));
        // A mention that isn't the program word must not match.
        assert!(!command_runs_loom("echo loomweaver"));
        assert!(!command_runs_loom("/home/loom-user/bin/other"));
        assert!(!command_runs_loom("claude --resume abc"));
    }

    #[test]
    fn hooks_reference_loom_detects_a_wired_hook() {
        let settings = json!({
            "hooks": {
                "Stop": [{ "hooks": [{ "type": "command", "command": "loom attention 2>/dev/null || true" }] }],
                "Notification": [{ "hooks": [{ "type": "command", "command": "loom attention" }] }]
            }
        });
        assert!(hooks_reference_loom(&settings));
    }

    #[test]
    fn hooks_reference_loom_false_when_absent_or_unrelated() {
        assert!(!hooks_reference_loom(&json!({})));
        assert!(!hooks_reference_loom(&json!({ "hooks": {} })));
        let other = json!({
            "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "echo done" }] }] }
        });
        assert!(!hooks_reference_loom(&other));
    }

    #[test]
    fn json_and_word_render() {
        assert_eq!(Level::Ok.word(), "ok");
        assert_eq!(Level::Fail.glyph(), "✗");
    }

    #[test]
    fn mcp_detected_at_top_level() {
        let v = json!({ "mcpServers": { "loom": { "command": "loom", "args": ["mcp"] } } });
        assert!(config_has_loom_mcp(&v));
    }

    #[test]
    fn mcp_detected_nested_under_a_project() {
        // ~/.claude.json stores per-project servers under projects.<path>.mcpServers.
        let v = json!({
            "projects": {
                "/home/dev/proj": { "mcpServers": { "loom": { "command": "loom" } } }
            }
        });
        assert!(config_has_loom_mcp(&v));
    }

    #[test]
    fn mcp_false_when_absent_or_other_server() {
        assert!(!config_has_loom_mcp(&json!({})));
        assert!(!config_has_loom_mcp(&json!({ "mcpServers": {} })));
        assert!(!config_has_loom_mcp(
            &json!({ "mcpServers": { "other": { "command": "x" } } })
        ));
    }
}
