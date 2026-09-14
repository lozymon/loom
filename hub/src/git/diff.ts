import type { DiffFile, DiffHunk, SessionDiff } from "@loom/protocol";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { HubError } from "../errors.ts";
import { git, GitError } from "./git.ts";

const MAX_FILES = 300;
const MAX_LINES_PER_FILE = 4000;
const MAX_UNTRACKED_BYTES = 256 * 1024;
/** git's empty tree, for repositories without a first commit. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export function hunkId(filePath: string, header: string, lines: string[]): string {
  return createHash("sha256").update(`${filePath}\n${header}\n${lines.join("\n")}`).digest("hex").slice(0, 16);
}

/** Parses `git diff` output (with rename detection) into files and hunks. */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | undefined;
  let hunk: { header: string; lines: string[] } | undefined;
  let lineCount = 0;

  const closeHunk = () => {
    if (file && hunk) file.hunks.push({ id: hunkId(file.path, hunk.header, hunk.lines), header: hunk.header, lines: hunk.lines });
    hunk = undefined;
  };
  const unquote = (p: string) => (p.startsWith('"') ? (JSON.parse(p) as string) : p);

  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      closeHunk();
      const m = /^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/.exec(line);
      file = { path: m?.[2] ?? "", status: "modified", added: 0, removed: 0, binary: false, hunks: [], truncated: false };
      lineCount = 0;
      files.push(file);
      continue;
    }
    if (!file) continue;
    if (!hunk) {
      if (line.startsWith("new file mode")) file.status = "added";
      else if (line.startsWith("deleted file mode")) file.status = "deleted";
      else if (line.startsWith("rename from ")) {
        file.status = "renamed";
        file.oldPath = unquote(line.slice("rename from ".length));
      } else if (line.startsWith("rename to ")) file.path = unquote(line.slice("rename to ".length));
      else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) file.binary = true;
      else if (line.startsWith("+++ ") && line !== "+++ /dev/null") file.path = unquote(line.slice(4)).replace(/^b\//, "");
      else if (line.startsWith("--- ") && line !== "--- /dev/null" && file.status !== "renamed") file.path ||= unquote(line.slice(4)).replace(/^a\//, "");
    }
    if (line.startsWith("@@")) {
      closeHunk();
      hunk = { header: line, lines: [] };
      continue;
    }
    if (hunk && (line.startsWith(" ") || line.startsWith("+") || line.startsWith("-") || line.startsWith("\\"))) {
      if (line.startsWith("+")) file.added++;
      else if (line.startsWith("-")) file.removed++;
      if (++lineCount > MAX_LINES_PER_FILE) {
        file.truncated = true;
        continue;
      }
      hunk.lines.push(line);
    }
  }
  closeHunk();
  return files;
}

async function repoRoot(cwd: string): Promise<string | undefined> {
  try {
    return (await git(["rev-parse", "--show-toplevel"], cwd)).trim();
  } catch {
    return undefined;
  }
}

async function untrackedFile(root: string, rel: string): Promise<DiffFile> {
  const file: DiffFile = { path: rel, status: "untracked", added: 0, removed: 0, binary: false, hunks: [], truncated: false };
  const abs = path.join(root, rel);
  const info = await lstat(abs).catch(() => undefined);
  if (!info?.isFile()) return file;
  if (info.size > MAX_UNTRACKED_BYTES) {
    file.truncated = true;
    return file;
  }
  const data = await readFile(abs);
  if (data.includes(0)) {
    file.binary = true;
    return file;
  }
  const text = data.toString("utf8");
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  file.added = lines.length;
  const shown = lines.slice(0, MAX_LINES_PER_FILE).map((l) => `+${l}`);
  file.truncated = lines.length > MAX_LINES_PER_FILE;
  const header = `@@ -0,0 +1,${lines.length} @@`;
  if (shown.length) file.hunks.push({ id: hunkId(rel, header, shown), header, lines: shown });
  return file;
}

/**
 * The changes in a session's folder (M12). `uncommitted` compares the working tree (staged and not)
 * with HEAD and lists untracked files; `branch` compares with the merge base of `baseRef`.
 */
