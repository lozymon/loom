//! loom-pty: the hub's terminal sidecar (ADR-0002).
//!
//! Reads JSON-line commands on stdin and writes JSON-line events on stdout. Never interprets
//! terminal bytes. Exits, killing every child, when stdin closes, so it cannot outlive its hub.

mod coalesce;
mod protocol;
mod terminal;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use protocol::{Command, Event};
use std::collections::HashMap;
use std::io::{self, BufRead, BufWriter, Write};
use std::sync::mpsc::{sync_channel, Receiver};
use std::sync::{Arc, Mutex};
use std::thread;
use terminal::Registry;

/// Events waiting for stdout before terminal flushers block.
const OUT_DEPTH: usize = 256;

fn writer_loop(rx: Receiver<Event>) {
    let stdout = io::stdout();
    let mut out = BufWriter::with_capacity(256 * 1024, stdout.lock());
    while let Ok(first) = rx.recv() {
        let mut next = Some(first);
        while let Some(event) = next {
            if serde_json::to_writer(&mut out, &event).is_err() || out.write_all(b"\n").is_err() {
                return;
            }
            next = rx.try_recv().ok();
        }
        if out.flush().is_err() {
            return;
        }
    }
}

fn platform() -> &'static str {
    if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}

fn main() {
    let (out_tx, out_rx) = sync_channel::<Event>(OUT_DEPTH);
    let writer = thread::spawn(move || writer_loop(out_rx));
    let registry: Registry = Arc::new(Mutex::new(HashMap::new()));

    let _ = out_tx.send(Event::Ready {
        version: env!("CARGO_PKG_VERSION"),
        platform: platform(),
    });

    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let command: Command = match serde_json::from_str(&line) {
            Ok(c) => c,
            Err(e) => {
                let _ = out_tx.send(Event::Error {
                    id: None,
                    message: format!("bad command: {e}"),
                });
                continue;
            }
        };
        let (id, result) = match command {
            Command::Spawn {
                id,
                program,
                args,
                cwd,
                env,
                cols,
                rows,
            } => {
                let req = terminal::SpawnRequest {
                    id,
                    program,
                    args,
                    cwd,
                    env,
                    cols,
                    rows,
                };
                match terminal::spawn(req, &registry, &out_tx) {
                    Ok(pid) => {
                        let _ = out_tx.send(Event::Spawned { id, pid });
                        (id, Ok(()))
                    }
                    Err(e) => (id, Err(e)),
                }
            }
            Command::Write { id, data } => match B64.decode(data.as_bytes()) {
                Ok(bytes) => (id, terminal::write(&registry, id, &bytes)),
                Err(e) => (id, Err(format!("write data is not base64: {e}"))),
            },
            Command::Resize { id, cols, rows } => (id, terminal::resize(&registry, id, cols, rows)),
            Command::Kill { id } => (id, terminal::kill(&registry, id)),
        };
        if let Err(message) = result {
            let _ = out_tx.send(Event::Error {
                id: Some(id),
                message,
            });
        }
    }

    // The hub is gone. Take every child with us.
    terminal::kill_all(&registry);
    drop(out_tx);
    let _ = writer.join();
}
