//! One terminal: a PTY, its child process, and the threads that move bytes.

use crate::coalesce::{coalesce_into, CHANNEL_DEPTH, FLUSH_INTERVAL, FRAME_MAX, READ_BUF};
use crate::protocol::Event;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::mpsc::{sync_channel, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// How long to keep reading after the child exited before reporting the exit anyway. Covers a
/// background grandchild that still holds the PTY open, which would otherwise hide the exit forever.
const DRAIN_AFTER_EXIT: Duration = Duration::from_millis(250);

pub struct Terminal {
    /// `None` after the child exited: dropping the master closes the ConPTY handle on Windows,
    /// which is what lets its reader reach EOF (v1 pty.rs).
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
}

pub type Registry = Arc<Mutex<HashMap<u32, Arc<Terminal>>>>;

pub struct SpawnRequest {
    pub id: u32,
    pub program: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env: HashMap<String, String>,
    pub cols: u16,
    pub rows: u16,
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows: rows.max(1),
        cols: cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    }
}

pub fn spawn(
    req: SpawnRequest,
    registry: &Registry,
    out: &SyncSender<Event>,
) -> Result<Option<u32>, String> {
    if registry.lock().unwrap().contains_key(&req.id) {
        return Err(format!("terminal {} already exists", req.id));
    }

    let pair = native_pty_system()
        .openpty(size(req.cols, req.rows))
        .map_err(|e| format!("openpty failed: {e}"))?;

    let mut cmd = CommandBuilder::new(&req.program);
    cmd.args(&req.args);
    if let Some(cwd) = req.cwd.as_deref().filter(|c| !c.is_empty()) {
        cmd.cwd(cwd);
    }
    for (k, v) in &req.env {
        cmd.env(k, v);
    }

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("could not start {}: {e}", req.program))?;
    let pid = child.process_id();
    let killer = child.clone_killer();
    // The child holds its own copy of the slave; ours must close so EOF can happen on Unix.
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("pty reader: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("pty writer: {e}"))?;

    let term = Arc::new(Terminal {
        master: Mutex::new(Some(pair.master)),
        writer: Mutex::new(Some(writer)),
        killer: Mutex::new(killer),
    });
    registry.lock().unwrap().insert(req.id, term.clone());

    let id = req.id;
    let (chunk_tx, chunk_rx) = sync_channel::<Vec<u8>>(CHANNEL_DEPTH);
    let (code_tx, code_rx) = sync_channel::<i64>(1);

    // Reader: blocks on the PTY, hands chunks to the flusher. A full channel blocks this thread,
    // which stops draining the PTY, which throttles the child.
    thread::Builder::new()
        .name(format!("pty-read-{id}"))
        .spawn(move || {
            let mut buf = [0u8; READ_BUF];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if chunk_tx.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                }
            }
        })
        .map_err(|e| e.to_string())?;

    // Waiter: reaps the child, then releases the master so Windows ConPTY flushes and closes.
    let wait_registry = registry.clone();
    let wait_term = term.clone();
    thread::Builder::new()
        .name(format!("pty-wait-{id}"))
        .spawn(move || {
            let code = match child.wait() {
                Ok(status) => i64::from(status.exit_code()),
                Err(_) => -1,
            };
            wait_term.writer.lock().unwrap().take();
            wait_term.master.lock().unwrap().take();
            wait_registry.lock().unwrap().remove(&id);
            let _ = code_tx.send(code);
        })
        .map_err(|e| e.to_string())?;

    // Flusher: coalesces and paces output, and sends the exit only after the last output.
    let out = out.clone();
    thread::Builder::new()
        .name(format!("pty-flush-{id}"))
        .spawn(move || {
            let mut exit: Option<(i64, Instant)> = None;
            loop {
                match chunk_rx.recv_timeout(Duration::from_millis(50)) {
                    Ok(first) => {
                        let started = Instant::now();
                        let mut acc = first;
                        coalesce_into(&mut acc, FRAME_MAX, || chunk_rx.try_recv().ok());
                        if out
                            .send(Event::Output {
                                id,
                                data: B64.encode(&acc),
                            })
                            .is_err()
                        {
                            return;
                        }
                        if let Some((_, since)) = exit.as_mut() {
                            *since = Instant::now();
                        }
                        let spent = started.elapsed();
                        if spent < FLUSH_INTERVAL {
                            thread::sleep(FLUSH_INTERVAL - spent);
                        }
                    }
                    Err(RecvTimeoutError::Timeout) => match exit {
                        None => {
                            if let Ok(code) = code_rx.try_recv() {
                                exit = Some((code, Instant::now()));
                            }
                        }
                        Some((_, since)) if since.elapsed() >= DRAIN_AFTER_EXIT => break,
                        Some(_) => {}
                    },
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            }
            let code = match exit {
                Some((code, _)) => code,
                None => code_rx.recv().unwrap_or(-1),
            };
            let _ = out.send(Event::Exit { id, code });
        })
        .map_err(|e| e.to_string())?;

    Ok(pid)
}

fn get(registry: &Registry, id: u32) -> Result<Arc<Terminal>, String> {
    registry
        .lock()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("no running terminal {id}"))
}

pub fn write(registry: &Registry, id: u32, bytes: &[u8]) -> Result<(), String> {
    let term = get(registry, id)?;
    let mut guard = term.writer.lock().unwrap();
    let writer = guard
        .as_mut()
        .ok_or_else(|| format!("terminal {id} has exited"))?;
    writer
        .write_all(bytes)
        .and_then(|_| writer.flush())
        .map_err(|e| format!("write to terminal {id}: {e}"))
}

pub fn resize(registry: &Registry, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let term = get(registry, id)?;
    let guard = term.master.lock().unwrap();
    let master = guard
        .as_ref()
        .ok_or_else(|| format!("terminal {id} has exited"))?;
    master
        .resize(size(cols, rows))
        .map_err(|e| format!("resize terminal {id}: {e}"))
}

pub fn kill(registry: &Registry, id: u32) -> Result<(), String> {
    match registry.lock().unwrap().get(&id).cloned() {
        Some(term) => term
            .killer
            .lock()
            .unwrap()
            .kill()
            .map_err(|e| format!("kill terminal {id}: {e}")),
        // Already exited: killing is a no-op, not an error.
        None => Ok(()),
    }
}

pub fn kill_all(registry: &Registry) {
    let terms: Vec<Arc<Terminal>> = registry.lock().unwrap().values().cloned().collect();
    for term in terms {
        let _ = term.killer.lock().unwrap().kill();
    }
}
