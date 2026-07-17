//! `loom` — the Loom inter-pane control CLI (ADR-0007). Runs *inside* a pane and talks to
//! the running app over the unix socket at `$LOOM_SOCK`, so an agent (or you) can list
//! panes, send text/commands to a named pane, or spawn a new one.
//!
//!   loom list                          # show every pane: name, live/dead, workspace
//!   loom send Cleo claude "do the thing"   # type into pane "Cleo" and press Enter
//!   loom send Cleo --no-enter ls       # type without the trailing newline
//!   loom send Cleo                     # no text → reads stdin (pipe-friendly)
//!   loom spawn --name Cleo --cwd /repo claude   # open a new pane running `claude`
//!   loom read Cleo -n 100              # capture Cleo's last 100 scrollback lines
//!   loom broadcast "run the tests"     # send to every live pane in the active workspace
//!   loom broadcast --dry-run "…"       # preview which panes it would reach (incl. gated); no send
//!   loom gate Cleo                     # hold Cleo's bus input — send/broadcast needs a human OK
//!   loom gate Cleo --clear             # release the gate; `loom gate --list` shows gated panes
//!   loom focus Cleo                    # switch to Cleo's workspace and focus it
//!   loom attention                     # light this pane's "needs you" border (clears on focus)
//!   loom attention Cleo --clear        # drop pane Cleo's attention border
//!   loom status "running tests"        # set this pane's status label (shown in its title/overview)
//!   loom status Cleo --clear           # clear pane Cleo's status label
//!   loom role reviewer                 # tag this pane's role (a resolvable bus target)
//!   loom role Cleo builder             # tag pane Cleo as the builder; `loom role Cleo --clear` drops it
//!   loom send role:reviewer "take a look"   # target by role — fans out to every reviewer pane
//!   loom hooks --install               # wire a Claude Code agent's events to the Session/Task model
//!   loom hooks                         # print the recommended hooks profile (no changes made)
//!   loom hook <event>                  # internal: a hook pushes one lifecycle op (ADR-0008)
//!
//! Pure std + serde_json (already a workspace dep): no protocol logic lives here or in Rust —
//! the request is forwarded verbatim to the webview, which owns routing (src/ipc/protocol.ts).

use std::env;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::exit;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

// The bus client, shared with the `loom mcp` MCP server (two faces, one bus): `control_sock`
// frames requests over the platform transport (`control_transport`, UDS today). Both live in the
// lib crate now, so we reach them through `crate::` rather than the old `#[path]` bin includes.
use crate::control_sock;

/// Does `cmd` name a control-CLI subcommand? `main.rs` uses this to route `loom <cmd>` to the CLI
/// face; anything else (a bare `loom`, `loom .`, `loom <dir>`, `loom mcp`) is handled elsewhere.
pub fn is_command(cmd: &str) -> bool {
    matches!(
        cmd,
        "list"
            | "send"
            | "spawn"
            | "read"
            | "broadcast"
            | "focus"
            | "attention"
            | "status"
            | "role"
            | "note"
            | "card"
            | "claim"
            | "release"
            | "claims"
            | "hold"
            | "gate"
            | "ask"
            | "reply"
            | "hooks"
            | "hook"
    )
}

/// The control-CLI entry point (`loom <subcommand>`), invoked from `main.rs`.
pub fn run() {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.is_empty() || args[0] == "-h" || args[0] == "--help" {
        usage();
        exit(if args.is_empty() { 2 } else { 0 });
    }
    // `hooks` is a local helper (print/install a Claude Code hooks profile) — no socket round-trip.
    if args[0] == "hooks" {
        match run_hooks(&args[1..]) {
            Ok(msg) => print!("{msg}"),
            Err(e) => {
                eprintln!("loom: {e}");
                exit(1);
            }
        }
        return;
    }
    // `hook <event>` is the internal bridge the installed hooks call: read the hook's JSON on
    // stdin, push the matching ADR-0008 lifecycle op. Fire-and-forget, silent, never fails.
    if args[0] == "hook" {
        run_hook_emit(&args[1..]);
        return;
    }
    // `ask` is the only multi-round-trip command (§2a): it fires one `ask`, then long-polls
    // `ask.await` until the callee replies — so it can't use the single-shot build/send path below.
    if args[0] == "ask" {
        run_ask(&args[1..]);
        return;
    }
    let req = match build_request(&args) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("loom: {e}");
            exit(2);
        }
    };
    let resp = match control_sock::send(&req) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("loom: {e}");
            exit(1);
        }
    };
    handle_response(&args[0], &resp);
}

