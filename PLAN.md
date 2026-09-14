# Loom v2 — Plan (draft 2, 2026-09-12 — M12 first slice complete)

This is a plan to read and argue with. Draft 2 folds in the answers from the first drilling session; the decisions are listed in section 13 and applied throughout.

---

## 0. One paragraph

Loom v2 is a **server + thin client** development cockpit for running many AI coding sessions at once. The server (the "hub") owns every session, terminal, and approval queue on a machine. Clients (desktop, browser, later phone) are just views and can attach to one or more hubs, local or remote. Claude Code is the first-class engine, built on the Claude Agent SDK, with other CLIs plugging in through an adapter interface. A **Cockpit** session is a Claude session with tools to see, spawn, steer, and read every other session. A **Steward** answers the permission prompts and clarifying questions that other sessions raise, using rules first, a model second, and you last. Voice in and voice out, in English and Portuguese, is a first-class client feature, not a bolt-on.

---

## 1. What we are taking from each product

| From | Take | Leave |
|---|---|---|
| **Loom v1** (yours) | Agent-first thesis, control bus (`loom` CLI + MCP), provenance ladder (pushed facts > kernel facts > heuristics), task board cards that dispatch agents, coalesced PTY reader, non-blocking clearance cards, hooks installer, `loom-voce` whisper sidecar, ADR habit | Tauri-hosted PTYs in-process (ADR-0002), LAN bridge home-grown crypto, DocsPanel/GitPanel mini-apps, PLAN.md as 50 KB monolith |
| **herdr** | Background server that survives client disconnects; semantic agent state `working / blocked / idle / done`; `wait --until <state>` as the orchestration primitive; state rolled up pane > workspace > machine; saved remote machines in one window; agent detection manifests for hookless CLIs | TUI-only client; per-server ID scoping confusion |
| **T3 Code** | Threads rendered as structured chat (not a terminal) driven by the Agent SDK; per-thread permission level (Supervised / Accept edits / Auto / Full) with project overrides; approval cards pushed to every connected client; git worktree per thread; inline diff review; event-sourced backend behind typed WebSocket RPC; desktop app that spawns the backend; SSH-forward / Tailscale / relay remote options | Electron; React Native app on day one |
| **BridgeMind** | Kanban card dispatches an agent; mission prompt spawns a role-based team with a coordinator; push-to-talk local Whisper; a trivial `speak` tool so agents can talk to you | Closed source; single native app with no remote |

---

## 2. Requirements (from your message, restated)

1. Multiple Claude sessions at once, with 100 % Claude Code support.
2. Other CLIs (Codex, Gemini CLI, OpenCode, …) possible later without rewriting the core.
3. One **main Claude session** that controls the whole IDE and all open sessions (the Cockpit).
4. A session that **answers the questions Claude asks** (permission prompts, AskUserQuestion) because on your work machine you cannot use "allow without prompt".
5. Connect to **other computers** (work machine, home machine, a VPS).
6. Server / interface split like herdr: the server runs the work, the UI is only a view.
7. **Speak to it and have it read back**, English and Portuguese.
8. A full plan first, iterate before code.

9. **Native Windows support**: colleagues at work run Windows only (no WSL) and want to use the tool, each with their own hub, installed from a Windows installer.

Non-requirements for v2.0 (explicitly parked): macOS packaging, native mobile app, plugin marketplace, multi-user hubs.

---

## 3. Architecture

```
┌────────────────────────── client (desktop / browser / phone) ──────────────────────────┐
│  Sessions rail │ Session view (chat or terminal) │ Approvals dock │ Board │ Voice bar   │
│                 typed WebSocket RPC + event stream, one connection per hub              │
└──────────────────────────────┬────────────────────────────┬────────────────────────────┘
                               │ local                      │ ssh tunnel / tailscale / relay
┌──────────────────────────────▼─────────┐   ┌──────────────▼─────────────────────────────┐
│  hub  (home laptop)                    │   │  hub  (work machine)                        │
│  ┌──────────────┐  ┌────────────────┐  │   │  same binary                                │
│  │ session mgr  │  │ approval queue │  │   │                                             │
│  │ adapters:    │  │ + Steward      │  │   │                                             │
│  │  claude-sdk  │  └────────────────┘  │   │                                             │
│  │  pty         │  ┌────────────────┐  │   │                                             │
│  │  (codex…)    │  │ event log      │  │   │                                             │
│  └──────────────┘  │ (SQLite)       │  │   │                                             │
│  control bus: unix socket + MCP      │  │   │                                             │
└────────────────────────────────────────┘   └─────────────────────────────────────────────┘
```

