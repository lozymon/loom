//! `loom mcp` — a Model Context Protocol server exposing the Loom control bus (ADR-0007) as
//! agent *tools*. It's the model-native face of the same relay the `loom` CLI drives: each tool
//! builds the identical `ControlRequest` JSON and sends it over `$LOOM_SOCK`, so the agent can
//! "spawn a pane", "broadcast to a group", or "flag myself blocked" as first-class tools instead
//! of shelling out (IDEAS.md's agent-integration arc, step C). No protocol logic lives here — the
//! webview owns routing (src/ipc/protocol.ts); we only translate MCP ⇄ the bus.
//!
//! Transport: newline-delimited JSON-RPC 2.0 over stdio (MCP stdio). stdout carries protocol
//! messages ONLY — anything diagnostic goes to stderr (the same byte-protocol discipline as the
//! PTY output channel). Pure std + serde_json; the socket client is shared with `loom`.

use std::env;
use std::io::{self, BufRead, Write};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

// The bus client, shared with the `loom` CLI (two faces, one bus): `control_sock` frames requests
// over the platform transport (`control_transport`, UDS today). Both live in the lib crate now, so
// we reach them through `crate::` rather than the old `#[path]` bin includes.
use crate::control_sock;

/// The MCP-server entry point (`loom mcp`), invoked from `main.rs`. Speaks JSON-RPC 2.0 over stdio.
pub fn run() {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut out = stdout.lock();

    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let msg: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            // Malformed JSON on the wire → JSON-RPC parse error (id unknown → null).
            Err(e) => {
                write_msg(
                    &mut out,
                    &rpc_error(Value::Null, -32700, &format!("parse error: {e}")),
                );
                continue;
            }
        };

        // A message with no `id` is a notification (initialized/cancelled/…) — never answered.
        let Some(id) = msg.get("id").cloned() else {
            continue;
        };
        let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
        let reply = handle_request(method, msg.get("params"), id);
        write_msg(&mut out, &reply);
    }
}

fn handle_request(method: &str, params: Option<&Value>, id: Value) -> Value {
    match method {
        "initialize" => rpc_result(id, initialize_result(params)),
        "ping" => rpc_result(id, json!({})),
        "tools/list" => rpc_result(id, json!({ "tools": tools() })),
        "tools/call" => {
            let Some(name) = params.and_then(|p| p.get("name")).and_then(Value::as_str) else {
                return rpc_error(id, -32602, "tools/call missing \"name\"");
            };
            let empty = json!({});
            let args = params
                .and_then(|p| p.get("arguments"))
                .filter(|a| a.is_object())
                .unwrap_or(&empty);
            let result = match call_tool(name, args) {
                Ok(resp) => control_to_result(&resp),
                Err(msg) => tool_error(&msg),
            };
            rpc_result(id, result)
        }
        other => rpc_error(id, -32601, &format!("method not found: {other}")),
    }
}

fn initialize_result(params: Option<&Value>) -> Value {
    // Echo the client's requested protocol version (we're version-agnostic — a pure proxy), so the
    // negotiated version always matches; fall back to a known-good one if the client omitted it.
    let pv = params
        .and_then(|p| p.get("protocolVersion"))
        .and_then(Value::as_str)
        .unwrap_or("2025-06-18");
    json!({
        "protocolVersion": pv,
        "capabilities": { "tools": {} },
        "serverInfo": { "name": "loom", "version": env!("CARGO_PKG_VERSION") },
        "instructions": "Drive a fleet of Loom terminal panes: list/spawn/focus panes, send \
            text or broadcast to many at once, read a pane's scrollback, and flag your own pane's \
            attention/status so the UI lights up. Panes are addressed by their display name (e.g. \
            \"Cleo\"). attention/status default to your own pane when no target is given. \
            Coordinate with other agents: a shared per-workspace blackboard (board_set/get/list/del) \
            for plan state and who-owns-what; advisory file locks (claim_file/release_file/list_claims) \
            so two agents don't edit the same file; and ask_pane, which asks another pane a question \
            and blocks until its agent answers with reply_ask (a callable-worker RPC)."
    })
}

