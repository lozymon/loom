# Claude runs through the Agent SDK, with its TUI in a PTY beside it

**Status:** Accepted (2026-09-12).

## Context

The Agent SDK exposes Claude Code's loop as a library: structured messages, tool calls, subagents, cost, resume, runtime permission-mode changes, and a `canUseTool` callback that receives both permission prompts and `AskUserQuestion`. That callback is the foundation of the approval pipeline (ADR-0006).

A smoke test on 2026-09-12 (`tools/sdk-smoke`) passed all eight checks on the home machine with a claude.ai login (`apiKeySource: "none"`): basic query, allow and deny through the callback, shell approval, AskUserQuestion answer, resume by id, a long-lived session across turns, and permission-mode changes on a live session. Two observations shape the adapter:

- The callback's `title` field arrived empty. The hub builds approval summaries from tool name and input itself.
- By default the SDK loads user settings, hooks, plugins, and connector MCP servers, same as the CLI. That is desirable for parity, but the hub must show which were loaded.

Anthropic's documentation states that third-party products may not offer claude.ai login through the SDK unless approved. Loom uses the login already present on the user's own machine and offers no login of its own, the same footing as T3 Code. The work machine uses a Claude.ai Team login and must pass the same smoke test before M1 depends on it there.

M1 (2026-09-12) added these facts from running the adapter against the real SDK:

- `result.total_cost_usd` is cumulative within one engine process and restarts at zero on resume. The adapter adds the session's previous total as a base, so `cost.update` stays a session total.
- The `system/init` frame is re-sent on every turn. The adapter publishes `session.engine` only when the session id, model, or loaded extensions change.
- The reported model string can differ between a fresh start and a resume of the same session (`claude-opus-5[1m]` then `claude-opus-5`).
- Claude can issue several tool calls in one message; their approvals arrive one at a time, and the session stays blocked until none are open.

## Decision

- **`claude-sdk` adapter** runs each session in streaming-input mode so it stays open across turns, with `canUseTool` always set and user messages stamped `origin: { kind: "human" }` when they come from a person.
- **"Open as terminal"** on any Claude session runs `claude --resume <engineSessionId>` in a `pty` session in the same cwd. Both views share the engine session id; only one should be driving at a time, and the UI marks the other as read-only while one is working.
- **Fallback:** if the SDK path fails on a machine, Claude runs under `pty` only, with approvals through v1-style hooks. Approvals are then coarser, and the Steward's model stage is unavailable for that session.
- The hub never uses `bypassPermissions` unless the session level is `full` and the hub allows it.

### Claude's TUI in a terminal (M2)

- A terminal session with `agent: "claude"` runs `claude --settings <file>`, plus `--resume`, `--model`, and `--permission-mode` from the session. The settings file lives in the hub's data directory and holds **HTTP hooks** posting to `/hooks/<session>` on the hub, with a per-session bearer token read from `LOOM_HOOK_TOKEN`. Nothing is written to the user's own Claude settings.
- Hooks used: `SessionStart`, `UserPromptSubmit`, `Stop`, `Notification` (`idle_prompt`) for state and the session id; `PermissionRequest` and `PreToolUse` on `AskUserQuestion` wait for a Loom approval, up to an hour. If the hub cannot be reached or the hook times out, Claude shows its own prompt.
- **Claude Code holds every settings-file hook back until the folder is trusted.** In a new folder the trust dialog appears in the terminal, and `SessionStart` never reaches Loom. The adapter therefore takes the session id from any hook, and a Claude terminal starts as `idle` rather than waiting for `SessionStart`. Verified 2026-09-12.
- `claude --resume <id>` keeps the same session id, so a chat session and its terminal twin share one conversation. Verified 2026-09-12: a code word given in chat was recalled in the TUI.
- **One driver at a time.** "Open in terminal" stops the chat engine first, and the hub refuses to send to or restart a chat session while its linked terminal is running.
- A hub started from inside a Claude Code session passes that session's private variables (`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, …) to children; the hub strips them before launching terminals.

## Consequences

- The SDK version is pinned and upgraded deliberately; the smoke test runs again on each upgrade.
- Branding follows Anthropic's SDK guidelines: the UI says "Claude", not "Claude Code".