### 3.1 Hub (server)

One long-running process per machine. Owns:

- **Session manager**: creates, resumes, stops, and forks sessions. Every session has an adapter, a workspace (directory, optional git worktree), a permission level, and a semantic state.
- **Adapters** (section 4): `claude-sdk` (structured), `pty` (any CLI in a real terminal), and later `codex`, `gemini`.
- **Approval queue + Steward** (section 5).
- **Event log**: append-only SQLite table of every session event. The UI is a projection of this log, which is what makes reconnect and multi-client trivial and gives you an audit trail for free (T3 does this with Effect; we do it with a small hand-rolled reducer).
- **Control bus**: the v1 `loom` CLI and `loom mcp` tools, re-pointed at the hub socket. Any agent running in any session can use them.
- **Board**: task cards, project-scoped in `<repo>/.loom/board.json` as in v1.
- **Voice services** (optional on the hub, see section 7): STT and TTS engines exposed as RPC so a thin client like a phone can use them.

Survives client disconnects. Sessions keep running. Reconnecting client replays the log from its last seen sequence number.

### 3.2 Client

A single web UI (SolidJS, reusing v1 components where they still fit) served two ways:

- **Desktop**: Tauri 2 shell that starts the local hub if it is not running, then loads the UI. Tauri gives us the global push-to-talk shortcut, tray icon, native notifications, and microphone access. It is a thin shell; no PTYs live in it any more.
- **Browser**: `loom serve --web` on a hub and open it in any browser. Same code.
- **Phone**: same web UI installed as a PWA, after M9. Web push for approval notifications. Native app only if the PWA proves insufficient.

The client can attach to N hubs at once. The sessions rail groups by hub, then workspace.

### 3.3 Transport