/// The tool catalogue — one per control-bus op, each with a JSON-Schema for its arguments.
fn tools() -> Value {
    json!([
        {
            "name": "list_panes",
            "description": "List every pane: name, workspace, whether it's focused, and whether its process is live.",
            "inputSchema": { "type": "object", "properties": {}, "required": [] }
        },
        {
            "name": "send_text",
            "description": "Type text into one pane (addressed by name) and press Enter by default.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "target": { "type": "string", "description": "Pane display name, e.g. \"Cleo\"." },
                    "text": { "type": "string", "description": "Text to type into the pane." },
                    "enter": { "type": "boolean", "description": "Press Enter after the text (default true)." }
                },
                "required": ["target", "text"]
            }
        },
        {
            "name": "spawn_pane",
            "description": "Open a new pane running a command (e.g. another agent), optionally named and in a cwd.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "command": { "type": "string", "description": "Command line to run in the new pane." },
                    "name": { "type": "string", "description": "Optional display name for the pane." },
                    "cwd": { "type": "string", "description": "Optional working directory." }
                },
                "required": ["command"]
            }
        },
        {
            "name": "read_pane",
            "description": "Read the tail of a pane's scrollback (an explicit, requested read — not output scraping).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "target": { "type": "string", "description": "Pane display name." },
                    "lines": { "type": "integer", "description": "How many trailing lines (default 50, max 2000)." }
                },
                "required": ["target"]
            }
        },
        {
            "name": "broadcast",
            "description": "Send the same text to every live pane in a workspace (the active one, or a named one).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "text": { "type": "string", "description": "Text to send to every targeted pane." },
                    "enter": { "type": "boolean", "description": "Press Enter after the text (default true)." },
                    "workspace": { "type": "string", "description": "Workspace name (default: the active workspace)." }
                },
                "required": ["text"]
            }
        },
        {
            "name": "focus_pane",
            "description": "Reveal and focus a pane by name, switching to its workspace.",
            "inputSchema": {
                "type": "object",
                "properties": { "target": { "type": "string", "description": "Pane display name." } },
                "required": ["target"]
            }
        },
        {
            "name": "flag_attention",
            "description": "Raise (or, with clear=true, drop) a pane's amber \"needs you\" border. Defaults to your own pane.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "target": { "type": "string", "description": "Pane name (default: your own pane, $LOOM_PANE)." },
                    "clear": { "type": "boolean", "description": "Clear the flag instead of raising it." }
                },
                "required": []
            }
        },
        {
            "name": "set_status",
            "description": "Set a pane's short status label (shown in its title bar and overview tile). Empty text clears it. Defaults to your own pane.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "target": { "type": "string", "description": "Pane name (default: your own pane, $LOOM_PANE)." },
                    "text": { "type": "string", "description": "Status text, e.g. \"running tests\" (omit/empty to clear)." }
                },
                "required": []
            }
        },
        {
            "name": "board_set",
            "description": "Post a key on the shared per-workspace blackboard (plan state, who-owns-what, a discovered gotcha). Other panes read it with board_get/board_list.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "key": { "type": "string", "description": "Board key, e.g. \"plan.api\"." },
                    "value": { "type": "string", "description": "Value to store (opaque text)." },
                    "workspace": { "type": "string", "description": "Workspace name (default: your pane's workspace)." }
                },
                "required": ["key", "value"]
            }
        },
        {
            "name": "board_get",
            "description": "Read one key from the shared per-workspace blackboard (value, who wrote it, when).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "key": { "type": "string", "description": "Board key to read." },
                    "workspace": { "type": "string", "description": "Workspace name (default: your pane's workspace)." }
                },
                "required": ["key"]
            }
        },
        {
            "name": "board_list",
            "description": "Dump the whole shared blackboard for a workspace (every key, value, and writer).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "workspace": { "type": "string", "description": "Workspace name (default: your pane's workspace)." }
                },
                "required": []
            }
        },
        {
            "name": "board_del",
            "description": "Remove one key from the shared per-workspace blackboard.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "key": { "type": "string", "description": "Board key to remove." },
                    "workspace": { "type": "string", "description": "Workspace name (default: your pane's workspace)." }
                },
                "required": ["key"]
            }
        },
        {
            "name": "card_add",
            "description": "Add a task card to the project's task board (stored in .loom/board.json). Use to hand a unit of work to the fleet: a title, an optional prompt to run, and the agent command. Returns the new card id.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": "Short task title." },
                    "prompt": { "type": "string", "description": "The instruction to run when the card is dispatched (optional)." },
                    "command": { "type": "string", "description": "Agent command to launch, e.g. \"claude\" (default: claude)." },
                    "workspace": { "type": "string", "description": "Workspace name (default: your pane's workspace)." }
                },
                "required": ["title"]
            }
        },
        {
            "name": "card_list",
            "description": "List the project's task-board cards (id, title, status: todo|dispatched|done|failed).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "workspace": { "type": "string", "description": "Workspace name (default: your pane's workspace)." }
                }
            }
        },
        {
            "name": "card_move",
            "description": "Move a task-board card between lanes — e.g. mark your own card done when finished. Status is one of todo | done | failed.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Card id (from card_list/card_add)." },
                    "status": { "type": "string", "enum": ["todo", "done", "failed"], "description": "Target lane." },
                    "workspace": { "type": "string", "description": "Workspace name (default: your pane's workspace)." }
                },
                "required": ["id", "status"]
            }
        },
        {
            "name": "claim_file",
            "description": "Take a cooperative advisory lock on a file path so no other pane edits it at the same time. Fails if another pane already holds it (check before editing shared files).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "File path to claim, e.g. \"src/auth.ts\"." },
                    "workspace": { "type": "string", "description": "Workspace name (default: your pane's workspace)." }
                },
                "required": ["path"]
            }
        },
        {
            "name": "release_file",
            "description": "Release a file claim you hold. Use force=true to clear another pane's stale lock.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "File path to release." },
                    "force": { "type": "boolean", "description": "Clear the lock even if another pane holds it (default false)." },
                    "workspace": { "type": "string", "description": "Workspace name (default: your pane's workspace)." }
                },
                "required": ["path"]
            }
        },
        {
            "name": "list_claims",
            "description": "List every file claim in a workspace and which pane holds each.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "workspace": { "type": "string", "description": "Workspace name (default: your pane's workspace)." }
                },
                "required": []
            }
        },
        {
            "name": "ask_pane",
            "description": "Ask another pane's agent a question and BLOCK until it answers (with reply_ask). Returns the answer text. A callable-worker RPC — use it to delegate a decision or query to another agent.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "target": { "type": "string", "description": "Pane to ask, by display name." },
                    "question": { "type": "string", "description": "The question to put to that pane's agent." },
                    "timeout_ms": { "type": "integer", "description": "How long to wait for an answer, in ms (default 300000)." }
                },
                "required": ["target", "question"]
            }
        },
        {
            "name": "reply_ask",
            "description": "Answer a question another pane sent you via ask_pane. The id is shown in the \"[loom ask #N …]\" prompt that appeared in your pane.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "integer", "description": "The ask id from the \"[loom ask #N …]\" prompt." },
                    "answer": { "type": "string", "description": "Your answer." }
                },
                "required": ["id", "answer"]
            }
        }
    ])
}

