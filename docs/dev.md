# Developing Loom v2

Requires Node 24 and a Rust toolchain. From the repo root:

```sh
npm install
npm run build:pty   # the terminal sidecar; without it, terminal sessions are unavailable
```

## Run the hub and client

Two terminals:

```sh
npm run hub:dev     # hub on 127.0.0.1:7420, data in .loom-dev/, restarts on source changes
npm run client      # Vite dev client on http://localhost:5173, proxies /ws to the hub
```

The first hub run creates `.loom-dev/hub.json` and prints a one-time link with an access token. Open the `dev client` link. The client stores the token in the browser and removes it from the address bar.

To get a new token, stop the hub and run:

```sh
node hub/src/main.ts --home .loom-dev --new-token
```

To serve the built client from the hub itself, as a release would:

```sh
npm run build
npm run hub:dev     # then open the "open" link
```

The hub prints where it found the terminal sidecar. It looks at `LOOM_PTY_BIN`, then `sidecars/pty/target/release`, then `target/debug`, then next to the Node executable.

If you are running `hub:dev` yourself, start any second hub on another folder and port, for example `node hub/src/main.ts --home /tmp/loom-verify --port 7421`, and point Vite at it with `LOOM_HUB_PORT=7421 npm run client`.

Without `--home`, the hub uses the real locations: `~/.config/loom` and `~/.local/share/loom` on Linux, `%APPDATA%\loom` on Windows.

## Hub settings

`hub.json` defaults are cautious: `defaultLevel` is `supervised`, `maxLevel` is `accept-edits`, and `stewardModel` is `false`. On a personal machine you may want:

```json
{ "defaultLevel": "assisted", "maxLevel": "full" }
```

Unknown keys are rejected so typos do not pass silently.

## Session kinds

| Kind | What runs | State comes from |
|---|---|---|
| Claude chat | Claude through the Agent SDK | the SDK |
| Claude terminal | `claude` in a PTY with Loom's HTTP hooks | Claude Code hooks |
| Terminal | your login shell, or a command | the process; exit ends the session |

A Claude terminal in a folder Claude has not trusted yet shows the trust dialog first. Hooks, and so approvals in Loom, start after you accept it.

## Policy and rules

Rules use Claude Code's permission syntax. Hub rules go in `policy.json` next to `hub.json`; project rules in `<project>/.loom/policy.json`. Both can be edited from a session's Policy button.

```json
{
  "allow": ["Read", "Bash(npm test *)"],
  "deny": ["Read(./.env)", "Bash(rm *)"],
  "ask": ["Bash(git push *)"],
  "approvalTimeout": { "minutes": 15, "then": "deny" }
}
```

- Deny wins over ask, and ask over allow.
- A project's allow rules do nothing until someone trusts them on this hub; the session shows a banner when that is the case.
- "Always allow…" on an approval card saves a rule, editable first.
- Rules only judge permission prompts that reach Loom. Claude Code's own settings still apply first inside Claude.

## The Steward

Off unless `hub.json` says otherwise. On a personal machine:

```json
{
  "maxLevel": "full",
  "defaultLevel": "assisted",
  "stewardModel": true,
  "steward": { "mode": "recommend", "model": "claude-sonnet-5", "minConfidence": 0.85, "maxDecisionsPerHour": 30, "maxDailyUsd": 2 }
}
```

- It only reviews sessions at level Assisted, and only permission prompts no rule decided.
- Start in `recommend` mode: it advises on each card and you accept or not. Switch to `decide` once its advice has matched yours for a while.
- `instructions` in the `steward` block adds your own guidance, for example "never allow docker commands".
- Each review costs about a cent with Sonnet 5 and shows in the overview as Steward spend.
- On the work hub leave `stewardModel` false.

## The Cockpit and the loom tools

