# Agent SDK smoke test

Loom v2 builds on the Claude Agent SDK. Before any hub code depends on it, this script checks that the SDK works on a given machine, with that machine's Claude login and its organization's policies.

It is standalone: copy this folder anywhere, no other part of the repo is needed.

## Run it

Requires Node 20 or newer and a machine where `claude` is already logged in.

```sh
cd tools/sdk-smoke
npm install
npm start
```

Useful flags:

```sh
node smoke.mjs --model claude-sonnet-5   # force a model
node smoke.mjs --only 1,2,4              # run some steps only
```

It creates and deletes a scratch folder, `.smoke-work/`, next to the script. It writes `smoke-report.json` when done. The report holds no credentials, but it does include paths, model names, and your Claude Code version.

## Where to run it

| Machine | How |
|---|---|
| Home Linux | as above |
| Work, inside WSL Ubuntu | as above, from a folder under `/home`, not `/mnt/c` |
| Work, native Windows | from PowerShell; Git for Windows should be installed for the shell step |

## What each step proves

| Step | Checks | Plan assumption it protects |
|---|---|---|
| 1 | A basic query authenticates. `apiKeySource: "none"` means claude.ai login is in use. | The hub can use the machine's existing login |
| 2 | A Write permission prompt reaches the host callback and can be allowed | Approval cards and the Steward |
| 3 | The same prompt can be denied and the file is not written | Deny rules and the Deny button |
| 4 | A shell command prompt reaches the callback | Shell approvals, the main pain at work |
| 5 | AskUserQuestion reaches the callback and an answer gets back to Claude. Optional, since the model may skip the tool. | Answering clarifying questions |
| 6 | A session resumes by id | Hub restart and "open as terminal" |
| 7 | One session stays open across two turns | How the hub holds every session |
| 8 | Permission mode changes on a live session | Per-session permission levels |

The verdict is `PASS` when every required step passes. Step 5 is optional.

## Cost

Eight short runs on the default model. On a subscription this uses a small slice of the usage window; `totalCostUsd` in the report is Claude Code's own estimate.
