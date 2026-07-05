//! Suppress the console window Windows pops for each child process the GUI shells out to.
//!
//! On Windows a GUI app that spawns a *console-subsystem* program (git, the editor, `loom-voce`,
//! PowerShell for capture, `wsl.exe`) gets a black console window flashed onto the screen for the
//! life of that child. Since the git panel polls `git` repeatedly, this is a constant flicker. The
//! `CREATE_NO_WINDOW` creation flag runs the child with no console window. No-op on Unix.
//!
//! (The pane shells themselves are unaffected — they run inside ConPTY via portable-pty and are
//! rendered in-app, never as a separate window. This is only for the app's own auxiliary spawns.)

use std::process::Command;

/// Chainable extension applying `CREATE_NO_WINDOW` on Windows; returns `self` unchanged elsewhere,
/// so call sites read the same on every platform: `Command::new("git").…​.no_console_window().output()`.
pub trait NoConsoleWindow {
    fn no_console_window(&mut self) -> &mut Self;
}

impl NoConsoleWindow for Command {
    #[cfg(windows)]
    fn no_console_window(&mut self) -> &mut Self {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW (winbase.h) — the process is created without a console window.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        self.creation_flags(CREATE_NO_WINDOW)
    }

    #[cfg(not(windows))]
    fn no_console_window(&mut self) -> &mut Self {
        self
    }
}
