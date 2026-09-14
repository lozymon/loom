# Approvals go rules, then Steward, then human; four permission levels

**Status:** Accepted (2026-09-12).

The work machine cannot use "allow without prompt", and a fleet of sessions produces more prompts than a person can answer one by one. v1 had Approvals raised by agents and Clearances raised by Loom; this ADR is about Approvals.

## Decision

Every permission prompt and clarifying question from any session enters **one hub-wide queue** and passes through up to three stages. Each resolution is logged with its resolver (ADR-0003).

1. **Rules.** Deterministic allow, deny, and always-ask lists, per hub and per project, in Claude Code's permission rule syntax. Deny beats everything. Always-ask skips stage 2.
2. **Steward.** A model session (default `claude-sonnet-5`) sees the request, the session's card and recent events, and the policy. It returns allow, deny, or escalate with a recommendation. It has a per-session confidence threshold and budgets (approvals per hour, spend per day). For questions it answers only when a stated preference exists; otherwise it drafts an answer and escalates. **The model stage is a per-hub switch and is off on the work hub.**
3. **Human.** A card on every attached client, and by voice. Allow, Allow always (persists the engine's suggested rule), Deny with message, Edit input, Answer. Timeout policy per session: wait forever (default), deny after N minutes, or Steward decides after N minutes.

**Permission levels**, per session, changeable at runtime:

| Level | Engine mode | Stage 2 | Human sees |
|---|---|---|---|
| `supervised` | default | off | every unresolved prompt |
| `accept-edits` | acceptEdits | off | non-edit prompts |
| `assisted` | default | on | escalations only |
| `full` | bypassPermissions | off | nothing; deny rules still apply |

- Each hub has a **default level** (work: `supervised`; home: `assisted`) and a **maximum level** (work: `accept-edits`).
- Humans may raise a level up to the hub maximum. **The Cockpit may too, except to `full`**, which always needs a human. Lowering is always allowed. Implemented once, in `checkLevelChange` in `@loom/protocol`.

### Rules as built (M3, 2026-09-12)

- **Subset of Claude Code's syntax, erring toward asking.** Allow rules match narrowly: every subcommand of a compound command must match, and commands with substitutions, groups, heredocs, dangling operators, or file redirects are never auto-allowed. Deny and ask rules match broadly: any subcommand, commands nested in substitutions and groups, and forms with wrappers (`timeout`, `nohup`, …) and environment assignments stripped. Paths follow gitignore anchors (`//`, `~/`, `/`, relative), bare names match at any depth, and deny also checks symlink targets. Rules Loom cannot evaluate are reported as problems and skipped.
- **Rule decisions are logged** as a request and its immediate resolution with resolver `rule` and the matching rule, so history shows "Denied by rule Bash(rm *) · hub policy". Claude receives the rule in the denial message.
- **Clarifying questions are never judged by rules.**
- **"Always allow"** saves a rule to project or hub Loom policy, prefilled from Claude Code's own suggestion when it offers one, editable before saving. Claude Code's own "save in settings" remains a second option. Neither is offered when an ask rule matched.
- **Timeouts** come from the session spec, then project policy, then hub policy. The only action is `deny` until the Steward exists.
- **A policy file that stops parsing keeps its last good deny and ask rules** for the life of the hub process and drops its allow rules, so a typo cannot silently widen what runs.

### Steward as built (M5, 2026-09-12)

- **One stateless review per request** through the Agent SDK on the machine's Claude login: custom system prompt, no tools, no user or project settings, no saved transcript, JSON-schema output, a per-call spend cap, a 90-second timeout. About 5 to 7 seconds and 1 to 1.5 cents per review with Sonnet 5.
- **Gates before the model:** hub switch (`stewardModel`), session level `assisted`, permission prompts only, no ask rule matched.
- **The model sees** the tool call, the last 40 activity lines, the card, the project and hub deny and ask rules, and `git diff --stat`, all fenced as data; tag look-alikes inside the data are neutralized.
- **The hub, not the model, decides whether to act:** `recommend` mode (default) never acts; `decide` mode acts only at or above `minConfidence` (plus 0.05 for terminal sessions), never allows a verdict it rated high risk, and stops after `maxDecisionsPerHour` per session or `maxDailyUsd` per day. Escalations and held verdicts stay on the card as advice with a one-click accept.
- **A person can decide while the review runs;** the late verdict is dropped.
- **Timeouts can hand over:** `approvalTimeout.then: "steward"` lets the Steward decide at the deadline even in recommend mode, and denies if it will not.
- **Override** marks the Steward's allow as overridden, lowers the session to Supervised, and tells the agent to undo what it can.
- **Limits:** questions are not reviewed yet; spend and hourly counters reset when the hub restarts; only hub-level instructions exist.

## Consequences

- The Steward starts in recommend-only mode for a week of real use before it may approve.
- Rules need an editor in the UI and a "why was this allowed" link on every auto-resolved event.
- On `pty` sessions the Steward can only answer through keystrokes, so its threshold is higher there.
