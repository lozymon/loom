# A hub per machine owns all sessions; clients are views

**Status:** Accepted (2026-09-12).

v1 ran PTYs inside the Tauri app process (v1 ADR-0002). Closing the window killed every agent, a second screen could not attach, and remote control needed a bespoke bridge. herdr and T3 Code both split a long-running server from its interfaces, and it is the single biggest thing v2 takes from them.

## Decision

- **One hub process per machine** owns sessions, terminals, the approval queue, the board, and the event log. It keeps running when no client is attached.
- **Clients are views.** Desktop (Tauri shell), browser, and later a PWA render hub state and send commands. No product state lives only in a client.
- **A client may attach to several hubs at once.** The rail groups by hub, then workspace.
- The desktop app starts the local hub if it is not running. It never hosts sessions itself.
- **Single user per hub.** Colleagues run their own hubs (PLAN decision 19). Sharing happens through committed `.loom/` files, not a shared server.

## Consequences

- Reconnect and multi-client are ordinary: a client replays the log from its last seq (ADR-0003).
- Remote access is the same protocol over a different pipe (ADR-0008).
- Every capability must be expressible as a command and an event, since there is no in-process shortcut.
- Hub lifecycle becomes a product surface: autostart, tray, "stop hub", upgrades.

## Addendum (M10, 2026-09-13)

The browser client is also the phone client: an installable PWA served by the hub, with a service worker that only shows push notifications and opens the app (it caches nothing, since the client is useless without its hub). A browser push subscription is bound to one server key, so the hub serving the PWA is the one that pushes to it.