- **Start the Cockpit** with "✦ Start Cockpit" at the top of the rail. It is a Claude chat session with tools over every session: tell it what you want done and it starts sessions, waits for them, and reports.
- **Every Claude session** gets the `loom` tools for coordination: list and read sessions, message another session, shared notes, file claims, and board cards. Terminal sessions get the same as a `loom` command.
- **What the Cockpit cannot do:** change policy or trust, set Full, decide approvals on a hub with the Steward off, or decide ask-rule matches or its own approvals.

```sh
loom list
loom notes plan "api by Faye, ui by Cleo"
loom claim src/api.ts working on routes
loom send Faye "the schema changed, pull before you continue"
```

- **Loom v1 leftovers:** if your Claude settings still have v1's `loom hook …` hooks, v2 ignores them inside its sessions. Remove them once v2 replaces v1. A v1 `loom-commands` skill can also confuse agents; remove it at the same time.
- **Debugging an SDK session:** start the hub with `LOOM_DEBUG_SDK=1` to log every Agent SDK message to stderr.

## Worktrees and boards

- **Worktree sessions:** tick "Run in a git worktree" when creating a session, or "Run in its own worktree" on a card. Worktrees go under the hub's data directory, one per branch, and share the main repository's policy, trust, and board.
- **Boards:** open one from a project heading in the rail, or type a folder into "Open board" on the overview. Cards are saved in `.loom/board.json`, which you can commit.
- **Run:** "Run to-do cards" keeps up to N cards going until the to-do lane is empty. It is not saved, so opening a repo never starts sessions by itself.
- **Archive:** the ⋯ menu on a session archives it, and can remove its worktree directory if it has no uncommitted changes. Branches are never deleted.

## Remote hubs

One client can show several hubs. Use **+ Hub** in the rail and paste the link a hub printed, or its address and token. The ⋯ menu on a hub changes its token or removes it from this client; the hub keeps running.

A hub listens only on loopback by default, and Loom does not encrypt its own traffic, so reach other machines through SSH or Tailscale.

**SSH tunnel.** On the machine you sit at:

```sh
npm run loom -- tunnel you@work-pc                 # remote hub on 7420, local address http://127.0.0.1:17420
npm run loom -- tunnel work --port 7421 --local-port 18000 --ssh-option ProxyJump=bastion
```

It uses your normal `ssh` (keys, `~/.ssh/config` aliases, known hosts), prints the local address once the hub answers, and reconnects if the connection drops. Add that address in the client with the remote hub's token. If ssh fails before the tunnel ever opens, it stops and says so; run `ssh you@work-pc` by hand to see why.

**Tailscale.** In the remote hub's `hub.json`:

```json
{ "bind": "tailscale" }
```

The hub asks `tailscale ip -4` for its address and listens there and on loopback. A literal tailnet address (`100.x.y.z`) works too. Any other address, such as a LAN IP or `0.0.0.0`, is refused unless you also set `"allowUnencryptedNetwork": true`.

**WSL (the work machine).** The hub runs inside WSL; its loopback is reachable from Windows, so a browser on the same PC just uses `http://127.0.0.1:7420`. To reach it from home (not yet tried on the real machine):

- With Tailscale inside the WSL distro, use `"bind": "tailscale"` as above.
- With Tailscale on Windows and WSL's mirrored networking (`networkingMode=mirrored` in `%UserProfile%\.wslconfig`), WSL sees the Windows Tailscale address. `tailscale` is not on the WSL PATH, so set `bind` to that `100.x.y.z` address directly.
- For SSH, run `sshd` in WSL (or use Windows OpenSSH with a jump into WSL) and `loom tunnel` to it.

Ten wrong tokens from one address within ten minutes block that address for ten minutes.

## Voice

Hold **Hold to talk** in the rail, or hold `Ctrl+Shift+Space`, speak, and release. The transcript goes into the open session's message box (or the Cockpit's; see ⚙) for you to edit and send. With the approvals panel open, say "allow" or "deny" ("permitir", "negar") for the selected card. Always-ask approvals and questions still need a click. Escape stops read-back. The microphone only works on `localhost`, `127.0.0.1`, or https.

