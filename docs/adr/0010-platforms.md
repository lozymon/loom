# Linux and native Windows are first-class; WSL supported; macOS parked

**Status:** Accepted (2026-09-12).

The author's home machine is Linux. The work machine is Windows with Claude inside WSL Ubuntu. Colleagues use Windows only and want their own install.

## Decision

- **Linux:** hub, PTY sidecar, desktop app, `.deb`.
- **Native Windows:** hub on Node, PTY sidecar on ConPTY (PowerShell default; Git Bash and cmd selectable), control bus on a named pipe, data under `%APPDATA%\loom`, Tauri NSIS installer bundling the hub as a single executable. Claude Code on Windows needs Git for Windows; the installer checks for it.
- **WSL:** the Linux hub runs inside WSL; the client is a Windows browser at localhost. Repos should live on the WSL filesystem.
- **CI runs on Linux and Windows from M2** (`.github/workflows/ci.yml`). As of M2 the Windows job has not run yet, since the repository is not on GitHub; the sidecar cross-compiles for `x86_64-pc-windows-gnu` locally and the Windows launch rules are unit tested, but nothing has executed on Windows.
- **macOS:** not built in v2.0.

## Consequences

- Paths, shells, line endings, and process metadata need platform tests, not assumptions.
- The kernel "busy" signal needs a Windows implementation or is reported as unavailable; SDK sessions do not depend on it.
- Local whisper on Windows is opt-in until verified on real hardware; cloud speech is the Windows default.

## As built (M9, 2026-09-13)

- **No single executable.** The Agent SDK runs its own native `claude` binary (214 MB on Linux), not a script, and the hub's `loom` shim and stdio MCP server need a Node runtime, so a Node single-executable build would save nothing and force the ES-module hub into CommonJS. Installers ship `loom-node` (the Node binary), the hub bundled by rolldown into `hub/hub.mjs` with `cli` and `mcp` subcommands, the built client, `loom-pty`, `loom-voce` (Linux), and the SDK's binary as `loom-claude`. The `.deb` is large (see M9) but needs no Node or Claude Code install.
- **Sign-in:** the app starts the hub with a random `LOOM_DESKTOP_TOKEN` it accepts for that run only; the client never saves it (`#token=…&once=1`). The unix socket and named pipe from ADR-0008 are still not built.
- **Lifetime:** the hub runs with `LOOM_EXIT_WITH_STDIN=1` and stops when the app's pipe closes, so a crashed app leaves no hub. An already running hub on the port is attached to, not replaced.
- **Linux webview:** WebKitGTK needs media streams enabled and a permission handler, and it never opens the microphone for a hidden page, so the global push-to-talk shortcut shows the window first. `MediaRecorder` plus `decodeAudioData` never completed there, so the client now captures raw samples through Web Audio in every browser.
- **Windows** installer: NSIS, per-user, with a post-install warning when Git for Windows is missing. It is built by `.github/workflows/desktop.yml` and has never run.
