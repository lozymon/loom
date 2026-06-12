// Strip terminal escape sequences from raw PTY output so a session log reads as plain text in the
// viewer. This is a deliberately simple, lossy pass — enough to review "what the agent did" without
// embedding a full terminal emulator: we drop CSI/OSC/other escapes, carriage returns, and stray
// control bytes, keeping printable text plus newlines and tabs.

// eslint-disable-next-line no-control-regex
const CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g; // colours, cursor moves, etc.: ESC [ … final-byte
// eslint-disable-next-line no-control-regex
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g; // title/clipboard: ESC ] … BEL or ESC \
// eslint-disable-next-line no-control-regex
const OTHER_ESC = /\x1b[ -/]*[0-~]?/g; // remaining short escapes (charset, RIS, ESC =, …)
// eslint-disable-next-line no-control-regex
const CTRL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g; // control bytes except \t (\x09) and \n (\x0a)

/** Remove ANSI/terminal escapes and control bytes from raw output, leaving readable plain text. */
export function stripAnsi(raw: string): string {
  return raw
    .replace(OSC, "")
    .replace(CSI, "")
    .replace(OTHER_ESC, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n") // lone CR (TUI redraw) → newline, so lines don't collapse onto each other
    .replace(CTRL, "");
}
