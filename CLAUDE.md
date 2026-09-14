# CLAUDE.md

Guidance for Claude Code working in this repository.

## Status

**M12 first slice done (2026-09-13):** history search (FTS5 index, Ctrl+K, `search_history`), a Changes tab with hunk and file reverts and `files.changed` per turn (`hub/src/git/diff.ts`), and screen manifests for terminal CLIs without hooks (`hub/src/heuristics`, headless xterm). **Open:** deploying the relay, a real phone and push service, installing the `.deb`, any Windows run, the work-machine smoke test (M1), Groq and OpenAI with real keys, real manifests for CLIs you use. **Next:** more M12 polish as daily use shows what is missing; Work lives on branch `feat/loom-v2` of github.com/lozymon/loom; v1 keeps `main` until v2 is ready to deploy. Dev setup: [docs/dev.md](docs/dev.md).

Loom v2 is a rewrite of Loom v1 (`../loom`, Tauri + Rust + SolidJS terminal multiplexer for CLI agents). v1 stays the author's daily driver until v2 reaches M4.

Sources of truth, in order: [PLAN.md](PLAN.md) for scope and milestones, [docs/adr/](docs/adr/) for the why, [CONTEXT.md](CONTEXT.md) for vocabulary. If the design changes, update the ADR in the same change. Use CONTEXT.md's terms in code and prose; its _Avoid_ lists are real.

## What this is

A **hub** per machine owns every AI coding session; **clients** (desktop, browser, PWA, CLI, MCP) are views over a WebSocket. Claude runs through the Claude Agent SDK; any other CLI runs in a real PTY. A **Steward** resolves permission prompts and questions (rules, then model, then human). A **Cockpit** session steers all others. Voice in and out in English and pt_BR.

## Layout

| Path | What | State |
|---|---|---|
| `protocol/` | `@loom/protocol`: zod schemas and types for frames, commands, events, levels | Built |
| `hub/` | TypeScript hub on Node 24: session manager, approval broker, event log, WebSocket server, `claude-sdk` adapter | Built |
| `client/` | SolidJS + Vite client: rail, chat timeline, approval and question cards, composer | Built |
| `desktop/` | Tauri 2 app: attaches to or starts the bundled hub, tray, global push-to-talk, `loom` CLI face; `scripts/prepare.mjs` gathers the bundle | Built |
| `sidecars/pty/` | Rust PTY sidecar (`loom-pty`): PTYs, coalesced output, JSON lines over stdio | Built |
| `sidecars/voce/` | Rust whisper.cpp transcriber (from v1 `loom-voce`), JSON lines over stdio | Built |
| `hub/src/voice/` | Voice engines: whisper sidecar client, Groq, OpenAI, Piper; WAV checks | Built |
| `client/src/voice/` | Recorder, push-to-talk controller, read-back rules, speaker | Built |
| `hub/src/policy/` | Rule parser and matcher (Claude Code syntax), policy store, trust | Built |
| `hub/src/git/` | Worktrees and project identity (main repository for worktrees) | Built |
| `hub/src/board/` | Project boards in `.loom/board.json`, dispatch, status sync, run cap | Built |
| `hub/src/steward/` | Steward: prompt, Claude model client, gates and budgets, review context | Built |
| `hub/src/control/` | Actors, session tokens, capability table, notes and claims | Built |
| `hub/src/loom/` | `loom` tools, in-process API, stdio MCP server, CLI, hub client | Built |
| `hub/src/remote/` | Bind rules, login limiter, `loom tunnel`, forwarded-for | Built |
| `hub/src/push/` | Web push: VAPID keys and devices, sender, delayed approval notifier | Built |
| `relay/` | `loom-relay`: TLS passthrough by server name, hub enrollment, bundle and deploy files (`relay/deploy`) | Built |
| `hub/src/relay/` | Dial-out relay client, relay streams, ACME or file certificates | Built |
| `hub/src/heuristics/` | Screen manifests (TOML), headless-terminal matcher, heuristic state for hookless CLIs | Built |
| `docs/manifests/` | Example screen manifest | |
| `client/public/` | PWA manifest, icons, service worker (`sw.js`, plain JS, not bundled) | Built |
| `tools/sdk-smoke/` | Standalone Agent SDK smoke test, run on each machine and each SDK upgrade | Built |
| `docs/adr/` | Architecture decisions, numbered from 0001 for v2 | |

## Commands

