// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// One binary, three faces. The first positional arg decides which: a control-CLI subcommand
// (`loom list`/`send`/`spawn`/… , ADR-0007) drives the inter-pane bus; `loom mcp` runs the MCP
// server; anything else — a bare `loom`, `loom .`, or `loom <dir>` — opens the GUI. The CLI/MCP
// arms return before any Tauri/WebKitGTK setup, so invoking `loom` inside a pane stays cheap.
fn main() {
    match std::env::args().nth(1).as_deref() {
        Some("mcp") => loom_lib::mcp::run(),
        Some(cmd) if loom_lib::cli::is_command(cmd) => loom_lib::cli::run(),
        _ => loom_lib::run(),
    }
}
