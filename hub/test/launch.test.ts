import { describe, expect, it } from "vitest";
import { programLaunch, resolveOnPath, shellLaunch, shQuote, tokenizeWindows } from "../src/adapters/pty/launch.ts";

const posix = (files: string[], env: NodeJS.ProcessEnv = { SHELL: "/usr/bin/zsh", PATH: "/usr/bin:/bin" }) => ({
  platform: "linux" as const,
  env,
  exists: (p: string) => files.includes(p),
});
const win = (files: string[]) => ({
  platform: "win32" as const,
  env: { PATH: "C:\\Windows\\System32;C:\\Users\\kim\\AppData\\Roaming\\npm", PATHEXT: ".COM;.EXE;.BAT;.CMD", ComSpec: "C:\\Windows\\System32\\cmd.exe" },
  exists: (p: string) => files.map((f) => f.toLowerCase()).includes(p.toLowerCase()),
});

describe("shellLaunch on POSIX", () => {
  it("runs the login shell, or a command through it", () => {
    const le = posix(["/usr/bin/zsh"]);
    expect(shellLaunch(undefined, le)).toEqual({ program: "/usr/bin/zsh", args: ["-l"], display: "zsh" });
    expect(shellLaunch("  npm run dev ", le)).toEqual({ program: "/usr/bin/zsh", args: ["-l", "-c", "npm run dev"], display: "npm run dev" });
  });

  it("falls back to bash, then sh, when $SHELL is missing", () => {
    expect(shellLaunch(undefined, posix(["/bin/bash"], {})).program).toBe("/bin/bash");
    expect(shellLaunch(undefined, posix([], {})).program).toBe("/bin/sh");
  });
});

describe("shellLaunch on Windows", () => {
  it("opens PowerShell without a command", () => {
    expect(shellLaunch(undefined, win([]))).toEqual({ program: "powershell.exe", args: ["-NoLogo"], display: "PowerShell" });
  });

  it("spawns a program on PATH directly instead of through PowerShell", () => {
    const le = win(["C:\\Windows\\System32\\git.exe"]);
    expect(shellLaunch('git log "--format=%h %s"', le)).toMatchObject({ program: "C:\\Windows\\System32\\git.exe", args: ["log", "--format=%h %s"] });
  });

  it("runs .cmd shims through cmd.exe", () => {
    const le = win(["C:\\Users\\kim\\AppData\\Roaming\\npm\\claude.cmd"]);
    const launch = shellLaunch("claude --resume abc", le);
    expect(launch.program).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(launch.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(launch.args[3]).toContain("claude.cmd --resume abc");
  });

  it("uses PowerShell for anything that is not a program on PATH", () => {
    expect(shellLaunch("Get-ChildItem | Select -First 3", win([]))).toEqual({
      program: "powershell.exe",
      args: ["-NoLogo", "-NoProfile", "-Command", "Get-ChildItem | Select -First 3"],
      display: "Get-ChildItem | Select -First 3",
    });
  });
});

describe("programLaunch", () => {
  it("execs through the login shell on POSIX with every argument quoted", () => {
    const launch = programLaunch("claude", ["--settings", "/home/kim/My Files/s.json", "--resume", "it's"], posix(["/usr/bin/zsh"]));
    expect(launch.program).toBe("/usr/bin/zsh");
    expect(launch.args).toEqual(["-l", "-c", "exec claude --settings '/home/kim/My Files/s.json' --resume 'it'\\''s'"]);
  });

  it("fails clearly on Windows when the program is not installed", () => {
    expect(() => programLaunch("claude", [], win([]))).toThrow(/not found on PATH/);
  });
});

describe("helpers", () => {
  it("quotes only when needed", () => {
    expect(shQuote("--model")).toBe("--model");
    expect(shQuote("a b")).toBe("'a b'");
  });

  it("resolves with PATHEXT on Windows and plain names on POSIX", () => {
    expect(resolveOnPath("git", win(["C:\\Windows\\System32\\git.exe"]))).toBe("C:\\Windows\\System32\\git.exe");
    expect(resolveOnPath("ls", posix(["/bin/ls"]))).toBe("/bin/ls");
    expect(resolveOnPath("nope", posix([]))).toBeUndefined();
  });

  it("tokenizes Windows command lines with quotes", () => {
    expect(tokenizeWindows('"C:\\Program Files\\x.exe" -a "b c" ""')).toEqual(["C:\\Program Files\\x.exe", "-a", "b c", ""]);
  });
});
