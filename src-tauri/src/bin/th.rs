//! `th` — the Termhaus inter-pane control CLI (ADR-0007). Runs *inside* a pane and talks to
//! the running app over the unix socket at `$TERMHAUS_SOCK`, so an agent (or you) can list
//! panes, send text/commands to a named pane, or spawn a new one.
//!
//!   th list                          # show every pane: name, live/dead, workspace
//!   th send Cleo claude "do the thing"   # type into pane "Cleo" and press Enter
//!   th send Cleo --no-enter ls       # type without the trailing newline
//!   th send Cleo                     # no text → reads stdin (pipe-friendly)
//!   th spawn --name Cleo --cwd /repo claude   # open a new pane running `claude`
//!   th read Cleo -n 100              # capture Cleo's last 100 scrollback lines
//!   th broadcast "run the tests"     # send to every live pane in the active workspace
//!   th focus Cleo                    # switch to Cleo's workspace and focus it
//!   th attention                     # light this pane's "needs you" border (clears on focus)
//!   th attention Cleo --clear        # drop pane Cleo's attention border
//!
//! Pure std + serde_json (already a workspace dep): no protocol logic lives here or in Rust —
//! the request is forwarded verbatim to the webview, which owns routing (src/ipc/protocol.ts).

use std::env;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::process::exit;

use serde_json::{json, Value};

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.is_empty() || args[0] == "-h" || args[0] == "--help" {
        usage();
        exit(if args.is_empty() { 2 } else { 0 });
    }
    let req = match build_request(&args) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("th: {e}");
            exit(2);
        }
    };
    let resp = match send(&req) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("th: {e}");
            exit(1);
        }
    };
    handle_response(&args[0], &resp);
}

fn build_request(args: &[String]) -> Result<Value, String> {
    match args[0].as_str() {
        "list" => Ok(json!({ "op": "list" })),

        "send" => {
            // th send <pane> [text...] [--no-enter]; no text → read stdin.
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
                return Err("usage: th send <pane> <text...>  (or pipe text via stdin)".into());
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
            // th spawn [--name N] [--cwd D] <command...>   (use `--` to end flag parsing)
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
                    // (including any dashes), so `th spawn worker claude --resume` works.
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
                return Err("usage: th spawn [--name N] [--cwd D] <command...>".into());
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
            // th read <pane> [-n LINES]   — capture the tail of a pane's scrollback.
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
                return Err("usage: th read <pane> [-n LINES]".into());
            }
            let mut obj = json!({ "op": "read", "target": positional.remove(0) });
            if let Some(n) = lines {
                obj["lines"] = json!(n);
            }
            Ok(obj)
        }

        "broadcast" => {
            // th broadcast [--workspace W] [--no-enter] <text...>   (no text → read stdin)
            let mut enter = true;
            let mut workspace: Option<String> = None;
            let mut positional: Vec<String> = Vec::new();
            let mut i = 1;
            while i < args.len() {
                match args[i].as_str() {
                    "--no-enter" => enter = false,
                    "--workspace" | "-w" => {
                        i += 1;
                        workspace = Some(args.get(i).cloned().ok_or("--workspace needs a value")?);
                    }
                    _ => positional.push(args[i].clone()),
                }
                i += 1;
            }
            let text = if positional.is_empty() {
                read_stdin()?
            } else {
                positional.join(" ")
            };
            let mut obj = json!({ "op": "broadcast", "text": text, "enter": enter });
            if let Some(w) = workspace {
                obj["workspace"] = json!(w);
            }
            Ok(obj)
        }

        "focus" => {
            let target = args.get(1).ok_or("usage: th focus <pane>")?;
            Ok(json!({ "op": "focus", "target": target }))
        }

        "attention" => {
            // th attention [pane] [--clear]   — raise (or drop) a pane's attention border.
            // No pane → the calling pane (from $TERMHAUS_PANE), so an agent can flag itself.
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
                env::var("TERMHAUS_PANE").map_err(|_| {
                    "no pane given and TERMHAUS_PANE not set — name a pane: th attention <pane>"
                        .to_string()
                })?
            } else {
                positional.remove(0)
            };
            Ok(json!({ "op": "attention", "target": target, "clear": clear }))
        }

        other => Err(format!(
            "unknown command '{other}' (try: list, send, spawn, read, broadcast, focus, attention)"
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

/// Connect to the app, write the request as one JSON line, read one JSON response line.
fn send(req: &Value) -> Result<Value, String> {
    let path = env::var("TERMHAUS_SOCK")
        .map_err(|_| "TERMHAUS_SOCK not set — run this inside a Termhaus pane".to_string())?;
    let stream =
        UnixStream::connect(&path).map_err(|e| format!("cannot reach Termhaus at {path}: {e}"))?;
    let mut w = &stream;
    let line = serde_json::to_string(req).map_err(|e| e.to_string())?;
    w.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
    w.write_all(b"\n").map_err(|e| e.to_string())?;
    w.flush().ok();

    let mut reader = BufReader::new(&stream);
    let mut resp = String::new();
    reader.read_line(&mut resp).map_err(|e| e.to_string())?;
    if resp.trim().is_empty() {
        return Err("no response from Termhaus".into());
    }
    serde_json::from_str(resp.trim()).map_err(|e| format!("bad response: {e}"))
}

fn handle_response(op: &str, resp: &Value) {
    if resp.get("ok").and_then(Value::as_bool) != Some(true) {
        let err = resp
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("unknown error");
        eprintln!("th: {err}");
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
            let n = data
                .and_then(|d| d.get("count"))
                .and_then(Value::as_u64)
                .unwrap_or(0);
            println!("sent to {n} pane{}", if n == 1 { "" } else { "s" });
        }
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
        _ => {}
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
        let marker = if focused { "*" } else { " " };
        let status = if live { "live" } else { "dead" };
        println!("{marker} {name:<12} {status:<5} {ws}");
    }
}

fn usage() {
    eprintln!(
        "th — Termhaus inter-pane control\n\
         usage:\n\
        \x20 th list\n\
        \x20 th send <pane> <text...> [--no-enter]\n\
        \x20 th spawn [--name N] [--cwd D] <command...>\n\
        \x20 th read <pane> [-n LINES]\n\
        \x20 th broadcast [--workspace W] [--no-enter] <text...>\n\
        \x20 th focus <pane>\n\
        \x20 th attention [pane] [--clear]"
    );
}