A hub recognizes speech with local whisper or Groq, and can speak with Piper or OpenAI. Without a hub voice, the browser's own voice reads aloud. The hub prints what it found at startup (`voice` line).

**Local whisper:**

```sh
npm run build:voce    # needs cmake and a C++ compiler; add --features cuda by hand for an NVIDIA GPU with the CUDA toolkit
mkdir -p ~/.local/share/loom/models
curl -L -o ~/.local/share/loom/models/ggml-small.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin
```

Models are looked up by name in `<data dir>/models/` and in Loom v1's `~/.cache/loom-voce/`. `small` is the default; choose another in `hub.json`:

```json
{ "voice": { "whisper": { "model": "medium" } } }
```

On a CPU, `medium` is about three times slower than `small`. Setting the dictation language in ⚙ skips detection and saves about 40 %.

**Cloud:** start the hub with `GROQ_API_KEY` for recognition and `OPENAI_API_KEY` for read-back. Keys are read from the environment only. This is the default for WSL and Windows machines without a GPU.

**Piper:** download a Piper release and voices (for example `pt_BR-faber-medium` and `en_US-lessac-medium` from `rhasspy/piper-voices`), then:

```json
{ "voice": { "piper": { "command": "/opt/piper/piper", "voices": { "en": "/opt/piper/en_US-lessac-medium.onnx", "pt": "/opt/piper/pt_BR-faber-medium.onnx" } } } }
```

Choose "the hub" as the voice in ⚙ to use it. Quiet hours: `{ "voice": { "quietHours": { "from": "22:00", "to": "07:00" } } }`.

Sessions can talk: the `speak` tool, or `loom say <text>` in a terminal session.

## Search, changes, and screen manifests

- **Search:** Ctrl+K (or ⌕ in the rail) searches every connected hub's history: messages, replies, tool calls, approvals, speech, errors. Every word must appear; accents are ignored. A result opens the session at that moment. Sessions use `search_history`, terminals `loom search <words>`.
- **Changes:** each session has a Changes tab: files and hunks from git against HEAD, or, for worktree sessions, the whole branch against where it started. Revert a hunk (changes inside an existing file) or a whole file with the two-step buttons; new files are deleted when reverted. Reverts wait while the session works. After every turn the tab shows how many files changed.
- **Screen manifests:** for terminal CLIs without hooks, copy [docs/manifests/example.toml](manifests/example.toml) to `<config dir>/manifests/<id>.toml`, adjust programs and patterns, and enable it: `{ "heuristics": { "enabled": ["<id>"] } }`. The hub prints what it loaded (`heuristics` line) and any problems. States set this way show "from screen".

## Relay

When SSH and Tailscale are blocked, a relay on a VPS gives the hub an address like `https://work.relay.furevikstrand.cloud`. Setting up the VPS: [relay/deploy/README.md](../relay/deploy/README.md). On the VPS, `loom-relay add-hub work` prints a block for the hub's `hub.json`:

```json
{ "relay": { "url": "wss://relay.furevikstrand.cloud", "name": "work", "secret": "…", "acme": { "email": "you@example.com" } } }
```

On start the hub logs `relay up`, requests a Let's Encrypt certificate for its name through the relay, and prints the account URL for a CAA `accounturi` record. Certificates live in `<data dir>/relay/` and renew 30 days before they expire. Use `"certificate": { "cert": …, "key": … }` for your own files, and `"acme": { "directory": "https://acme-staging-v02.api.letsencrypt.org/directory" }` while trying things out.

Clients add the https address with the hub's token, like any hub. Terminal hooks never work through the relay; the hub's own machine uses loopback for those.

Local testing without a VPS: `hub/test/relay.test.ts` runs relay, hub, and clients with a throwaway CA. For ACME, run Pebble and `pebble-challtestsrv` (DNS on 127.0.0.1:8053, Pebble's `httpPort` equal to the relay's `httpPort`), use `*.localhost` names, and start the hub with `NODE_EXTRA_CA_CERTS` covering the relay's certificate and Pebble's `pebble.minica.pem`.

## Phone