export async function readDiff(cwd: string, mode: "uncommitted" | "branch", baseRef?: string): Promise<SessionDiff> {
  const root = await repoRoot(cwd);
  if (!root) return { git: false, root: cwd, mode, base: "", files: [], truncated: false };
  let base: string;
  if (mode === "branch") {
    if (!baseRef) throw new HubError("invalid", "this session has no branch base to compare with");
    base = (await git(["merge-base", "HEAD", baseRef], root)).trim();
  } else {
    base = await git(["rev-parse", "--verify", "--quiet", "HEAD"], root).then((s) => s.trim(), () => EMPTY_TREE);
  }
  const text = await git(["-c", "core.quotepath=off", "diff", "--no-color", "--no-ext-diff", "-M", "--unified=3", base, "--"], root);
  let files = parseUnifiedDiff(text);
  if (mode === "uncommitted") {
    const untracked = (await git(["ls-files", "--others", "--exclude-standard", "-z"], root)).split("\0").filter(Boolean);
    files = [...files, ...(await Promise.all(untracked.slice(0, MAX_FILES).map((rel) => untrackedFile(root, rel))))];
  }
  const truncated = files.length > MAX_FILES;
  return { git: true, root, mode, base: base === EMPTY_TREE ? "(no commits)" : base.slice(0, 12), files: files.slice(0, MAX_FILES), truncated };
}

function gitWithInput(args: string[], cwd: string, input: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new GitError(`git ${args[0]} failed: ${stderr.trim()}`, stderr, code ?? undefined))));
    child.stdin.end(input);
  });
}

/**
 * Undoes uncommitted changes (M12): one hunk of a modified file, by the id the person was shown, or a
 * whole file. Returns the diff afterwards. Untracked and added files are deleted when reverted whole.
 */
export async function revertChange(cwd: string, filePath: string, id?: string): Promise<SessionDiff> {
  const diff = await readDiff(cwd, "uncommitted");
  if (!diff.git) throw new HubError("invalid", "this session's folder is not a git repository");
  const file = diff.files.find((f) => f.path === filePath);
  if (!file) throw new HubError("not-found", `${filePath} has no uncommitted changes; refresh the view`);
  const root = diff.root;

  if (id) {
    const hunk: DiffHunk | undefined = file.hunks.find((h) => h.id === id);
    if (!hunk) throw new HubError("invalid", `that change in ${filePath} is no longer there; refresh the view`);
    if (file.status !== "modified" || file.binary) throw new HubError("invalid", "only changes inside an existing file can be reverted one at a time; revert the whole file");
    const patch = [`diff --git a/${file.path} b/${file.path}`, `--- a/${file.path}`, `+++ b/${file.path}`, hunk.header, ...hunk.lines, ""].join("\n");
    await gitWithInput(["apply", "--reverse", "--whitespace=nowarn", "-"], root, patch);
    return readDiff(cwd, "uncommitted");
  }

  switch (file.status) {
    case "untracked":
      await rm(path.join(root, file.path), { force: true });
      break;
    case "added":
      await git(["rm", "--cached", "--quiet", "--", file.path], root);
      await rm(path.join(root, file.path), { force: true });
      break;
    case "renamed":
      await git(["restore", "--source=HEAD", "--staged", "--worktree", "--", file.oldPath ?? file.path], root);
      await git(["rm", "--cached", "--quiet", "--ignore-unmatch", "--", file.path], root);
      await rm(path.join(root, file.path), { force: true });
      break;
    default:
      await git(["restore", "--source=HEAD", "--staged", "--worktree", "--", file.path], root);
  }
  return readDiff(cwd, "uncommitted");
}

/**
 * Paths and line counts of uncommitted changes, for `files.changed`, from `--numstat` without reading
 * file contents. Untracked files count with 0 lines. Undefined outside git.
 */
export async function changeSummary(cwd: string): Promise<Array<{ path: string; added: number; removed: number }> | undefined> {
  const root = await repoRoot(cwd);
  if (!root) return undefined;
  try {
    const base = await git(["rev-parse", "--verify", "--quiet", "HEAD"], root).then((s) => s.trim(), () => EMPTY_TREE);
    const numstat = await git(["-c", "core.quotepath=off", "diff", "--numstat", "-z", "-M", base, "--"], root);
    const files: Array<{ path: string; added: number; removed: number }> = [];
    const parts = numstat.split("\0");
    for (let i = 0; i < parts.length; i++) {
      const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(parts[i] ?? "");
      if (!m) continue;
      // A rename is "added\tremoved\t" followed by the old and new paths as separate fields.
      const renamed = m[3] === "";
      const filePath = renamed ? (parts[i + 2] ?? "") : m[3]!;
      if (renamed) i += 2;
      files.push({ path: filePath, added: m[1] === "-" ? 0 : Number(m[1]), removed: m[2] === "-" ? 0 : Number(m[2]) });
    }
    const untracked = (await git(["ls-files", "--others", "--exclude-standard", "-z"], root)).split("\0").filter(Boolean);
    return [...files, ...untracked.map((p) => ({ path: p, added: 0, removed: 0 }))].slice(0, MAX_FILES);
  } catch {
    return undefined;
  }
}
