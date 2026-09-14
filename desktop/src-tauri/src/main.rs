// No console window on Windows for the app. The CLI face attaches to its parent's console instead.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if !args.is_empty() {
        std::process::exit(loom_desktop_lib::run_cli(&args));
    }
    loom_desktop_lib::run();
}