/// Dispatch a named tool: build its control request and send it over the bus. `ask_pane` is the one
/// multi-round-trip tool (it long-polls for the reply) so it's handled specially; every other tool
/// maps 1:1 to a request built by `build_request`. `Err` is a tool-level failure (bad args or no
/// socket) → surfaced to the model as `isError`.
fn call_tool(name: &str, args: &Value) -> Result<Value, String> {
    let pane = self_pane();
    if name == "ask_pane" {
        return ask_and_wait(args, pane.as_deref());
    }
    let req = build_request(name, args, pane.as_deref())?;
    control_sock::send(&req)
}

/// Translate a tool call into its control-bus `ControlRequest` JSON. Pure (no socket, no env) — the
/// caller pane is passed in as `pane` — so it's unit-testable. Coordination tools scope to the
/// caller pane's workspace (and record it as writer/holder) unless an explicit `workspace` is given.
fn build_request(name: &str, args: &Value, pane: Option<&str>) -> Result<Value, String> {
    let req = match name {
        "list_panes" => json!({ "op": "list" }),
        "send_text" => json!({
            "op": "send",
            "target": arg_str(args, "target")?,
            "text": arg_str(args, "text")?,
            "enter": arg_bool(args, "enter", true),
        }),
        "spawn_pane" => {
            let mut obj = json!({ "op": "spawn", "command": arg_str(args, "command")? });
            if let Some(n) = arg_opt(args, "name") {
                obj["name"] = json!(n);
            }
            if let Some(d) = arg_opt(args, "cwd") {
                obj["cwd"] = json!(d);
            }
            obj
        }
        "read_pane" => {
            let mut obj = json!({ "op": "read", "target": arg_str(args, "target")? });
            if let Some(n) = args.get("lines").and_then(Value::as_u64) {
                obj["lines"] = json!(n);
            }
            obj
        }
        "broadcast" => {
            let mut obj = json!({
                "op": "broadcast",
                "text": arg_str(args, "text")?,
                "enter": arg_bool(args, "enter", true),
            });
            if let Some(w) = arg_opt(args, "workspace") {
                obj["workspace"] = json!(w);
            }
            obj
        }
        "focus_pane" => json!({ "op": "focus", "target": arg_str(args, "target")? }),
        "flag_attention" => json!({
            "op": "attention",
            "target": arg_target_or_self(args, pane)?,
            "clear": arg_bool(args, "clear", false),
        }),
        "set_status" => json!({
            "op": "status",
            "target": arg_target_or_self(args, pane)?,
            "text": args.get("text").and_then(Value::as_str).unwrap_or(""),
        }),
        // ---- Coordination (§2b/2c/2a) — scoped to the caller pane's workspace via `pane`. ----
        "board_set" => with_scope(
            json!({ "op": "note.set", "key": arg_str(args, "key")?, "value": arg_str_allow_empty(args, "value") }),
            args,
            pane,
        ),
        "board_get" => with_scope(
            json!({ "op": "note.get", "key": arg_str(args, "key")? }),
            args,
            pane,
        ),
        "board_list" => with_scope(json!({ "op": "note.list" }), args, pane),
        "board_del" => with_scope(
            json!({ "op": "note.del", "key": arg_str(args, "key")? }),
            args,
            pane,
        ),
        // ---- Task board (§1) ----
        "card_add" => {
            let mut o = json!({ "op": "card.add", "title": arg_str(args, "title")? });
            if let Some(p) = args.get("prompt").and_then(Value::as_str) {
                o["prompt"] = json!(p);
            }
            if let Some(c) = args.get("command").and_then(Value::as_str) {
                o["command"] = json!(c);
            }
            with_scope(o, args, pane)
        }
        "card_list" => with_scope(json!({ "op": "card.list" }), args, pane),
        "card_move" => with_scope(
            json!({ "op": "card.move", "id": arg_str(args, "id")?, "status": arg_str(args, "status")? }),
            args,
            pane,
        ),
        "claim_file" => with_scope(
            json!({ "op": "claim", "path": arg_str(args, "path")? }),
            args,
            pane,
        ),
        "release_file" => with_scope(
            json!({ "op": "release", "path": arg_str(args, "path")?, "force": arg_bool(args, "force", false) }),
            args,
            pane,
        ),
        "list_claims" => with_scope(json!({ "op": "claims" }), args, pane),
        "reply_ask" => {
            let mut obj = json!({ "op": "reply", "id": arg_u64(args, "id")?, "answer": arg_str_allow_empty(args, "answer") });
            if let Some(p) = pane {
                obj["from"] = json!(p);
            }
            obj
        }
        other => return Err(format!("unknown tool '{other}'")),
    };
    Ok(req)
}