- `npm run hub:dev` and `npm run client` — hub on :7420 with data in `.loom-dev/`, Vite client on :5173. Details in [docs/dev.md](docs/dev.md). The user may be running this hub; for your own checks use `node hub/src/main.ts --home /tmp/loom-verify --port 7421`.
- `npm run build:pty` — builds the terminal sidecar; needed for terminal sessions and their tests.
- `npm run build:voce` — builds the speech sidecar (whisper.cpp; needs cmake). Optional.
- `npm run desktop:dev` / `npm run desktop:build` — the desktop app; build makes the `.deb` (Linux) or NSIS installer (Windows). See docs/dev.md.
- `npm test` — Vitest across workspaces, no model calls.
- `npm run typecheck` — `tsc` (TypeScript 7) per workspace.
- `LOOM_LIVE_SDK=1 npx vitest run hub/test/claudeLive.test.ts` — adapter against the real SDK; uses a few cents of usage.
- `cd tools/sdk-smoke && npm install && npm start` — SDK smoke test; writes `smoke-report.json`.

## Rules that shape every change

- **Protocol first.** Any new capability is a `Command` and/or `SessionEvent` in `protocol/` before it is code in the hub or client. The `loom` CLI and the Cockpit's MCP tools wrap the same commands; never add a capability to only one of them.
- **The hub core never names a CLI** (ADR-0004). Engine-specific code lives in `hub/src/adapters/<kind>/` only.
- **State is a projection of the event log** (ADR-0003). Do not keep product state that is not derivable from events, except caches.
- **Never parse terminal bytes in the hub hot path.** Heuristics are opt-in manifests, labeled `heuristic` (ADR-0011).
- **Permission level changes go through `checkLevelChange`** in `@loom/protocol`. The Cockpit can never set `full`. Never pass `bypassPermissions` to the SDK unless the level is `full`.
- **Erasable TypeScript only** (ADR-0002): no `enum`, no parameter properties, no `namespace`. Import with `.ts` extensions. Node runs the source directly.
- **Windows is first-class** (ADR-0010). No `/`-joined paths, no bash-only scripts in `package.json`, no assumptions about `$SHELL`. Use `node:path` and test on both.
- **No custom cryptography** (ADR-0008).
- **A feature ships only if it feeds the agent loop**: spawn, observe, steer, approve, review. Anything else is a real tool in a terminal session. (Lesson from v1's DocsPanel and GitPanel.)
- **Loom never commits or pushes on the user's behalf** outside a session the user started.

## Conventions

- Conventional commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`), scoped when useful: `feat(hub): …`.
- Work on `feat/*` or `fix/*` branches; `main` stays green.
- Tests next to the package in `<pkg>/test/`. The hub gets a fake adapter so Steward, Cockpit, and approval logic are tested without a model.
- Keep docs short. PLAN.md is the only long document; split it if it passes 1,000 lines.

## Findings worth remembering

- **SDK `canUseTool` `title` arrives empty** (smoke test, 2026-09-12). Build approval summaries from tool name and input.
- **The SDK loads user settings, hooks, plugins, and claude.ai connector MCP servers by default**, same as the CLI. Show what loaded; do not silently disable.
- User messages from a person must carry `origin: { kind: "human" }`.
- **`total_cost_usd` is cumulative per SDK process** and resets on resume; `init` repeats every turn. See ADR-0005.
- **Adapters emit engine facts; the manager emits the rest** (created, user messages, level, liveness, approvals, blocked state). See `hub/src/core/adapter.ts`.
- **The hub uses `node:sqlite`**, not `better-sqlite3`, to keep native modules out of Windows packaging.
- **Rule matching errs toward asking.** Any change to `hub/src/policy` must keep allow rules narrow and deny and ask rules broad, and needs a test in `hub/test/policyRules.test.ts`. When unsure how Claude Code behaves, check its permissions documentation rather than guessing.
- **Only a person's explicit action trusts a project allow list** (`policy.trust`, `policy.save`). Code paths that write policy on someone's behalf must not trust rules they did not show.
- **Terminal bytes never touch the event log.** They go through `TerminalBuffer` and `term` frames with byte offsets. Adapters call `host.terminalOutput`, never `host.emit`.
- **Claude Code holds hooks back until a folder is trusted**, so the Claude terminal takes the session id from any hook. See ADR-0005.
- **Windows launch rule:** programs found on PATH are spawned directly (`.cmd` through cmd.exe), never through PowerShell, which deadlocks under ConPTY when several TUIs start at once (v1 lesson).
- **The Steward's thresholds and budgets are enforced in `steward/steward.ts`, never by the prompt.** Anything that lets a verdict act must stay outside what a transcript can influence. Everything shown to the model goes through `renderReview`, which fences it as data.
- **Every new event type that changes pending approvals must be handled in both `protocol/src/projection.ts` and the client store's `apply`.** M5 missed `approval.updated` in the client once.
- **Every command a session can send is in `control/capabilities.ts`.** Adding a command means deciding its roles there; checks that need hub state (not yourself, not `full`, only where models may approve) go in the router handler.
- **Loom tool schemas must list through MCP.** Avoid `z.record` in tool shapes; the listing test in `hub/test/cockpit.test.ts` catches a tool that hides the rest.
- **The `loom` CLI never exits 2** (Claude hooks read 2 as "block") and treats v1's `loom hook …` as a no-op.
- **Solid store merges plain objects.** When replacing data from the hub (snapshots, boards, stats, status), use `reconcile`, or removed fields and resolved approvals linger.
- **No `window.prompt`, `window.confirm`, or `alert` in the client.** Blocking dialogs freeze the desktop webview (v1). Use inline two-step controls; menus close on outside click or Escape, not on mouse leave.
- **Policy, trust, and boards resolve to the main repository for worktrees** (`git/project.ts`). Never key them by a worktree path.
- **A pasted token link in an open tab only changes the hash**; the client listens for `hashchange`.
- **Shell escaping in TS test strings for `sh -c`** needs care: an extra backslash level silently changes `tr` and `printf` behavior.
- **npm workspaces:** after adding a workspace to the root `package.json`, run `npm install` once before `npm i -w <name>`, or the dependency silently lands nowhere.
- The client holds several hubs: components get their hub from `HubContext` (`useHub`), and anything that spans hubs (rail, overview, approvals panel) wraps each hub's part in its own provider. Actions that open a session or board move the main area to that hub through the `onFocus` hook.
- `/loom.json` is the only unauthenticated endpoint besides static files. Keep it bare.
- In your shell, `pkill -f <pattern>` also matches the shell running the command and kills it. Kill verification processes by pid.
- The tunnel test runs a real `sshd` as the current user on a free port with keys in a temp folder; it skips when OpenSSH is missing and never touches `~/.ssh`.
- **Voice read-back only reacts to live events** (`hooks.onEvent` in the client store), never to snapshots or timeline loads, or opening a session would read its history aloud.
- **Whisper needs help with one-word clips.** Pass expected words as `prompt` (the approvals panel does). Test clips need a short lead-in; audio starting at the instant recording starts gets clipped.
- **To test voice without a microphone,** replace `navigator.mediaDevices.getUserMedia` in the page with a `MediaStreamAudioDestinationNode` playing a WAV, then hold `Ctrl+Shift+Space` with synthetic key events. Piper makes Portuguese test clips.
- **The hub runs bundled too** (`hub/scripts/bundle.mjs`, entry `hub/src/bin.ts`). Never read files relative to `import.meta.url` without a bundled fallback; `import.meta.url` points into `hub/dist` or the app's resources there. `hub/test/packaging.test.ts` runs the bundle.
- **The Agent SDK finds `claude` through its platform npm package,** which a bundle does not have; packaged hubs pass `LOOM_CLAUDE_EXECUTABLE` to SDK sessions and the Steward.
- **WebKitGTK (Linux desktop):** no microphone for hidden pages, and `MediaRecorder`/`decodeAudioData` never finish, so capture goes through Web Audio. Screenshots of the window need `gnome-screenshot -w` on the focused window; `xwd` shows white.
- **Match `pgrep -f` patterns at the start** (`^\./target/debug/loom$`) when killing processes from your shell.
- **Web push needs a browser with a push service.** Automation Chromium has none ("push service not available"); test the hub side with a fake push service that decrypts (`hub/test/push.test.ts`, or an HTTPS one trusted via `NODE_EXTRA_CA_CERTS`), and `client/public/sw.js` with the VM harness in `client/test/serviceWorker.test.ts`.
- **Every 127.x address is loopback**, so tests of "network" listeners pass hosts explicitly (`tls.hosts`) instead of relying on address checks.
- **Preview snapshots are huge** once the page has logged many console errors; prefer `preview_evaluate` for checks and take screenshots sparingly.
- **Never `unshift` bytes into a real socket and hand it to a TLS or HTTPS server:** Node reads the native handle and skips them. Wrap it with `withPrefix` (`relay/src/prefixed.ts`, `hub/src/relay/prefixed.ts`).
- **To tag requests with facts about their connection** (the relay's visitor address), give the connection its own server object and set a WeakMap in its `request`/`upgrade` handlers. `req.socket._parent` is not the wrapped stream.
- **Two opposite `pipeline()` calls on one socket pair** leak end-of-stream listeners (MaxListenersExceeded); splice with `pipe()` both ways and handle close and error once.
- **`*.localhost` resolves to loopback here,** which makes relay and ACME names testable without DNS; Pebble plus `pebble-challtestsrv` validates HTTP-01 through the relay for real.
- **Never type literal control characters into files or commands** (the search snippet markers U+0001/U+0002): the tool refuses them and they vanish in review. Write `String.fromCharCode(1)` or `\u0001`.
- **Vitest here has no Solid plugin:** tests import from `.ts` files, never `.tsx` components; move testable helpers to `client/src/lib/`.
- **Navigating the preview to the same page with a new hash does not reload it;** call `location.reload()` after rebuilding the client.
- **Screen manifest patterns should be anchored** (`…\(y/n\)$`): an answered prompt stays on screen and would keep matching.