- WebSocket, JSON messages, typed with a shared `protocol.ts` (evolved from v1 `src/ipc/protocol.ts`).
- Two message families: **commands** (client → hub, request/response) and **events** (hub → client, ordered, with sequence numbers).
- Auth: bearer token generated by the hub on first run, shown once, stored in the client keychain. Local desktop attaches over a unix socket with no token.
- Remote: **do not** invent crypto again. Tier 1 is SSH port forward managed by the desktop app (T3 does exactly this). Tier 2 is Tailscale/WireGuard where the hub simply listens on the tailnet IP. Tier 3, a relay through your VPS, comes after both work and uses TLS with the hub as a dial-out WebSocket client (v1 ADR-0012's idea, finally executed).

**Decision:** hub in TypeScript on Node 24, because the Claude Agent SDK is a TypeScript/Python library and the hub calls it directly. Rust stays for the PTY sidecar (`portable-pty`, coalescing reader) and `loom-voce`; both are subprocesses the hub spawns. This keeps your two codebases' best parts and puts the product logic in one language.

---

## 4. Session adapters

The core defines one interface; each engine implements it.

```ts
interface SessionAdapter {
  kind: 'claude-sdk' | 'pty' | 'codex' | 'gemini'
  start(spec: SessionSpec): Promise<void>
  send(input: UserTurn): Promise<void>          // text, images, slash commands
  interrupt(): Promise<void>
  stop(): Promise<void>
  resume(sessionId: string): Promise<void>
  setPermissionLevel(level: PermissionLevel): Promise<void>
  events: AsyncIterable<SessionEvent>            // normalized, see below
}
```

Normalized `SessionEvent` (what the UI and Cockpit see, regardless of engine):

- `state` → `working | blocked | idle | done | error` (herdr's vocabulary, with `blocked` carrying *why*: `approval`, `question`, `input`).
- `assistant.text`, `assistant.thinking`, `tool.use`, `tool.result`, `subagent.*`
- `approval.requested`, `approval.resolved`, `question.asked`, `question.answered`
- `files.changed` (paths + diff stat), `cost.update`
- `terminal.output` (pty only; base64 bytes, never parsed by the hub)

### 4.1 `claude-sdk` adapter (the 100 % path)

Uses `@anthropic-ai/claude-agent-sdk` in streaming-input mode so the session stays open across turns. What we get for free and must expose in the UI:

- Structured messages, tool calls, subagent tree (`parent_tool_use_id`), cost.
- `canUseTool` callback: every permission prompt and every `AskUserQuestion` lands here as a promise the hub can hold open indefinitely. This is the entire basis for the Steward (section 5).
- `setPermissionMode` at runtime: maps our per-session level to `default | acceptEdits | auto | bypassPermissions`.
- Session resume and fork, hooks, MCP servers, skills and CLAUDE.md loading from the working directory, exactly as the CLI does.
- `PermissionRequest` hook for push notifications when something is waiting on a human.

Two things to be honest about:

1. **Auth.** Anthropic's docs say third-party products may not offer claude.ai login through the Agent SDK. Both your machines use subscription login (work: Team plan with org-managed settings). For a personal tool this is the same footing T3 Code is on. The hub inherits the machine's existing Claude Code credentials and does nothing clever. **M1 task 1** is a smoke test of the SDK on the work account; if it fails, Claude at work runs through the `pty` adapter with the real TUI, which still gets rules + human approvals through hooks.
2. **Work policy.** Your org disabled "allow without prompt". Decision: the work hub runs the Steward in **rules + human only** mode; no model approves anything there. The Steward's model stage is a per-hub setting that is simply off on the work hub.

Claude is runnable **both ways from day one**: the SDK chat view is the default, and every Claude session has "open as terminal", which starts `claude --resume <id>` in a PTY pane for slash menus, `/config`, plugin UI, and as the auth fallback above. This moves the `pty` adapter forward to M2 in the milestones.

### 4.2 `pty` adapter (any CLI, and Claude's own TUI)

The v1 pane: a real PTY, xterm in the client, byte-opaque in the hub. Agent state comes from three tiers, straight from v1:

- Pushed: Claude Code hooks (`loom hooks --install`), MCP calls to `loom`.
- Kernel: foreground pgrp, cwd, exit code.
- Heuristic: herdr-style screen manifests (TOML) matched against the bottom of the buffer, per CLI, opt-in, always labeled.

A `pty` session that is `blocked: approval` can be answered by the Steward with `send-keys` (herdr's community pattern). It is less precise than the SDK callback, so the Steward's confidence threshold is higher for PTY sessions.

### 4.3 Future adapters

`codex` (its app-server JSON protocol) and `gemini` (its ACP/agent protocol) each become structured adapters when we get there. Until then they run under `pty`. The rule: **the core never learns a CLI's name**; only adapters and manifests do.

---

## 5. Approvals and the Steward

Every `approval.requested` or `question.asked` event from any session lands in one hub-wide queue. The queue is resolved by a three-stage pipeline, and every stage writes an audit row.

```
request ──► 1. Rules ──► 2. Steward model ──► 3. Human (all clients + voice)
             deterministic     Claude, cheap        with timeout policy
             allow/deny/pass   allow/deny/escalate  allow/deny/edit/always
```

**Stage 1, rules.** Declarative, per hub + per project (`.loom/policy.json`): allow lists (`Bash(git status *)`, `Read(**)`), deny lists (`Bash(rm -rf *)`, `Edit(//etc/**)`), and "always ask a human" lists (`Bash(git push *)`, anything touching `.env`). Same rule syntax as Claude Code's `settings.json` so nobody learns two grammars. The SDK's `suggestions` array (its own proposed "always allow" rule for this call) is surfaced so a human answer of "always" persists the rule.

**Stage 2, Steward model.** A dedicated Claude session (`claude-sonnet-5` by default, configurable per hub; disabled on the work hub) that receives: the tool name and input, the requesting session's current task card and last N events, the project policy, and the diff-so-far. It returns one of `allow`, `deny(reason)`, `escalate(reason, recommendation)`. Design constraints:

- It never sees more authority than the requesting session's permission level allows.
- It has a per-session **confidence threshold** and a **budget** (max auto-approvals per hour, max cost per day) after which it escalates everything.
- For `AskUserQuestion` it may answer only when the card or the Cockpit has stated a preference; otherwise it escalates. It can, however, draft the recommended answer so you just confirm.
- Its decisions are visible as normal events in the requesting session's view, with a "that was the Steward" badge and a one-click **override** that reverses and denies.

**Stage 3, human.** Approval card pushed to every attached client. Card shows tool, input (diff rendered for edits, command highlighted for Bash), Steward's recommendation, and buttons: Allow once, Allow always (persists rule), Deny, Edit input, Answer by voice. Timeout policy per session: `wait forever` (default), `deny after N min`, or `steward-decides after N min`.

Per-session **permission level** (T3's four, mapped to SDK modes):

| Level | SDK mode | Rules | Steward | Human |
|---|---|---|---|---|
| Supervised | `default` | yes | off | every prompt |
| Accept edits | `acceptEdits` | yes | off | Bash and others |
| Assisted | `default` | yes | **on** | escalations only |
| Full | `bypassPermissions` | deny rules still apply | off | never (blocked on the work hub) |

**Default level is per hub:** Supervised on the work hub, Assisted on the home hub. Level is changeable per session at any time.

**Decision:** the Steward is a *service inside the hub*, not a visible pane. It is a Claude session under the hood so you can open its transcript and argue with it, but it does not occupy screen space.

---

## 6. The Cockpit

A normal `claude-sdk` session, pinned at the top of the rail, with an extra MCP server (`loom mcp`, hub-scoped) that gives it these tools:

- `list_sessions` (state, workspace, cost, last event), `read_session(id, last N | since seq)`, `wait_until(id, state, timeout)`
- `set_permission_level(id, level)`, capped at the hub's configured maximum; Full is never reachable from the Cockpit
- `spawn_session(spec)` including optional worktree and permission level, `send(id, text)`, `interrupt(id)`, `stop(id)`. Sessions run in the repo directory by default; a worktree is created only when the spec or the card asks for one.
- `approvals_pending`, `answer_approval(id, decision)`, `answer_question(id, answers)`
- `board_*` and `note_*` from v1 (cards, shared blackboard), `claim_file` / `release_file`
- `speak(text, lang?)` to talk to you, `notify(text)` to push
- `hub_list`, and the same tools addressed at a remote hub (`hub: "work"`)

A "mission" is just a prompt to the Cockpit: *"Take card #12, spin up a builder in a worktree, a reviewer after it finishes, escalate anything about payments to me."* The Cockpit uses the tools above; there is no separate swarm engine. This is the BridgeSwarm idea without a new subsystem: roles are session specs with a system-prompt suffix, and coordination is `wait_until` plus report files, which herdr's community found more reliable than process state.

Each session also gets the normal v1 control bus (`loom send`, `loom card`, …) on its PATH so sibling sessions can coordinate without the Cockpit.

---

## 7. Voice

Two directions, both bilingual, both usable from any client.

### 7.1 Speech to text

- **Engine**: whisper.cpp through `loom-voce` (already yours, already Linux-tested). Model `medium` or `large-v3-turbo` quantized; auto language detection between `en` and `pt` is native to Whisper, no switch needed. Your GTX 1650 (4 GB) runs `medium` comfortably and `large-v3-turbo` at int8.
- **Cloud fallback**: Groq transcription for machines without a GPU (the work laptop, a phone).
- **Where it runs**: on the client by default (desktop has the mic and the GPU), on the hub as an RPC for thin clients.
- **Modes**: push-to-talk on a held global shortcut (default `Ctrl+Shift+Space`, Tauri). Transcript lands in the composer as editable text and is sent with Enter. Trailing command words ("send" / "enviar") auto-send only if you opt in. Wake word hands-free mode is parked for after v2.0.
- **Targets**: the focused session, the Cockpit, or an approval card ("allow", "deny", "permitir", "negar").

### 7.2 Text to speech

- **Engine**: Piper (CPU, fast, offline) with one English voice and one **`pt_BR`** voice. OpenAI TTS as the cloud option for nicer voices or GPU-less machines. Command words and prompts are written in Brazilian Portuguese.
- **Language selection**: detect per utterance with a tiny classifier (Portuguese vs English is easy) and pick the matching voice; the `speak` tool can also force `lang`.
- **What gets read**: opt-in per event class. Defaults: escalated approvals ("the builder wants to run git push on ruleshub"), session done/error, direct `speak()` calls from the Cockpit. Never tool output.
- **Where**: client plays audio; synthesis on client if Piper is installed, else hub.

### 7.3 Voice UX rules

- Everything spoken is also written. Voice never has information the screen lacks.
- One mute switch, one "stop talking" key, a per-hub quiet-hours setting.

---

## 8. UI

Keep the v1 look and components where they still make sense (rail, xterm pane, board, clearance dock). New pieces:

- **Session view, two renderers**: *chat* for structured adapters (messages, collapsible tool calls, subagent tree, inline diffs, cost) and *terminal* for `pty`. A structured session can pop open a terminal tab into its worktree.
- **Approvals dock**: hub-wide queue, keyboard-first, with Steward recommendation visible.
- **Diff review panel** per session, per file, accept/revert hunk, "open in editor". This replaces GitPanel; commit/PR creation is delegated to the session itself.
- **Hub switcher** with saved machines and connection state, like herdr's remote list.
- **Voice bar**: mic state, live partial transcript, language badge, target selector.
- **Overview**: grid of all sessions across all hubs with state color and last line, plus per-hub cost. The one screen you glance at.
- **Cost**: per session in the session header, per hub in the overview, a per-day counter in the status bar.
- **Names**: sessions get a stable handle from the v1 name pool (Faye, Cleo, Wade…) used by `loom send <name>`; the card title or first prompt is shown as a subtitle.

Config lives in two places: `~/.config/loom/hub.json` for hub-wide settings (defaults, Steward, voice, hub max permission level) and `<repo>/.loom/` for policy, board, and project overrides. Project overrides hub.

---

## 9. Tech stack

| Part | Choice | Why |
|---|---|---|
| Hub | TypeScript, Node 24, single package | Agent SDK is native; one language for product logic |
| RPC | WebSocket + JSON, hand-typed protocol, zod validation | Simple, debuggable, same in browser and Tauri |
| Persistence | SQLite via Node's built-in `node:sqlite`, event log + projections | Reconnect, audit, history search; no native module to package |
| PTY | Rust sidecar from v1 `pty.rs` + `portable-pty`, talks to hub over unix socket | Keep the coalescing reader that already survives floods |
| Client | SolidJS + Vite + TypeScript, xterm canvas | Reuse v1 skills and components |
| Desktop shell | Tauri 2 | Small, you know it, global shortcuts, tray, mic permission |
| STT | `loom-voce` (whisper.cpp), cloud optional | Already built |
| TTS | Piper, cloud optional | Offline, pt + en voices |
| Tests | Vitest (hub + client), a fake adapter for end-to-end scenarios | The fake adapter lets Steward and Cockpit tests run without a model |
| Repo | Monorepo: `hub/`, `client/`, `desktop/`, `sidecars/pty`, `sidecars/voce`, `protocol/`, `docs/adr/` | |

Rejected: Electron (size, you already have Tauri), Effect (T3 uses it; too much to learn while rewriting), Bun (not installed, Node is fine), Python hub (SolidJS client and protocol sharing want TS).

---

## 10. Milestones

Each milestone ends with something you can use daily. Rough sizes assume one person plus Claude sessions doing most typing.

| # | Milestone | You can… | Size |
|---|---|---|---|
| M0 | Domain model + ADRs + protocol | read `docs/` and disagree before code | 2–3 days |
| M1 | Hub + `claude-sdk` adapter + browser chat UI with minimal Allow/Deny cards, local only. **Task 0: SDK smoke test on the work account.** | run Claude sessions in the browser, resume them, see tools and cost | 1 week |
| M2 | `pty` adapter + xterm pane + hooks; "open as terminal" for Claude sessions; Linux and Windows (ConPTY) with a Windows CI job | run Claude's real TUI, plain shells, or any CLI beside the chat view, on both OSes | 1.5 weeks |
| M3 | Approval queue + rules + human cards | answer prompts from the UI, "always allow" persists | 3–4 days |
| M4 | Multi-session, optional worktrees, rail, overview, board dispatch | run five sessions on five cards in parallel | 1 week |
| M5 | Steward (home hub only) | leave Assisted sessions alone and only see escalations | 4–5 days |
| M6 | Cockpit MCP tools + `loom` CLI on the new bus | tell the Cockpit to run a mission | 4–5 days |
| M7 | Remote hubs: token auth, SSH forward from desktop, Tailscale; per-hub defaults | attach to the work machine from home | 4–5 days |
| M8 | Voice: STT push-to-talk, TTS for escalations, en + pt_BR | talk to the Cockpit, hear approvals | 1 week |
| M9 | Tauri desktop shell, autostart hub, tray, `.deb` **and Windows NSIS installer** with bundled hub | install it on Linux and Windows, replace v1, hand it to colleagues | 1 week |
| M10 | PWA on phone with web push | approve from the couch | 3–4 days |
| M11 | Relay through `furevikstrand.cloud` | reach the work hub when SSH and Tailscale are blocked | 4–5 days |
| M12 | Polish: history search, diff review, notifications, quiet hours, heuristic manifests for hookless CLIs | daily driver | ongoing |

Later: Codex/Gemini structured adapters, wake word, local speech engines on Windows, macOS.

Order rationale: M1 retires the biggest risk (SDK auth at work) in its first task. M2 comes right after because Claude's TUI in a pane is both a feature and the fallback. M1–M4 already beat v1 for Claude work. M5 and M6 are the two features no competitor ships as a unit. M7 before M8 because the work-machine use case blocks on remote, not on voice.

**Switch-over rule:** v1 stays the daily driver until M4; at M9 v2 installs as `loom` and v1 is retired.

---

## 11. What is reused from v1, concretely

- `src-tauri/src/pty.rs` → `sidecars/pty` (strip Tauri channel, emit over socket)
- `src/ipc/protocol.ts` → seed of `protocol/`
- `src/lib/paneControl.ts` routing + name pool → hub session manager
- `cli.rs` and `mcp.rs` verbs → same verbs, new transport; add `wait_until`, `answer_*`, `spawn_session` with worktree
- `stores/board.ts`, `BoardPanel`, `ClearanceDock`, `WorkspaceRail`, `Terminal`, `CommandPalette`, `ShortcutsOverlay` → client, adapted to hub events
- `hooks --install` profile → unchanged in spirit, pushes to the hub
- `loom-voce` → `sidecars/voce`, plus a Piper wrapper next to it
- ADRs 0003 (coalesced output), 0004 (login shell), 0005 (shortcut namespace), 0006 (canvas), 0008 (agents first-class), 0009 (SQLite), 0011 (heuristics labeled) → carried forward as v2 ADRs with updated numbering
- Dropped: `lanbridge.rs`, `lansec.rs`, `DocsPanel`, `GitPanel`, `capture.rs`, detachable windows (revisit later), the mobile Expo app

---

## 11b. The work machine: Windows + WSL Ubuntu

The work computer runs Windows with `claude` inside WSL Ubuntu. Consequences:

- **Hub runs inside WSL.** Same Linux binary as at home, same PTY sidecar, no Windows port of the hub needed. `claude` and its Team login already live there.
- **Client at work is the browser**, opened in Windows at `http://localhost:<port>`; WSL2 forwards localhost automatically. No Tauri build for Windows in v2.0. Lost with the browser client: the global push-to-talk key (the page must be focused) and the tray icon. Both acceptable at work.
- **Voice at work goes through the browser.** WSL has no microphone, so the mic is captured with `getUserMedia` in the Windows browser and the audio is sent to the hub, which forwards it to Groq (no GPU in WSL). For read-back, the browser's built-in Web Speech API is a zero-install first option (Edge ships good `pt-BR` and `en-US` voices); OpenAI TTS through the hub is the upgrade. This makes the browser client's voice bar a required part of M8, not a nice-to-have.
- **Reaching the work hub from home** is the hard part. WSL2 sits behind Windows NAT, so plain SSH needs `sshd` in WSL plus a Windows `netsh portproxy` and firewall rule, and Tailscale must be installed inside WSL, not on Windows. Corporate policy may block both. Because the **relay** (M11) has the hub dial out over TLS and needs nothing inbound, it may need to move ahead of M10 if M7 proves painful at work. Decide after trying M7 for a day.
- **Windows terminals** (PowerShell, cmd) can still be run as `pty` sessions from WSL via `powershell.exe`, if ever useful.
- **Path mapping.** Repos under `/home/...` in WSL are fine; repos under `/mnt/c/...` are slow for git and file watching. Recommend keeping work repos inside the WSL filesystem.

## 11c. Native Windows (colleagues)

Colleagues run Windows with no WSL, each with their own hub. Single-user per hub stays; nothing is shared except what they commit in `.loom/` (policy, board), which is how a team shares allow lists without a server.

- **Hub on Windows.** Node runs natively; Claude Code runs natively on Windows (it requires Git for Windows for its Bash tool, which the installer checks for). The control bus uses a named pipe on Windows and a unix socket elsewhere, exactly as v1's `control_transport.rs` already does. Data goes to `%APPDATA%\loom`.
- **PTY sidecar on Windows.** `portable-pty` uses ConPTY. Default shell is PowerShell, with Git Bash and cmd selectable. v1's known gap carries over: no `/proc`, so the kernel "busy" floor needs a Windows implementation (`sysinfo` or `NtQueryInformationProcess`) or is marked unavailable and the hooks tier carries the load. Since Claude sessions on the SDK path report state themselves, this gap only affects `pty` sessions.
- **Desktop shell.** Tauri NSIS installer, the same path v1 ships. The installer bundles the hub as a Tauri `externalBin`, built with Node's single-executable feature so no Node install is required. The app starts the hub on launch and keeps it alive in the tray; closing the window does not stop sessions.
- **Voice on Windows.** Tauri gives mic access and the global push-to-talk key. Local whisper.cpp on Windows exists in `loom-voce` but is compile-verified only; v2.0 ships **cloud speech (Groq + OpenAI) as the Windows default** and local engines as opt-in once tested. Web Speech API in the webview is the zero-cost read-back fallback.
- **Steward on colleagues' machines** follows the same work-hub rule: rules + human only, unless they choose otherwise on a personal machine.
- **CI.** A Windows build job from M2 onward (hub tests, PTY sidecar, installer), so Windows never becomes a "port later" item again.
- **Your own work machine** can then run either way: hub in WSL with the browser, or the Windows installer natively. Native is simpler for voice and for reaching the machine from home; WSL keeps your existing `claude` setup. Try native first once M9 ships.

## 12. Risks

- **Agent SDK auth on the work machine.** Test on day one of M1 with the real work account before building anything else on the SDK path. Fallback is the PTY adapter.
- **Steward wrongly approving something.** Mitigated by deny rules that beat the model, budgets, the always-ask list, full audit, and default level Supervised. Start with the Steward in recommend-only mode for a week before letting it approve.
- **Scope.** v1 grew mini-apps. Rule for v2, borrowed from your own ASSESSMENT.md: a feature ships only if it feeds the agent loop (spawn, observe, steer, approve, review). Everything else is a pane running a real tool.
- **Two codebases at once.** v1 stays as the daily driver until M3; then v2 must be good enough to switch, or the plan is wrong.
- **Voice on the work laptop.** No GPU and no mic inside WSL: browser mic capture plus Groq STT and Web Speech / OpenAI TTS (section 11b).
- **Inbound access to WSL from home** may be blocked by corporate policy; the dial-out relay is the escape hatch.
- **Windows as a second first-class OS** roughly doubles the platform surface for PTY, paths, shells, and packaging. Mitigated by a Windows CI job from M2 and by the SDK path not depending on the PTY sidecar at all.

---

## 13. Decisions from drilling session 1 (2026-09-12)

| # | Question | Decision |
|---|---|---|
| 1 | Name and binary | Keep **Loom**; v2 replaces v1 as `loom` at M9 |
| 2 | Work machine auth | Claude.ai Team subscription login with org-managed settings; SDK smoke test is M1 task 1, PTY TUI is the fallback |
| 3 | Steward on the work hub | **Rules + human only**, model stage off |
| 4 | Default permission level | Per hub: **Supervised at work, Assisted at home** |
| 5 | Claude chat view vs TUI | **Both from day one**; chat is default, "open as terminal" runs the TUI in a PTY |
| 6 | Portuguese variant | **pt_BR** |
| 7 | Voice input | Hold `Ctrl+Shift+Space`, editable transcript, send with Enter; command-word auto-send opt-in |
| 8 | Worktrees | **Only when asked** by a spec or card |
| 9 | Remote | **SSH forward + Tailscale first**; VPS relay is M11 |
| 10 | Client framework | **SolidJS** |
| 11 | Phone | **PWA** after M9, web push |
| 12 | Steward model at home | **`claude-sonnet-5`**, configurable per hub |
| 13 | Config layout | `~/.config/loom/hub.json` for hub-wide settings; `<repo>/.loom/` for policy, board, and project overrides (committable). Project overrides hub. |
| 14 | Cloud speech fallback | **Groq** for STT, **OpenAI** for TTS, used when no local GPU or when chosen |
| 15 | Session naming | v1 **name pool** as the stable handle (`loom send faye`); card title or first prompt as subtitle |
| 16 | Cockpit changing permission levels | May raise a session only up to the **hub max**, never to Full. Work hub max is Accept edits. Full is always a human click. |
| 17 | Cost display | **Per session** in the header, **per hub** in the overview, **per day** counter in the status bar |
| 18 | Work machine platform | **Windows + WSL Ubuntu**: hub in WSL, browser client on Windows, browser mic + cloud speech, relay may move up (section 11b) |
| 19 | Colleagues on pure Windows | **Each runs their own hub**, installed from the **Tauri NSIS installer** with the hub bundled. Native Windows is v2.0 scope with CI from M2 (section 11c). |

No open questions remain for v2.0.

---

## 14. Next step

M12's first slice is done (2026-09-13): history search across hubs (FTS5 over the log, accents ignored), a Changes view per session with hunk and file reverts and a per-turn changed-files count, and screen manifests that give terminal CLIs without hooks a heuristic state from a headless terminal. Verified live with a Haiku session's real edit, a search that jumped to the prompt, and a fake CLI moving through working and needs-approval. M12 continues as daily use asks for it.

M11 is done (2026-09-13): `relay/` gives a hub that can only dial out a public https name. It routes on the TLS server name and forwards ciphertext; the hub terminates TLS with its own Let's Encrypt certificate, obtained by HTTP-01 through the relay (ADR-0014). Verified on this machine end to end with a throwaway CA, and with Pebble issuing a real ACME certificate through the relay. Not deployed to the VPS. M12 (polish) is next.

M10 is done (2026-09-13): the client installs as a PWA with a phone layout; a hub pushes approvals that still wait for a person after a short delay, encrypted by `web-push`; tapping one opens the approvals panel on it; a QR code signs a phone in; the hub can serve TLS from certificate files and understands a local proxy such as `tailscale serve`. Verified with a real hub pushing to a local fake push service that decrypted each message, and in a phone-sized browser; no real phone or push service was available. M11 (relay) is next.

M9 is done (2026-09-13): a Tauri desktop app that attaches to a running hub or starts a bundled one and signs in by itself, keeps it in the tray, stops it on quit or crash, delivers `Ctrl+Shift+Space` globally, and is the `loom` CLI with arguments. A 151 MB `.deb` bundles Node, the hub, the client, both sidecars, and the Agent SDK's `claude` binary. Verified on this machine from the build output; the `.deb` is not installed and the Windows installer has never been built. M10 (PWA) is next.

M8 is done (2026-09-13): push-to-talk in the browser client, speech recognized on a hub by local whisper (`sidecars/voce`) or Groq with English and Portuguese told apart per clip, "allow" and "deny" by voice in the approvals panel, a `speak` tool, and read-back of approvals, finished sessions, and speech with the browser's voice, Piper, or OpenAI. Verified in the browser with whisper and Piper on this machine; Groq and OpenAI are tested against fake servers only. M9 (desktop app and installers) is next.

M7 is done (2026-09-12): hubs listen on loopback, Tailscale, or (with explicit opt-in) another address; bad tokens are limited per address; `loom tunnel` keeps an SSH forward to a remote hub; and one client shows several hubs, with the overview and approvals across all of them. Verified in the browser with two hubs, one through a real SSH tunnel that was cut and came back. Tailscale was not available to test. M8 (voice) is next.

M6 is done (2026-09-12): the Cockpit, session tokens with a capability table, `loom` tools for every session in process, over stdio MCP, and as a CLI, with notes, claims, and labeled messages. A real mission (two worktree sessions, wait, report) and the role limits were verified with real models. M7 (remote hubs) is next.

M5 is done (2026-09-12): the Steward reviews Assisted sessions' permission prompts with a model, in recommend or decide mode, with hub-enforced thresholds and budgets, timeout hand-off, and override. Verified with real models. M6 (Cockpit tools and the `loom` CLI) is next.

M4 is done (2026-09-12): sessions in git worktrees, a rail grouped by project with rename and archive, an overview with activity and cost today, and project boards whose cards dispatch sessions and follow them, with a run cap. Five parallel cards verified with real Claude. M5 (the Steward) is next.

M3 is done (2026-09-12): permission rules in Claude Code's syntax from hub and project policy files, trust for committed allow lists, rules saved from approval cards, approval timeouts, a keyboard-driven approvals panel, and a policy editor. Verified with real Claude. M4 (multi-session work: optional worktrees, overview, board dispatch) is next.

M2 is done (2026-09-12): terminal sessions through a Rust PTY sidecar, Claude's TUI in a terminal with state and approvals flowing through HTTP hooks, open-in-terminal from chat, and a CI workflow for Linux and Windows. Windows has not executed yet. M3 (rules, policy files, always-allow persistence, timeouts) is next.

M1 is done (2026-09-12): a hub on Node with the Claude SDK adapter, event log, approvals, and a browser client, verified end to end against a real Claude session. The work-machine smoke test is still pending. M2 (PTY sessions and Claude's TUI in a terminal) is next.

M0 is done: ADRs in `docs/adr/`, protocol in `protocol/`, glossary in `CONTEXT.md`, and an Agent SDK smoke test in `tools/sdk-smoke/` that passed 8/8 on the home machine. M1 is next; its task list is `docs/milestones/M1.md`, and its first task is running the smoke test on the work machine.