fn build_request(args: &[String]) -> Result<Value, String> {
    match args[0].as_str() {
        "list" => Ok(json!({ "op": "list" })),

        "send" => {
            // loom send <pane> [text...] [--no-enter]; no text → read stdin.
            let mut enter = true;
            let mut positional: Vec<String> = Vec::new();
            for a in &args[1..] {
                if a == "--no-enter" {
                    enter = false;
                } else {
                    positional.push(a.clone());
                }
            }
            if positional.is_empty() {
                return Err("usage: loom send <pane> <text...>  (or pipe text via stdin)".into());
            }
            let target = positional.remove(0);
            let text = if positional.is_empty() {
                read_stdin()?
            } else {
                positional.join(" ")
            };
            Ok(json!({ "op": "send", "target": target, "text": text, "enter": enter }))
        }

        "spawn" => {
            // loom spawn [--name N] [--cwd D] <command...>   (use `--` to end flag parsing)
            let mut name: Option<String> = None;
            let mut cwd: Option<String> = None;
            let mut command: Vec<String> = Vec::new();
            let mut i = 1;
            while i < args.len() {
                match args[i].as_str() {
                    "--name" => {
                        i += 1;
                        name = Some(args.get(i).cloned().ok_or("--name needs a value")?);
                    }
                    "--cwd" => {
                        i += 1;
                        cwd = Some(args.get(i).cloned().ok_or("--cwd needs a value")?);
                    }
                    "--" => {
                        command.extend_from_slice(&args[i + 1..]);
                        break;
                    }
                    // The first non-flag token starts the command; the rest is taken verbatim
                    // (including any dashes), so `loom spawn worker claude --resume` works.
                    s if command.is_empty() && s.starts_with("--") => {
                        return Err(format!("unknown flag '{s}' (put the command after `--`)"));
                    }
                    _ => {
                        command.extend_from_slice(&args[i..]);
                        break;
                    }
                }
                i += 1;
            }
            let command = command.join(" ");
            if command.trim().is_empty() {
                return Err("usage: loom spawn [--name N] [--cwd D] <command...>".into());
            }
            let mut obj = json!({ "op": "spawn", "command": command });
            if let Some(n) = name {
                obj["name"] = json!(n);
            }
            if let Some(d) = cwd {
                obj["cwd"] = json!(d);
            }
            Ok(obj)
        }

        "read" => {
            // loom read <pane> [-n LINES]   — capture the tail of a pane's scrollback.
            let mut lines: Option<u64> = None;
            let mut positional: Vec<String> = Vec::new();
            let mut i = 1;
            while i < args.len() {
                match args[i].as_str() {
                    "-n" | "--lines" => {
                        i += 1;
                        let v = args.get(i).ok_or("-n needs a value")?;
                        lines = Some(v.parse().map_err(|_| format!("bad line count '{v}'"))?);
                    }
                    _ => positional.push(args[i].clone()),
                }
                i += 1;
            }
            if positional.is_empty() {
                return Err("usage: loom read <pane> [-n LINES]".into());
            }
            let mut obj = json!({ "op": "read", "target": positional.remove(0) });
            if let Some(n) = lines {
                obj["lines"] = json!(n);
            }
            Ok(obj)
        }

        "broadcast" => {
            // loom broadcast [--workspace W] [--no-enter] [--dry-run] <text...>   (no text → stdin)
            // --dry-run reports which panes it would reach (incl. gated ones) without sending.
            let mut enter = true;
            let mut dry_run = false;
            let mut workspace: Option<String> = None;
            let mut positional: Vec<String> = Vec::new();
            let mut i = 1;
            while i < args.len() {
                match args[i].as_str() {
                    "--no-enter" => enter = false,
                    "--dry-run" | "-n" => dry_run = true,
                    "--workspace" | "-w" => {
                        i += 1;
                        workspace = Some(args.get(i).cloned().ok_or("--workspace needs a value")?);
                    }
                    _ => positional.push(args[i].clone()),
                }
                i += 1;
            }
            // A dry run needs no text (an empty preview still shows the reach), so don't block on
            // stdin for it; a real broadcast reads stdin when no text is given.
            let text = if !positional.is_empty() {
                positional.join(" ")
            } else if dry_run {
                String::new()
            } else {
                read_stdin()?
            };
            let mut obj = json!({ "op": "broadcast", "text": text, "enter": enter });
            if dry_run {
                obj["dryRun"] = json!(true);
            }
            if let Some(w) = workspace {
                obj["workspace"] = json!(w);
            }
            Ok(obj)
        }

        "focus" => {
            let target = args.get(1).ok_or("usage: loom focus <pane>")?;
            Ok(json!({ "op": "focus", "target": target }))
        }

        "attention" => {
            // loom attention [pane] [--clear]   — raise (or drop) a pane's attention border.
            // No pane → the calling pane (from $LOOM_PANE), so an agent can flag itself.
            let mut clear = false;
            let mut positional: Vec<String> = Vec::new();
            for a in &args[1..] {
                if a == "--clear" {
                    clear = true;
                } else {
                    positional.push(a.clone());
                }
            }
            let target = if positional.is_empty() {
                env::var("LOOM_PANE").map_err(|_| {
                    "no pane given and LOOM_PANE not set — name a pane: loom attention <pane>"
                        .to_string()
                })?
            } else {
                positional.remove(0)
            };
            Ok(json!({ "op": "attention", "target": target, "clear": clear }))
        }

        "status" => {
            // loom status [pane] [text...|--clear]   — set a pane's short status label.
            // No pane → the calling pane (from $LOOM_PANE), so an agent can label itself.
            // Empty text (or --clear) clears the label. A leading "--" ends flag parsing so a
            // status that starts with a dash still works: loom status -- --resuming.
            let mut clear = false;
            let mut positional: Vec<String> = Vec::new();
            let mut i = 1;
            while i < args.len() {
                match args[i].as_str() {
                    "--clear" => clear = true,
                    "--" => {
                        positional.extend_from_slice(&args[i + 1..]);
                        break;
                    }
                    _ => positional.push(args[i].clone()),
                }
                i += 1;
            }
            // We can't resolve pane names here (Rust is a pure relay), so we use a convention to
            // tell "set my own status" from "set pane X's status", mirroring `loom attention`:
            //   • --clear      → the (optional) lone positional is a pane name, else self.
            //   • one token + a calling pane → that token is the status text for *this* pane.
            //   • two+ tokens  → first is the target pane, the rest is the status text.
            let self_pane = env::var("LOOM_PANE").ok();
            let no_pane = || {
                "no pane given and LOOM_PANE not set — name a pane: loom status <pane> <text>"
                    .to_string()
            };
            let (target, text) = if clear {
                let t = if positional.is_empty() {
                    self_pane.ok_or_else(no_pane)?
                } else {
                    positional.remove(0)
                };
                (t, String::new())
            } else if positional.is_empty() {
                (self_pane.ok_or_else(no_pane)?, String::new())
            } else if let (1, Some(me)) = (positional.len(), self_pane) {
                // One token + a calling pane → that token is *this* pane's status text.
                (me, positional.remove(0))
            } else {
                let t = positional.remove(0);
                (t, positional.join(" "))
            };
            Ok(json!({ "op": "status", "target": target, "text": text }))
        }

        "role" => {
            // loom role [pane] [name|--clear]   — set (or clear) a pane's role (ORCHESTRATION §2).
            // No pane → the calling pane ($LOOM_PANE), so an agent can tag itself. Same self-vs-pane
            // convention as `loom status`: one token + a caller pane → *this* pane's role; two+ →
            // first is the target pane. Other commands then target it with `role:<name>`.
            let mut clear = false;
            let mut positional: Vec<String> = Vec::new();
            for a in &args[1..] {
                if a == "--clear" {
                    clear = true;
                } else {
                    positional.push(a.clone());
                }
            }
            let self_pane = env::var("LOOM_PANE").ok();
            let no_pane = || {
                "no pane given and LOOM_PANE not set — name a pane: loom role <pane> <role>"
                    .to_string()
            };
            let (target, role) = if clear {
                let t = if positional.is_empty() {
                    self_pane.ok_or_else(no_pane)?
                } else {
                    positional.remove(0)
                };
                (t, String::new())
            } else if positional.is_empty() {
                (self_pane.ok_or_else(no_pane)?, String::new())
            } else if let (1, Some(me)) = (positional.len(), self_pane) {
                (me, positional.remove(0))
            } else {
                let t = positional.remove(0);
                (t, positional.join(" "))
            };
            Ok(json!({ "op": "role.set", "target": target, "role": role }))
        }

        "card" => {
            // loom card add <title...>  [--prompt <text>] [--command <cmd>]  — add a To-do card (§1)
            // loom card list                                                 — list cards (id/title/status)
            // loom card move <id> <todo|done|failed>                         — move a card between lanes
            // loom card drain <on|off> [--cap <n>]                           — arm/disarm the auto-drainer
            // Scoped to the caller pane's workspace ($LOOM_PANE), or --workspace <name>.
            if args.len() < 2 {
                return Err("card needs a subcommand: add | list | move | drain".to_string());
            }
            let action = args[1].clone();
            let mut workspace: Option<String> = None;
            let mut prompt: Option<String> = None;
            let mut command: Option<String> = None;
            let mut cap: Option<i64> = None;
            let mut rest: Vec<String> = Vec::new();
            let mut i = 2;
            while i < args.len() {
                match args[i].as_str() {
                    "--workspace" | "-w" => {
                        i += 1;
                        workspace = Some(args.get(i).ok_or("--workspace needs a name")?.clone());
                    }
                    "--prompt" | "-p" => {
                        i += 1;
                        prompt = Some(args.get(i).ok_or("--prompt needs text")?.clone());
                    }
                    "--command" | "-c" => {
                        i += 1;
                        command = Some(args.get(i).ok_or("--command needs a value")?.clone());
                    }
                    "--cap" => {
                        i += 1;
                        cap = Some(
                            args.get(i)
                                .ok_or("--cap needs a number")?
                                .parse()
                                .map_err(|_| "--cap must be a number")?,
                        );
                    }
                    "--" => {
                        rest.extend_from_slice(&args[i + 1..]);
                        break;
                    }
                    _ => rest.push(args[i].clone()),
                }
                i += 1;
            }
            let mut obj = match action.as_str() {
                "add" => {
                    if rest.is_empty() {
                        return Err("card add needs a title: loom card add <title>".to_string());
                    }
                    let mut o = json!({ "op": "card.add", "title": rest.join(" ") });
                    if let Some(p) = prompt {
                        o["prompt"] = json!(p);
                    }
                    if let Some(c) = command {
                        o["command"] = json!(c);
                    }
                    o
                }
                "list" | "ls" => json!({ "op": "card.list" }),
                "move" | "mv" => {
                    if rest.len() < 2 {
                        return Err(
                            "card move needs: loom card move <id> <todo|done|failed>".to_string()
                        );
                    }
                    let status = rest[1].clone();
                    if !matches!(status.as_str(), "todo" | "done" | "failed") {
                        return Err("card move status must be todo | done | failed".to_string());
                    }
                    json!({ "op": "card.move", "id": rest[0].clone(), "status": status })
                }
                "drain" => {
                    let on = match rest.first().map(String::as_str) {
                        Some("on") | Some("start") => true,
                        Some("off") | Some("stop") => false,
                        _ => return Err("card drain needs: loom card drain <on|off> [--cap <n>]".to_string()),
                    };
                    let mut o = json!({ "op": "card.drain", "on": on });
                    if let Some(c) = cap {
                        o["cap"] = json!(c);
                    }
                    o
                }
                other => {
                    return Err(format!(
                        "unknown card subcommand '{other}' (add | list | move | drain)"
                    ))
                }
            };
            if let Ok(pane) = env::var("LOOM_PANE") {
                obj["pane"] = json!(pane);
            }
            if let Some(w) = workspace {
                obj["workspace"] = json!(w);
            }
            Ok(obj)
        }

        "note" => {
            // loom note set <key> <value...>   — post to the workspace blackboard (§2b)
            // loom note get <key>              — read one entry
            // loom note list                   — dump the whole board
            // loom note del <key>              — remove one entry
            // Scoped to the caller pane's workspace ($LOOM_PANE), or --workspace <name>.
            if args.len() < 2 {
                return Err("note needs a subcommand: set | get | list | del".to_string());
            }
            let action = args[1].clone();
            // Pull an optional --workspace/-w out of the tail; a leading "--" ends flag parsing so
            // a value that starts with a dash still works (loom note set k -- --flagish).
            let mut workspace: Option<String> = None;
            let mut rest: Vec<String> = Vec::new();
            let mut i = 2;
            while i < args.len() {
                match args[i].as_str() {
                    "--workspace" | "-w" => {
                        i += 1;
                        workspace = Some(
                            args.get(i)
                                .ok_or("--workspace needs a name")?
                                .clone(),
                        );
                    }
                    "--" => {
                        rest.extend_from_slice(&args[i + 1..]);
                        break;
                    }
                    _ => rest.push(args[i].clone()),
                }
                i += 1;
            }
            let mut obj = match action.as_str() {
                "set" => {
                    if rest.is_empty() {
                        return Err("note set needs a key: loom note set <key> <value>".to_string());
                    }
                    let key = rest.remove(0);
                    let value = rest.join(" ");
                    json!({ "op": "note.set", "key": key, "value": value })
                }
                "get" => {
                    let key = rest
                        .into_iter()
                        .next()
                        .ok_or("note get needs a key: loom note get <key>")?;
                    json!({ "op": "note.get", "key": key })
                }
                "list" | "ls" => json!({ "op": "note.list" }),
                "del" | "rm" => {
                    let key = rest
                        .into_iter()
                        .next()
                        .ok_or("note del needs a key: loom note del <key>")?;
                    json!({ "op": "note.del", "key": key })
                }
                other => {
                    return Err(format!(
                        "unknown note subcommand '{other}' (set | get | list | del)"
                    ))
                }
            };
            // The caller pane (from $LOOM_PANE) scopes to its workspace and is recorded as writer.
            if let Ok(pane) = env::var("LOOM_PANE") {
                obj["pane"] = json!(pane);
            }
            if let Some(w) = workspace {
                obj["workspace"] = json!(w);
            }
            Ok(obj)
        }

        "claim" | "release" | "claims" | "hold" => {
            // loom claim <path> [--workspace W]                 — take an advisory lock (§2c)
            // loom release <path> [--force] [--workspace W]     — drop your lock (--force: any)
            // loom claims [--workspace W]                       — list the workspace's locks
            // loom hold <path> [--workspace W]                  — gate a path (§3); release to clear
            // The caller pane ($LOOM_PANE) is the holder identity for claim/release/hold.
            let op = args[0].as_str();
            let mut workspace: Option<String> = None;
            let mut force = false;
            let mut positional: Vec<String> = Vec::new();
            let mut i = 1;
            while i < args.len() {
                match args[i].as_str() {
                    "--workspace" | "-w" => {
                        i += 1;
                        workspace = Some(args.get(i).ok_or("--workspace needs a name")?.clone());
                    }
                    "--force" if op == "release" => force = true,
                    "--" => {
                        positional.extend_from_slice(&args[i + 1..]);
                        break;
                    }
                    _ => positional.push(args[i].clone()),
                }
                i += 1;
            }
            let mut obj = if op == "claims" {
                json!({ "op": "claims" })
            } else {
                let path = positional
                    .into_iter()
                    .next()
                    .ok_or_else(|| format!("{op} needs a path: loom {op} <path>"))?;
                let mut o = json!({ "op": op, "path": path });
                if force {
                    o["force"] = json!(true);
                }
                o
            };
            if let Ok(pane) = env::var("LOOM_PANE") {
                obj["pane"] = json!(pane);
            }
            if let Some(w) = workspace {
                obj["workspace"] = json!(w);
            }
            Ok(obj)
        }

        "gate" => {
            // loom gate [pane] [--reason R]   — hold this (or a named) pane's bus input (§4a)
            // loom gate [pane] --clear        — release the gate
            // loom gate --list                — list gated panes
            // No pane → the calling pane ($LOOM_PANE), so an agent can gate itself.
            let mut clear = false;
            let mut list = false;
            let mut reason: Option<String> = None;
            let mut positional: Vec<String> = Vec::new();
            let mut i = 1;
            while i < args.len() {
                match args[i].as_str() {
                    "--clear" => clear = true,
                    "--list" | "-l" => list = true,
                    "--reason" | "-r" => {
                        i += 1;
                        reason = Some(args.get(i).ok_or("--reason needs text")?.clone());
                    }
                    "--" => {
                        positional.extend_from_slice(&args[i + 1..]);
                        break;
                    }
                    _ => positional.push(args[i].clone()),
                }
                i += 1;
            }
            if list {
                return Ok(json!({ "op": "gate.list" }));
            }
            let target = if positional.is_empty() {
                env::var("LOOM_PANE").map_err(|_| {
                    "no pane given and LOOM_PANE not set — name a pane: loom gate <pane>".to_string()
                })?
            } else {
                positional.remove(0)
            };
            let mut obj = json!({ "op": "gate.set", "target": target, "on": !clear });
            if let Some(r) = reason {
                obj["reason"] = json!(r);
            }
            Ok(obj)
        }

        "reply" => {
            // loom reply <id> <answer...>   — answer an ask you were sent (§2a).
            // The id comes from the `[loom ask #N …]` prompt that was typed into this pane.
            if args.len() < 2 {
                return Err("reply needs an ask id: loom reply <id> <answer>".to_string());
            }
            let id: u64 = args[1]
                .parse()
                .map_err(|_| format!("'{}' is not an ask id (a number)", args[1]))?;
            let answer = args[2..].join(" ");
            let mut obj = json!({ "op": "reply", "id": id, "answer": answer });
            if let Ok(pane) = env::var("LOOM_PANE") {
                obj["from"] = json!(pane);
            }
            Ok(obj)
        }

        other => Err(format!(
            "unknown command '{other}' (try: list, send, spawn, read, broadcast, focus, attention, status, note, claim, release, claims, gate, ask, reply)"
        )),
    }
}

