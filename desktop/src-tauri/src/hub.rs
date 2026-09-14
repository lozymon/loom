//! Finding or starting the local hub (M9).

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::time::{Duration, Instant};

use crate::layout;

#[derive(Debug, PartialEq, Eq)]
pub enum Probe {
    Hub,
    /// Something else answers on the port.
    Other,
    Nothing,
}

/// `GET /loom.json` on loopback, with plain std networking: the hub's unauthenticated identity check.
pub fn probe(port: u16) -> Probe {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(500)) else {
        return Probe::Nothing;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let request =
        format!("GET /loom.json HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return Probe::Other;
    }
    let mut response = String::new();
    let _ = stream.take(8192).read_to_string(&mut response);
    if response.starts_with("HTTP/1.1 200") && response.contains("\"loom\":\"hub\"") {
        Probe::Hub
    } else {
        Probe::Other
    }
}

pub fn random_token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("the operating system has no random source");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A hub this app started. Its stdin stays open while the app lives; closing it stops the hub.
pub struct OwnedHub {
    child: Child,
    stdin: Option<ChildStdin>,
}

pub struct Bundle {
    pub node: PathBuf,
    pub hub_entry: PathBuf,
    pub client_dir: PathBuf,
}

impl Bundle {
    pub fn new(resource_dir: &Path) -> Self {
        Bundle {
            node: layout::sidecar("loom-node"),
            hub_entry: resource_dir.join("hub").join("hub.mjs"),
            client_dir: resource_dir.join("client"),
        }
    }

    pub fn check(&self) -> Result<(), String> {
        for (what, path) in [("Node runtime", &self.node), ("hub", &self.hub_entry)] {
            if !path.exists() {
                return Err(format!("The bundled {what} is missing: {}", path.display()));
            }
        }
        Ok(())
    }
}

pub fn start(bundle: &Bundle, token: &str) -> Result<OwnedHub, String> {
    bundle.check()?;
    let logs = layout::data_dir().join("logs");
    std::fs::create_dir_all(&logs).map_err(|e| format!("cannot create {}: {e}", logs.display()))?;
    let log_path = logs.join("hub.log");
    // The first run prints the hub's access token, so the log is for this user only.
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let log = options
        .open(&log_path)
        .map_err(|e| format!("cannot write {}: {e}", log_path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = log.set_permissions(std::fs::Permissions::from_mode(0o600));
    }
    let log_err = log.try_clone().map_err(|e| e.to_string())?;

    let mut cmd = Command::new(&bundle.node);
    cmd.arg(&bundle.hub_entry)
        .env("LOOM_DESKTOP_TOKEN", token)
        .env("LOOM_EXIT_WITH_STDIN", "1")
        .env("LOOM_CLIENT_DIR", &bundle.client_dir)
        .env("LOOM_PTY_BIN", layout::sidecar("loom-pty"))
        .stdin(Stdio::piped())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err));
    for (var, name) in [
        ("LOOM_CLAUDE_EXECUTABLE", "loom-claude"),
        ("LOOM_VOCE_BIN", "loom-voce"),
    ] {
        let path = layout::sidecar(name);
        if path.exists() {
            cmd.env(var, path);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("cannot start {}: {e}", bundle.node.display()))?;
    let stdin = child.stdin.take();
    Ok(OwnedHub { child, stdin })
}

/// Waits until the hub answers, or it exits, or the time is up. On failure, returns the log's tail.
pub fn wait_ready(hub: &mut OwnedHub, port: u16, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    loop {
        if probe(port) == Probe::Hub {
            return Ok(());
        }
        if let Ok(Some(status)) = hub.child.try_wait() {
            return Err(format!("The hub exited ({status}).\n\n{}", log_tail()));
        }
        if Instant::now() > deadline {
            return Err(format!(
                "The hub did not answer within {} seconds.\n\n{}",
                timeout.as_secs(),
                log_tail()
            ));
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

pub fn log_tail() -> String {
    let path = layout::data_dir().join("logs").join("hub.log");
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let lines: Vec<&str> = text.lines().collect();
    let tail = lines[lines.len().saturating_sub(12)..].join("\n");
    format!("{tail}\n\nLog: {}", path.display())
}

impl OwnedHub {
    /// Asks the hub to stop its sessions and exit, then makes sure it did.
    pub fn stop(mut self) {
        drop(self.stdin.take());
        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline {
            if let Ok(Some(_)) = self.child.try_wait() {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn probe_tells_a_hub_from_other_servers_and_nothing() {
        let serve = |body: &'static str| {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            std::thread::spawn(move || {
                if let Ok((mut s, _)) = listener.accept() {
                    let mut buf = [0u8; 1024];
                    let _ = s.read(&mut buf);
                    let _ = s.write_all(body.as_bytes());
                }
            });
            port
        };
        assert_eq!(
            probe(serve(
                "HTTP/1.1 200 OK\r\n\r\n{\"loom\":\"hub\",\"protocol\":1}"
            )),
            Probe::Hub
        );
        assert_eq!(probe(serve("HTTP/1.1 404 Not Found\r\n\r\n")), Probe::Other);
        let free = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        assert_eq!(probe(free), Probe::Nothing);
    }

    #[test]
    fn tokens_are_long_and_different() {
        let a = random_token();
        assert_eq!(a.len(), 64);
        assert_ne!(a, random_token());
    }
}
