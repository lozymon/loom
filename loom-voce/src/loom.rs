//! The bridge to Loom: resolve a target pane and deliver a transcript over the control bus by
//! shelling out to the `loom` CLI. We deliberately use the CLI (not a direct `$LOOM_SOCK` socket
//! client) so loom-voce stays a plain bus *client* — the same contract an agent-in-a-pane uses —
//! and inherits Loom's routing (name→pane resolution, broadcast) for free.

use anyhow::{bail, Context, Result};
use std::io::Write;
use std::process::{Command, Stdio};

/// Where a transcript goes.
pub enum Target {
    /// A single pane, by Loom's auto-name (Faye, Cleo, …).
    Pane(String),
    /// Every live pane in the active workspace (`loom broadcast`).
    Broadcast,
}

impl Target {
    pub fn describe(&self) -> String {
        match self {
            Target::Pane(n) => format!("pane {n}"),
            Target::Broadcast => "broadcast".to_string(),
        }
    }
}

/// The `loom` binary to invoke. Inside a Loom pane, `$LOOM_BIN` points at the exact binary and the
/// CLI dir is already on `PATH`; outside one, fall back to `loom` on `PATH`.
fn loom_bin() -> String {
    std::env::var("LOOM_BIN").unwrap_or_else(|_| "loom".to_string())
}

/// Resolve the delivery target. An explicit `--pane` wins; otherwise ask `loom list` for the
/// focused pane (marked with a leading `*` in its output).
pub fn resolve_target(pane: Option<&str>) -> Result<Target> {
    if let Some(name) = pane {
        return Ok(Target::Pane(name.to_string()));
    }
    let focused = focused_pane().context("no --pane given and could not find the focused pane")?;
    Ok(Target::Pane(focused))
}

/// Parse `loom list` and return the focused pane's name. `loom list` prints one pane per line as
/// `<marker> <name> <state> <workspace>`, where the focused pane's marker is `*`.
fn focused_pane() -> Result<String> {
    let out = Command::new(loom_bin())
        .arg("list")
        .output()
        .with_context(|| format!("failed to run `{} list` (is Loom running?)", loom_bin()))?;
    if !out.status.success() {
        bail!(
            "`loom list` failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    let text = String::from_utf8_lossy(&out.stdout);
    for line in text.lines() {
        // Focused rows start with `*`; the pane name is the first token after it.
        if let Some(rest) = line.trim_start().strip_prefix('*') {
            if let Some(name) = rest.split_whitespace().next() {
                return Ok(name.to_string());
            }
        }
    }
    bail!("no focused pane in `loom list` — focus a pane in Loom, or pass --pane <name>")
}

/// Type `text` into the target via the `loom` CLI. We pipe the transcript through stdin rather than
/// pass it as an argv string: `loom send <pane>` and `loom broadcast` both read stdin when given no
/// text, which sidesteps all shell-quoting hazards with arbitrary spoken input.
pub fn deliver(target: &Target, text: &str, enter: bool) -> Result<()> {
    let mut cmd = Command::new(loom_bin());
    match target {
        Target::Pane(name) => {
            cmd.args(["send", name]);
        }
        Target::Broadcast => {
            cmd.arg("broadcast");
        }
    }
    if !enter {
        cmd.arg("--no-enter");
    }
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()
        .with_context(|| format!("failed to spawn `{}`", loom_bin()))?;
    child
        .stdin
        .take()
        .context("no stdin pipe on loom child")?
        .write_all(text.as_bytes())
        .context("failed to pipe transcript to loom")?;
    let status = child.wait().context("loom process error")?;
    if !status.success() {
        bail!("`loom` exited with {status}");
    }
    Ok(())
}
