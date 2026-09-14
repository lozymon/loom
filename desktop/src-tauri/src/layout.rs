//! Where the packaged pieces are, and where the hub keeps its files (mirrors `hub/src/paths.ts`).

use std::path::{Path, PathBuf};

pub fn exe_name(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

/// External binaries sit next to the app's own executable.
pub fn sidecar(name: &str) -> PathBuf {
    let dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_default();
    dir.join(exe_name(name))
}

fn env_path(key: &str) -> Option<PathBuf> {
    std::env::var_os(key)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

fn home() -> PathBuf {
    env_path("HOME")
        .or_else(|| env_path("USERPROFILE"))
        .unwrap_or_default()
}

pub fn config_dir() -> PathBuf {
    if cfg!(windows) {
        env_path("APPDATA")
            .unwrap_or_else(|| home().join("AppData").join("Roaming"))
            .join("loom")
    } else {
        env_path("XDG_CONFIG_HOME")
            .unwrap_or_else(|| home().join(".config"))
            .join("loom")
    }
}

pub fn data_dir() -> PathBuf {
    if cfg!(windows) {
        config_dir()
    } else {
        env_path("XDG_DATA_HOME")
            .unwrap_or_else(|| home().join(".local").join("share"))
            .join("loom")
    }
}

/// The port from `hub.json`, or the hub's default.
pub fn hub_port() -> u16 {
    std::fs::read_to_string(config_dir().join("hub.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|v| v.get("port").and_then(|p| p.as_u64()))
        .and_then(|p| u16::try_from(p).ok())
        .filter(|p| *p != 0)
        .unwrap_or(7420)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exe_names_follow_the_platform() {
        let name = exe_name("loom-node");
        assert!(name == "loom-node" || name == "loom-node.exe");
    }
}