/// Add the caller pane (workspace scope + writer/holder identity) and an optional explicit
/// `workspace` override to a coordination request.
fn with_scope(mut obj: Value, args: &Value, pane: Option<&str>) -> Value {
    if let Some(p) = pane {
        obj["pane"] = json!(p);
    }
    if let Some(w) = arg_opt(args, "workspace") {
        obj["workspace"] = json!(w);
    }
    obj
}

/// `ask_pane`: fire the ask, then long-poll `ask.await` (in <10s slices, under the relay's parked-
/// connection cap) until the callee runs `reply_ask` or the ask expires — mirroring the `loom ask`
/// CLI. Blocks the tool call for up to `timeout_ms`. On success returns a synthetic ok response
/// carrying the answer; on timeout/expiry returns `Err` (surfaced as an `isError` tool result).
fn ask_and_wait(args: &Value, pane: Option<&str>) -> Result<Value, String> {
    let target = arg_str(args, "target")?;
    let question = arg_str(args, "question")?;
    let timeout_ms = args
        .get("timeout_ms")
        .and_then(Value::as_u64)
        .unwrap_or(300_000)
        .clamp(1_000, 3_600_000);

    let mut ask_req =
        json!({ "op": "ask", "target": target, "question": question, "timeoutMs": timeout_ms });
    if let Some(p) = pane {
        ask_req["from"] = json!(p);
    }
    let resp = control_sock::send(&ask_req)?;
    if resp.get("ok").and_then(Value::as_bool) != Some(true) {
        return Ok(resp); // surface the ask error (unknown pane, not live) via control_to_result
    }
    let id = resp
        .pointer("/data/id")
        .and_then(Value::as_u64)
        .unwrap_or(0);

    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(format!("ask #{id} to '{target}' timed out"));
        }
        let wait_ms = (remaining.as_millis() as u64).min(8_000);
        let r = control_sock::send(&json!({ "op": "ask.await", "id": id, "waitMs": wait_ms }))?;
        match r.pointer("/data/state").and_then(Value::as_str) {
            Some("answered") => {
                let answer = r
                    .pointer("/data/answer")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let mut data = json!({ "id": id, "answer": answer });
                if let Some(by) = r.pointer("/data/by").and_then(Value::as_str) {
                    data["by"] = json!(by);
                }
                return Ok(json!({ "ok": true, "data": data }));
            }
            Some("pending") => thread::sleep(Duration::from_millis(200)),
            other => {
                return Err(format!(
                    "ask #{id} to '{target}' ended without an answer ({})",
                    other.unwrap_or("no state")
                ))
            }
        }
    }
}

