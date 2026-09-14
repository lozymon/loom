# Trying Loom v2 for real

The order that gets you using it soonest, with the checks nothing on the dev machine could do. Each step says how to undo it.

## 1. Desktop app on this machine (replaces v1)

1. **Keep a way back.** v1 1.14.0 is installed as package `loom`, but only v1 1.8.0 has a `.deb` on disk. Build the current v1 package first: `cd ../loom && npm run tauri build` (the `.deb` lands in `src-tauri/target/release/bundle/deb/`).
2. **Stop the dev hub** (`npm run hub:dev`) if it runs: the app attaches to whatever answers on port 7420, and the dev hub keeps its data in `.loom-dev`, not in the app's folders.
3. **Install:** `sudo apt install ./desktop/src-tauri/target/release/bundle/deb/Loom_2.0.0_amd64.deb`. This upgrades package `loom` from v1.
4. **Start Loom** from the app menu. It creates `~/.config/loom/hub.json`, starts its hub, and signs in by itself. The hub log is `~/.local/share/loom/logs/hub.log`; the first run prints the access token there, which other browsers and phones need.
5. **Check:** a Claude chat session in a real project, an approval, a Claude terminal session, Ctrl+Shift+Space from another window, closing to the tray, and **Quit Loom**.

Undo: `sudo apt install ./<v1 1.14 .deb>`. v2's files in `~/.config/loom` and `~/.local/share/loom` can stay or go; v1 does not read them.

## 2. Phone (M10)

Needs Tailscale on this machine and the phone (not installed here yet).

1. `tailscale serve --bg 7420`, which gives `https://<machine>.<tailnet>.ts.net`.
2. In Loom: hub ⋯ → **Phone and notifications…** → enter that address → **Show sign-in code** → scan it.
3. On the phone: install the app (Android: menu → Install app; iPhone: Share → Add to Home Screen, then open it from there), then **Turn on** notifications and **Send a test**.
4. Let a session wait on an approval for more than 15 seconds and approve it from the notification.

If the test never arrives, set a real contact in `hub.json`: `{ "push": { "subject": "mailto:you@example.com" } }`.

Undo: `tailscale serve --https=443 off`, and **Turn off** on the phone.

## 3. Work machine (WSL)

1. Run the SDK smoke test in WSL: `cd tools/sdk-smoke && npm install && npm start`. It checks that the Team login works through the Agent SDK. Send back `smoke-report.json` if anything fails.
2. Run the hub in WSL with `npm run hub` (or the bundled hub) and open `http://localhost:7420` in the Windows browser.
3. Keep `hub.json` at the cautious defaults (`supervised`, Steward model off).

## 4. Reaching work from home

Try in this order and stop at the first that works: `loom tunnel you@work` (SSH), Tailscale inside WSL, then the relay.

**Relay:** follow [relay/deploy/README.md](../relay/deploy/README.md) on the VPS (DNS records, a certificate for the relay name only, Node 24, systemd, or the nginx example if nginx owns 443). Enroll the work hub with `add-hub work`. Start with Let's Encrypt staging (`"acme": { "directory": "https://acme-staging-v02.api.letsencrypt.org/directory" }`), switch to production once `relay up` and a certificate appear in the hub log, then add the CAA `accounturi` record the hub prints.

Undo: remove `relay` from `hub.json` and `remove-hub work` on the VPS.

## 5. Colleagues on Windows

The Windows installer has never been built. Push the branch to GitHub and run the **Desktop** workflow by hand; it uploads the NSIS installer. Try it on one Windows machine before handing it out, especially Claude sessions (Git for Windows), terminals, and the microphone.

## Reporting back

Anything odd: the hub log, the session name, and what you expected. `CLAUDE.md` lists what each milestone did not verify.