fn read_stdin() -> Result<String, String> {
    let mut buf = String::new();
    std::io::stdin()
        .read_to_string(&mut buf)
        .map_err(|e| e.to_string())?;
    Ok(buf)
}

fn handle_response(op: &str, resp: &Value) {
    if resp.get("ok").and_then(Value::as_bool) != Some(true) {
        let err = resp
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("unknown error");
        eprintln!("loom: {err}");
        exit(1);
    }
    let data = resp.get("data");
    match op {
        "list" => print_list(data),
        "send" => {
            let n = data
                .and_then(|d| d.get("count"))
                .and_then(Value::as_u64)
                .unwrap_or(0);
            println!("sent to {n} pane{}", if n == 1 { "" } else { "s" });
            print_skipped(data);
        }
        "spawn" => {
            let name = data
                .and_then(|d| d.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("?");
            println!("spawned pane '{name}'");
        }
        "read" => {
            let text = data
                .and_then(|d| d.get("text"))
                .and_then(Value::as_str)
                .unwrap_or("");
            println!("{text}");
        }
        "broadcast" => {
            // A dry run carries a `targets` preview instead of a delivery count.
            if let Some(targets) = data
                .and_then(|d| d.get("targets"))
                .and_then(Value::as_array)
            {
                print_broadcast_dry_run(data, targets);
            } else {
                let n = data
                    .and_then(|d| d.get("count"))
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                println!("sent to {n} pane{}", if n == 1 { "" } else { "s" });
                print_skipped(data);
            }
        }
        "gate" => print_gate(data),
        "focus" => {
            let name = data
                .and_then(|d| d.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("?");
            println!("focused pane '{name}'");
        }
        "attention" => {
            let name = data
                .and_then(|d| d.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("?");
            let cleared = data
                .and_then(|d| d.get("cleared"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            println!(
                "attention {} '{name}'",
                if cleared { "cleared on" } else { "raised on" }
            );
        }
        "status" => {
            let name = data
                .and_then(|d| d.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("?");
            let cleared = data
                .and_then(|d| d.get("cleared"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if cleared {
                println!("status cleared on '{name}'");
            } else {
                let text = data
                    .and_then(|d| d.get("text"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                println!("status of '{name}' → {text}");
            }
        }
        "role" => {
            let name = data
                .and_then(|d| d.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("?");
            let cleared = data
                .and_then(|d| d.get("cleared"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if cleared {
                println!("role cleared on '{name}'");
            } else {
                let role = data
                    .and_then(|d| d.get("role"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                println!("role of '{name}' → {role}");
            }
        }
        "note" => {
            let action = data
                .and_then(|d| d.get("action"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let key = || {
                data.and_then(|d| d.get("key"))
                    .and_then(Value::as_str)
                    .unwrap_or("?")
            };
            match action {
                "set" => println!("noted '{}'", key()),
                "del" => println!("deleted '{}'", key()),
                "get" => {
                    let value = data
                        .and_then(|d| d.get("value"))
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    println!("{value}");
                }
                "list" => print_notes(data),
                _ => {}
            }
        }
        "claim" => {
            let path = data
                .and_then(|d| d.get("path"))
                .and_then(Value::as_str)
                .unwrap_or("?");
            let fresh = data
                .and_then(|d| d.get("fresh"))
                .and_then(Value::as_bool)
                .unwrap_or(true);
            if fresh {
                println!("claimed '{path}'");
            } else {
                println!("already yours: '{path}'");
            }
        }
        "release" => {
            let path = data
                .and_then(|d| d.get("path"))
                .and_then(Value::as_str)
                .unwrap_or("?");
            println!("released '{path}'");
        }
        "hold" => {
            let path = data
                .and_then(|d| d.get("path"))
                .and_then(Value::as_str)
                .unwrap_or("?");
            let fresh = data
                .and_then(|d| d.get("fresh"))
                .and_then(Value::as_bool)
                .unwrap_or(true);
            if fresh {
                println!(
                    "held '{path}' — an agent's claim on it will block until you `loom release` it"
                );
            } else {
                println!("already held: '{path}'");
            }
        }
        "card" => {
            // card.add → { id, title }; card.list → { cards: [{id,title,status}] }; card.move → { id, status }
            if let Some(list) = data.and_then(|d| d.get("cards")).and_then(Value::as_array) {
                if list.is_empty() {
                    println!("(no cards)");
                }
                for c in list {
                    let get = |k| c.get(k).and_then(Value::as_str).unwrap_or("?");
                    println!("{:<10} {:<8} {}", get("id"), get("status"), get("title"));
                }
            } else if let Some(draining) = data
                .and_then(|d| d.get("draining"))
                .and_then(Value::as_bool)
            {
                let cap = data
                    .and_then(|d| d.get("cap"))
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                if draining {
                    println!("auto-drain on (cap {cap})");
                } else {
                    println!("auto-drain off");
                }
            } else if let Some(status) = data.and_then(|d| d.get("status")).and_then(Value::as_str)
            {
                let id = data
                    .and_then(|d| d.get("id"))
                    .and_then(Value::as_str)
                    .unwrap_or("?");
                println!("moved {id} → {status}");
            } else {
                let id = data
                    .and_then(|d| d.get("id"))
                    .and_then(Value::as_str)
                    .unwrap_or("?");
                let title = data
                    .and_then(|d| d.get("title"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                println!("added {id}: {title}");
            }
        }
        "claims" => print_claims(data),
        "reply" => {
            let id = data
                .and_then(|d| d.get("id"))
                .and_then(Value::as_u64)
                .unwrap_or(0);
            println!("replied to ask #{id}");
        }
        _ => {}
    }
}

/// Pretty-print a `claims` board: `path   (held by pane)`, one per line, aligned.
fn print_claims(data: Option<&Value>) {
    let Some(arr) = data
        .and_then(|d| d.get("entries"))
        .and_then(Value::as_array)
    else {
        return;
    };
    if arr.is_empty() {
        println!("(no claims)");
        return;
    }
    for e in arr {
        let path = e.get("path").and_then(Value::as_str).unwrap_or("?");
        let by = e.get("by").and_then(Value::as_str).unwrap_or("");
        let gated = e.get("held").and_then(Value::as_bool).unwrap_or(false);
        if gated {
            println!("{path:<32} ⛔ GATED (held for approval; release to clear)");
        } else {
            println!("{path:<32} (locked by {by})");
        }
    }
}

/// Note how many gated panes a send/broadcast skipped (operator declined the gate, §4a).
fn print_skipped(data: Option<&Value>) {
    let skipped = data
        .and_then(|d| d.get("skipped"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if skipped > 0 {
        println!(
            "(skipped {skipped} gated pane{})",
            if skipped == 1 { "" } else { "s" }
        );
    }
}

/// Pretty-print a `loom gate` result: a set/clear on one pane, or the `--list` roster.
fn print_gate(data: Option<&Value>) {
    if let Some(arr) = data
        .and_then(|d| d.get("entries"))
        .and_then(Value::as_array)
    {
        if arr.is_empty() {
            println!("(no gated panes)");
            return;
        }
        for e in arr {
            let name = e.get("name").and_then(Value::as_str).unwrap_or("?");
            let by = e.get("by").and_then(Value::as_str).unwrap_or("");
            let reason = e.get("reason").and_then(Value::as_str).unwrap_or("");
            if reason.is_empty() {
                println!("🔒 {name:<16} (held by {by})");
            } else {
                println!("🔒 {name:<16} (held by {by}) — {reason}");
            }
        }
        return;
    }
    let name = data
        .and_then(|d| d.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("?");
    let gated = data
        .and_then(|d| d.get("gated"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if gated {
        println!(
            "gated '{name}' — bus input now needs an OK (loom gate {name} --clear to release)"
        );
    } else {
        println!("released gate on '{name}'");
    }
}

/// Pretty-print a `loom broadcast --dry-run` preview: the panes the fan-out would reach, marking
/// dead and gated ones, then the text it would type.
fn print_broadcast_dry_run(data: Option<&Value>, targets: &[Value]) {
    let n = targets.len();
    println!(
        "dry run — broadcast would reach {n} pane{}:",
        if n == 1 { "" } else { "s" }
    );
    for t in targets {
        let name = t.get("name").and_then(Value::as_str).unwrap_or("?");
        let live = t.get("live").and_then(Value::as_bool).unwrap_or(false);
        let gated = t.get("gated").and_then(Value::as_bool).unwrap_or(false);
        let status = if !live {
            "dead"
        } else if gated {
            "gated (needs OK)"
        } else {
            "live"
        };
        let marker = if gated { "🔒" } else { "  " };
        println!("{marker} {name:<16} {status}");
    }
    let text = data
        .and_then(|d| d.get("text"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if !text.is_empty() {
        println!("text: {text}");
    }
}

// ---- `loom ask <pane> <question>` — request/response RPC (§2a) ----
//
// The one multi-round-trip command: fire one `ask` (returns a correlation id), then long-poll
// `ask.await` in <10s slices — under the relay's parked-connection cap — until the callee runs
// `loom reply <id> <answer>`. Prints the answer on success; exits non-zero on timeout so
// `answer=$(loom ask Cleo "…") || handle_no_answer` scripts cleanly.
fn run_ask(args: &[String]) {
    let mut timeout_s: u64 = 300;
    let mut positional: Vec<String> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--timeout" | "-t" => {
                i += 1;
                timeout_s = match args.get(i).and_then(|s| s.parse().ok()) {
                    Some(n) if n > 0 => n,
                    _ => {
                        eprintln!("loom: --timeout needs a positive number of seconds");
                        exit(2);
                    }
                };
            }
            "--" => {
                positional.extend_from_slice(&args[i + 1..]);
                break;
            }
            _ => positional.push(args[i].clone()),
        }
        i += 1;
    }
    if positional.is_empty() {
        eprintln!("loom: ask needs a pane: loom ask <pane> <question>");
        exit(2);
    }
    let target = positional.remove(0);
    if positional.is_empty() {
        eprintln!("loom: ask needs a question: loom ask <pane> <question>");
        exit(2);
    }
    let question = positional.join(" ");

    // 1. Fire the ask; the frontend types the question into `target` and hands back an id.
    let mut ask_req = json!({
        "op": "ask",
        "target": target,
        "question": question,
        "timeoutMs": timeout_s.saturating_mul(1000),
    });
    if let Ok(pane) = env::var("LOOM_PANE") {
        ask_req["from"] = json!(pane);
    }
    let resp = match control_sock::send(&ask_req) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("loom: {e}");
            exit(1);
        }
    };
    if resp.get("ok").and_then(Value::as_bool) != Some(true) {
        let err = resp
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("ask failed");
        eprintln!("loom: {err}");
        exit(1);
    }
    let id = resp
        .pointer("/data/id")
        .and_then(Value::as_u64)
        .unwrap_or(0);

    // 2. Long-poll for the reply until the deadline.
    let deadline = Instant::now() + Duration::from_secs(timeout_s);
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            eprintln!("loom: ask #{id} to '{target}' timed out after {timeout_s}s");
            exit(1);
        }
        let wait_ms = remaining.as_millis().min(8000) as u64;
        let await_req = json!({ "op": "ask.await", "id": id, "waitMs": wait_ms });
        let r = match control_sock::send(&await_req) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("loom: {e}");
                exit(1);
            }
        };
        match r.pointer("/data/state").and_then(Value::as_str) {
            Some("answered") => {
                let answer = r
                    .pointer("/data/answer")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                println!("{answer}");
                return;
            }
            Some("pending") => {
                // No reply yet — a brief pause keeps a hot loop from hammering the socket if the
                // frontend returns quickly, then poll again.
                thread::sleep(Duration::from_millis(200));
            }
            other => {
                // "expired", "unknown", or a malformed reply — the ask is gone.
                eprintln!(
                    "loom: ask #{id} to '{target}' ended without an answer ({})",
                    other.unwrap_or("no state")
                );
                exit(1);
            }
        }
    }
}

/// Pretty-print a `note list` board: `key   value  (by)`, one per line, aligned.
fn print_notes(data: Option<&Value>) {
    let Some(arr) = data
        .and_then(|d| d.get("entries"))
        .and_then(Value::as_array)
    else {
        return;
    };
    if arr.is_empty() {
        println!("(board empty)");
        return;
    }
    for e in arr {
        let key = e.get("key").and_then(Value::as_str).unwrap_or("?");
        let value = e.get("value").and_then(Value::as_str).unwrap_or("");
        let by = e.get("by").and_then(Value::as_str).unwrap_or("");
        println!("{key:<20} {value}  ({by})");
    }
}

fn print_list(data: Option<&Value>) {
    let Some(arr) = data.and_then(Value::as_array) else {
        return;
    };
    if arr.is_empty() {
        println!("(no panes)");
        return;
    }
    for p in arr {
        let name = p.get("name").and_then(Value::as_str).unwrap_or("?");
        let ws = p.get("workspace").and_then(Value::as_str).unwrap_or("");
        let live = p.get("live").and_then(Value::as_bool).unwrap_or(false);
        let focused = p.get("focused").and_then(Value::as_bool).unwrap_or(false);
        let attention = p.get("attention").and_then(Value::as_bool).unwrap_or(false);
        // Focus wins the marker column; else flag a pane that has raised "needs you" (P0c).
        let marker = if focused {
            "*"
        } else if attention {
            "!"
        } else {
            " "
        };
        let live_col = if live { "live" } else { "dead" };
        let role = p.get("role").and_then(Value::as_str).unwrap_or("");
        let rolecol = if role.is_empty() {
            String::new()
        } else {
            format!("  [{role}]")
        };
        // The agent-pushed status label, when set — the fleet-dashboard bit (P0c).
        let status = p.get("status").and_then(Value::as_str).unwrap_or("");
        let statuscol = if status.is_empty() {
            String::new()
        } else {
            format!("  — {status}")
        };
        println!("{marker} {name:<12} {live_col:<5} {ws}{rolecol}{statuscol}");
    }
}

// ---- `loom hooks` — bridge a Claude Code agent's lifecycle to the control bus (ADR-0007/0008) ----
//
// The agent *pushes* its own state through the channel we already built, no output parsing
// (ADR-0001): each Claude Code hook fires `loom hook <event>`, which reads the hook's JSON payload
// and pushes the matching Session/Task/Approval op (ADR-0008). `loom hooks --install` writes the
// profile; `run_hook_emit` is the runtime bridge. The coarse attention/status floor is driven from
// the same ops frontend-side, so this fully supersedes the old coarse-only profile.

/// The recommended hook entries, as (event, entry) pairs. Each entry is one Claude Code hook
/// matcher-group with a single command — the internal `loom hook <event>` bridge, which reads the
/// hook's JSON payload and pushes the matching ADR-0008 lifecycle op (Session/Task/Approval). The
/// bridge also drives the coarse `attention`/`status` floor frontend-side, so installing these
/// fully supersedes the old coarse-only profile. `PostToolUse` is scoped to the file-editing tools
/// (the only ones carrying a `file_path` to attribute to a Task).
fn hook_profile() -> Vec<(&'static str, Value)> {
    let cmd = |c: &str| json!({ "hooks": [ { "type": "command", "command": c } ] });
    let matched = |m: &str, c: &str| json!({ "matcher": m, "hooks": [ { "type": "command", "command": c } ] });
    vec![
        // A run begins (or --resume → a new Session). Carries session_id + cwd.
        ("SessionStart", cmd("loom hook session-start")),
        // You submit a prompt → a new Task titled with the prompt.
        ("UserPromptSubmit", cmd("loom hook prompt")),
        // A file-editing tool ran → attribute the touched file to the current Task.
        (
            "PostToolUse",
            matched("Edit|Write|MultiEdit|NotebookEdit", "loom hook post-tool"),
        ),
        // Claude needs input / permission → the Task blocks on you (the rich Approval + the border).
        ("Notification", matched("", "loom hook notification")),
        // Turn finished → the Task ends, the Session goes idle.
        ("Stop", cmd("loom hook stop")),
        // The run ended → close the Session.
        ("SessionEnd", cmd("loom hook session-end")),
    ]
}

/// `loom hook <event>` — the bridge the installed Claude Code hooks call. Reads the hook's JSON
/// payload from stdin and pushes the matching ADR-0008 lifecycle op over the control bus.
///
/// Three hard rules, because a hook must never disrupt the agent: (1) **silent on stdout** —
/// Claude feeds some hooks' stdout (e.g. `UserPromptSubmit`) into the model's context, so we print
/// nothing there; (2) **always exit 0** — bad JSON, no socket, no match are all clean no-ops; and
/// (3) **only act inside Loom** — if `LOOM_PANE`/`LOOM_SOCK` are unset this `claude` isn't ours, so
/// we do nothing (the same hooks can be installed globally and stay inert outside Loom).
fn run_hook_emit(args: &[String]) {
    let Some(event) = args.first() else { return };
    let Ok(pane) = env::var("LOOM_PANE") else {
        return;
    };
    if env::var("LOOM_SOCK").is_err() {
        return;
    }

    let payload: Value = read_stdin()
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({}));
    let get = |k: &str| payload.get(k).and_then(Value::as_str).unwrap_or("");

    let req = match event.as_str() {
        "session-start" => {
            let mut o = json!({ "op": "session.start", "target": pane, "agent": "claude" });
            let sid = get("session_id");
            if !sid.is_empty() {
                o["sessionId"] = json!(sid);
            }
            let cwd = get("cwd");
            if !cwd.is_empty() {
                o["cwd"] = json!(cwd);
            }
            o
        }
        "session-end" => json!({ "op": "session.end", "target": pane, "outcome": "done" }),
        "prompt" => json!({ "op": "task.begin", "target": pane, "title": get("prompt") }),
        "post-tool" => {
            // Only the file-editing tools carry a `file_path`; nothing to attribute otherwise.
            let file = payload
                .get("tool_input")
                .and_then(|t| t.get("file_path"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if file.is_empty() {
                return;
            }
            json!({ "op": "task.update", "target": pane, "files": [file] })
        }
        "notification" => {
            let msg = get("message");
            let kind = if msg.to_lowercase().contains("permission") {
                "permission"
            } else {
                "question"
            };
            json!({ "op": "approval.request", "target": pane, "prompt": msg, "kind": kind })
        }
        "stop" => json!({ "op": "task.end", "target": pane, "outcome": "done" }),
        _ => return,
    };
    // Best-effort: drop the reply and any transport error — a hook never reports failure upward.
    let _ = control_sock::send(&req);
}

/// The profile as a full `{ "hooks": { … } }` settings fragment (what `loom hooks` prints).
fn profile_value() -> Value {
    let mut hooks = serde_json::Map::new();
    for (event, entry) in hook_profile() {
        hooks
            .entry(event.to_string())
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .expect("hook event value is an array")
            .push(entry);
    }
    json!({ "hooks": Value::Object(hooks) })
}

/// The single `command` string inside a hook entry (our entries each carry exactly one).
fn entry_command(entry: &Value) -> Option<&str> {
    entry.get("hooks")?.get(0)?.get("command")?.as_str()
}

/// Does an existing hook group already carry `cmd` (so install stays idempotent)?
fn group_has_command(group: &Value, cmd: &str) -> bool {
    group
        .get("hooks")
        .and_then(Value::as_array)
        .is_some_and(|hs| {
            hs.iter()
                .any(|h| h.get("command").and_then(Value::as_str) == Some(cmd))
        })
}

/// The user's home dir for locating `~/.claude/settings.json`: `$HOME` on Unix, `%USERPROFILE%`
/// on Windows (mirrors `pty::home_dir`). Claude Code uses `~/.claude` on every platform.
#[cfg(unix)]
fn home_dir() -> Option<String> {
    env::var("HOME").ok()
}

#[cfg(windows)]
fn home_dir() -> Option<String> {
    env::var("USERPROFILE").ok()
}

fn run_hooks(args: &[String]) -> Result<String, String> {
    let mut install = false;
    let mut scope_user = false;
    for a in args {
        match a.as_str() {
            "--print" => install = false,
            "--install" => install = true,
            "--user" | "-u" => scope_user = true,
            "--project" | "-p" => scope_user = false,
            other => {
                return Err(format!(
                "unknown flag '{other}' (usage: loom hooks [--print] | --install [--user|--project])"
            ))
            }
        }
    }

    if !install {
        let mut out = serde_json::to_string_pretty(&profile_value()).map_err(|e| e.to_string())?;
        out.push('\n');
        return Ok(out);
    }

    let path = if scope_user {
        let home = home_dir().ok_or_else(|| "home directory not set".to_string())?;
        PathBuf::from(home).join(".claude/settings.json")
    } else {
        let base = env::var("CLAUDE_PROJECT_DIR")
            .map(PathBuf::from)
            .or_else(|_| env::current_dir())
            .map_err(|e| format!("cannot resolve project dir: {e}"))?;
        base.join(".claude/settings.json")
    };
    install_hooks(&path)
}

/// Merge the profile into a Claude Code settings file, creating it if absent. Idempotent: a hook
/// whose command is already present under its event is left alone, so re-running is safe.
fn install_hooks(path: &Path) -> Result<String, String> {
    let mut root: Value = if path.exists() {
        let s =
            fs::read_to_string(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
        if s.trim().is_empty() {
            json!({})
        } else {
            serde_json::from_str(&s)
                .map_err(|e| format!("{} is not valid JSON: {e}", path.display()))?
        }
    } else {
        json!({})
    };

    let obj = root
        .as_object_mut()
        .ok_or_else(|| format!("{} is not a JSON object", path.display()))?;
    let hooks = obj.entry("hooks").or_insert_with(|| json!({}));
    let hooks = hooks
        .as_object_mut()
        .ok_or("\"hooks\" in settings is not an object")?;

    let mut added = 0;
    let mut skipped = 0;
    for (event, entry) in hook_profile() {
        let cmd = entry_command(&entry).unwrap_or("").to_string();
        let arr = hooks.entry(event.to_string()).or_insert_with(|| json!([]));
        let arr = arr
            .as_array_mut()
            .ok_or_else(|| format!("hooks.{event} in settings is not an array"))?;
        if arr.iter().any(|g| group_has_command(g, &cmd)) {
            skipped += 1;
        } else {
            arr.push(entry);
            added += 1;
        }
    }

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
    let mut pretty = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    pretty.push('\n');
    fs::write(path, pretty).map_err(|e| format!("cannot write {}: {e}", path.display()))?;

    Ok(format!(
        "hooks installed in {} ({added} added, {skipped} already present)\nrestart `claude` (or run /hooks) for it to pick them up\n",
        path.display()
    ))
}

fn usage() {
    eprintln!(
        "loom — Loom inter-pane control\n\
         usage:\n\
        \x20 loom list\n\
        \x20 loom send <pane> <text...> [--no-enter]\n\
        \x20 loom spawn [--name N] [--cwd D] <command...>\n\
        \x20 loom read <pane> [-n LINES]\n\
        \x20 loom broadcast [--workspace W] [--no-enter] <text...>\n\
        \x20 loom focus <pane>\n\
        \x20 loom attention [pane] [--clear]\n\
        \x20 loom status [pane] <text...> | [pane] --clear\n\
        \x20 loom note set <key> <value...> | get <key> | list | del <key>  [--workspace W]\n\
        \x20 loom claim <path> | release <path> [--force] | claims  [--workspace W]\n\
        \x20 loom gate [pane] [--reason R] | [pane] --clear | --list\n\
        \x20 loom broadcast --dry-run [text...]   (preview the fan-out; no send)\n\
        \x20 loom ask <pane> <question...> [--timeout S]\n\
        \x20 loom reply <id> <answer...>\n\
        \x20 loom hooks [--print] | --install [--user|--project]"
    );
}