/// A required string argument (non-empty).
fn arg_str(args: &Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("missing required argument \"{key}\""))
}

/// A string argument that may be empty (e.g. a board value or a cleared reply). Missing → "".
fn arg_str_allow_empty(args: &Value, key: &str) -> String {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
        .to_string()
}

/// A required non-negative integer argument (e.g. an ask id).
fn arg_u64(args: &Value, key: &str) -> Result<u64, String> {
    args.get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("missing required integer argument \"{key}\""))
}

/// The caller's own pane from `$LOOM_PANE` (the MCP server runs as a child of the pane's process),
/// or None outside a pane. Scopes coordination tools and identifies the writer/holder/asker.
fn self_pane() -> Option<String> {
    env::var("LOOM_PANE").ok().filter(|s| !s.is_empty())
}

/// An optional, non-empty string argument.
fn arg_opt(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn arg_bool(args: &Value, key: &str, default: bool) -> bool {
    args.get(key).and_then(Value::as_bool).unwrap_or(default)
}

/// A pane target, defaulting to the caller's own pane (`pane`, from $LOOM_PANE) — lets an agent
/// flag itself. `pane` is passed in (not read here) so the builder stays pure and testable.
fn arg_target_or_self(args: &Value, pane: Option<&str>) -> Result<String, String> {
    if let Some(t) = arg_opt(args, "target") {
        return Ok(t);
    }
    pane.filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "no \"target\" given and LOOM_PANE not set — name a pane".to_string())
}

/// Map a control-bus response (`{ok, data|error}`) to an MCP `tools/call` result.
fn control_to_result(resp: &Value) -> Value {
    if resp.get("ok").and_then(Value::as_bool) == Some(true) {
        let text = match resp.get("data") {
            Some(d) => serde_json::to_string_pretty(d).unwrap_or_else(|_| "ok".to_string()),
            None => "ok".to_string(),
        };
        json!({ "content": [ { "type": "text", "text": text } ], "isError": false })
    } else {
        let err = resp
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("unknown error");
        tool_error(err)
    }
}

fn tool_error(msg: &str) -> Value {
    json!({ "content": [ { "type": "text", "text": msg } ], "isError": true })
}