The client is a PWA. A phone needs an https address for the hub; the simplest is Tailscale on both the phone and the hub machine:

```sh
tailscale serve --bg 7420     # https://<machine>.<tailnet>.ts.net → the hub's loopback port, tailnet only
```

Then, in Loom on the computer: hub ⋯ → **Phone and notifications…** → enter that address → **Show sign-in code**, and scan it with the phone. On the phone, install Loom (Android: browser menu → Install app; iPhone: Share → Add to Home Screen, then open it from there) and turn on **Notifications on this device** in the same dialog. **Send a test** checks the path.

An approval that still waits for a person after `push.delaySeconds` (default 15) is pushed to every registered device; tapping it opens the approvals panel on that approval. The hub needs outbound internet to reach the push services (Google, Apple, Mozilla). Some push services reject a VAPID contact like the default `mailto:loom@localhost`; set a real one:

```json
{ "push": { "delaySeconds": 15, "subject": "mailto:you@example.com" } }
```

Without Tailscale, give the hub a certificate instead: `{ "bind": "<address>", "tls": { "cert": "/path/cert.pem", "key": "/path/key.pem" } }`. Losing the phone means rotating the token with `--new-token`.

## Desktop app

```sh
npm run desktop:dev     # gathers the bundle (below), then tauri dev
npm run desktop:build   # the same, then a release build: .deb on Linux, NSIS installer on Windows
```

Both run `desktop/scripts/prepare.mjs`, which bundles the hub, builds the client, and copies the current Node binary, `loom-pty`, `loom-voce` (Linux; needs cmake the first time), and the Agent SDK's `claude` binary into `desktop/src-tauri`. Linux builds need `libwebkit2gtk-4.1-dev`, `libayatana-appindicator3-dev`, and `librsvg2-dev`.

The app attaches to a hub already answering on `hub.json`'s port, or starts its own and signs in without a token. Closing the window leaves it in the tray; **Quit Loom** stops the hub it started. `Ctrl+Shift+Space` works from any window. Hub output goes to `<data dir>/logs/hub.log`. With arguments, the `loom` binary is the CLI: `loom list`, `loom tunnel you@work-pc`.

To try it without touching your real hub files, run the debug binary with `XDG_CONFIG_HOME` and `XDG_DATA_HOME` pointing at a temporary folder that holds `loom/hub.json` with another port.

The `.deb` is named `loom`, so installing it replaces Loom v1.

## Tests

```sh
npm test            # all workspaces, no model calls
npm run typecheck   # tsc per workspace
```

Terminal tests run against the real sidecar and are skipped if it is not built. On Windows most of them are skipped for now, because they drive POSIX shells.

One test talks to the real Claude Agent SDK with this machine's login. It uses a few cents of usage:

```sh
LOOM_LIVE_SDK=1 npx vitest run hub/test/claudeLive.test.ts
```

On Windows PowerShell, set the variable first with `$env:LOOM_LIVE_SDK = "1"`.

## Where things are

| Path | What |
|---|---|
| `protocol/src/` | Frames, commands, events, levels, and the shared projection reducer |
| `hub/src/core/` | Session manager, approval broker, adapter interface. Never names a CLI. |
| `hub/src/adapters/claude-sdk/` | Claude through the Agent SDK: message mapping, approval summaries, level mapping |
| `hub/src/adapters/pty/` | Terminal sessions: platform launch rules, Claude terminal profile and hook handling |
| `hub/src/pty/` | Sidecar process manager, binary lookup, environment cleanup |
| `sidecars/pty/` | Rust sidecar: PTYs, coalesced output, JSON lines over stdio |
| `hub/src/log/` | Event log on `node:sqlite` |
| `hub/src/server/` | WebSocket server, command router, static file serving |
| `hub/test/support/` | Fake adapter and a test hub factory |
| `client/src/hub/` | Connection with reconnect, client store |
| `client/src/lib/timeline.ts` | Folds session events into chat items |
| `client/src/components/TerminalView.tsx` | xterm, attach with offsets, input and resize |