fn rpc_result(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// Write one JSON-RPC message as a single line to stdout (the MCP stdio framing) and flush.
fn write_msg(out: &mut impl Write, msg: &Value) {
    let line = serde_json::to_string(msg).unwrap_or_else(|_| "{}".to_string());
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
}

#[cfg(test)]
mod tests {
    use super::build_request;
    use serde_json::json;

    #[test]
    fn every_advertised_tool_builds_a_request() {
        // tools/list must not advertise a tool build_request can't map — that would 500 the model.
        // ask_pane is intentionally excluded (multi-round-trip, handled outside build_request).
        let cases = [
            ("list_panes", json!({})),
            ("send_text", json!({ "target": "Cleo", "text": "hi" })),
            ("spawn_pane", json!({ "command": "claude" })),
            ("read_pane", json!({ "target": "Cleo" })),
            ("broadcast", json!({ "text": "go" })),
            ("focus_pane", json!({ "target": "Cleo" })),
            ("flag_attention", json!({ "target": "Cleo" })),
            ("set_status", json!({ "target": "Cleo", "text": "busy" })),
            ("board_set", json!({ "key": "k", "value": "v" })),
            ("board_get", json!({ "key": "k" })),
            ("board_list", json!({})),
            ("board_del", json!({ "key": "k" })),
            ("claim_file", json!({ "path": "a.ts" })),
            ("release_file", json!({ "path": "a.ts" })),
            ("list_claims", json!({})),
            ("reply_ask", json!({ "id": 3, "answer": "yes" })),
        ];
        for (name, args) in cases {
            assert!(
                build_request(name, &args, Some("Faye")).is_ok(),
                "tool {name} should build a request"
            );
        }
        assert!(build_request("nope", &json!({}), None).is_err());
    }

    #[test]
    fn board_set_scopes_to_the_caller_pane_and_records_the_writer() {
        let req = build_request(
            "board_set",
            &json!({ "key": "plan.api", "value": "Cleo" }),
            Some("Faye"),
        )
        .unwrap();
        assert_eq!(req["op"], "note.set");
        assert_eq!(req["key"], "plan.api");
        assert_eq!(req["value"], "Cleo");
        assert_eq!(req["pane"], "Faye"); // caller pane → workspace scope + writer
        assert!(req.get("workspace").is_none());
    }

    #[test]
    fn an_explicit_workspace_overrides_pane_scope() {
        let req =
            build_request("board_list", &json!({ "workspace": "Infra" }), Some("Faye")).unwrap();
        assert_eq!(req["workspace"], "Infra");
        assert_eq!(req["pane"], "Faye");
    }

    #[test]
    fn claim_and_release_carry_the_holder_pane() {
        let claim = build_request(
            "claim_file",
            &json!({ "path": "src/auth.ts" }),
            Some("Faye"),
        )
        .unwrap();
        assert_eq!(claim["op"], "claim");
        assert_eq!(claim["path"], "src/auth.ts");
        assert_eq!(claim["pane"], "Faye");

        let rel = build_request(
            "release_file",
            &json!({ "path": "src/auth.ts", "force": true }),
            Some("Cleo"),
        )
        .unwrap();
        assert_eq!(rel["op"], "release");
        assert_eq!(rel["force"], true);
        assert_eq!(rel["pane"], "Cleo");
    }

    #[test]
    fn reply_ask_carries_id_answer_and_replier() {
        let req = build_request(
            "reply_ask",
            &json!({ "id": 7, "answer": "lucia-auth" }),
            Some("Cleo"),
        )
        .unwrap();
        assert_eq!(req["op"], "reply");
        assert_eq!(req["id"], 7);
        assert_eq!(req["answer"], "lucia-auth");
        assert_eq!(req["from"], "Cleo");
    }

    #[test]
    fn flag_attention_defaults_to_the_caller_pane() {
        let req = build_request("flag_attention", &json!({}), Some("Faye")).unwrap();
        assert_eq!(req["target"], "Faye");
        // with no target and no caller pane, it's an error, not a silent self-flag
        assert!(build_request("flag_attention", &json!({}), None).is_err());
    }
}
