# The relay forwards TLS it cannot open

**Status:** Accepted (2026-09-13, M11). Carries out the third tier of ADR-0008; replaces the Noise-based design in v1's ADR-0012.

The work hub may be reachable by neither SSH nor Tailscale: WSL sits behind Windows NAT and corporate policy can block both. A hub can still make outbound HTTPS connections. A relay on the user's VPS gives it an address. The VPS is a box on the internet, so what the relay can see and do if it is taken over is the design question.

## Decision

- **The hub dials out.** It keeps a control WebSocket to `wss://<relay domain>/v1/hub`, authenticated with a per-hub enrollment secret. It never listens on the network for the relay.
- **Visitors use the hub's own name,** `https://<hub>.<relay domain>`, a DNS wildcard pointing at the relay.
- **TLS passthrough.** The relay reads the server name from the visitor's ClientHello and does not terminate TLS for hub names. It asks the hub, over the control connection, to open a data connection (`/v1/stream/<id>`, an HTTP upgrade on the relay's own TLS endpoint), writes the ClientHello bytes into it, and splices the two sockets. The TLS session, with the hub's certificate, is between visitor and hub.
- **The hub owns its certificate.** It obtains one from Let's Encrypt with HTTP-01: the relay forwards plain HTTP for `/.well-known/acme-challenge/` on hub names to the hub over the same stream mechanism. Certificate files work too. The relay never has a hub's key.
- **No Loom cryptography.** TLS protects the data end to end; ACME signing is done by `acme-client`; the ClientHello parser only reads a length-prefixed name.
- **What a compromised relay costs:** availability, and metadata (which hub names exist, when and from which addresses they are visited, how much is sent). It cannot read or change traffic, or impersonate a hub to a browser, as long as the hub's certificate is valid. It could, however, pass Let's Encrypt's HTTP-01 check for a hub name itself and get its own certificate for that name. Certificate Transparency logs make that visible, and a CAA record with `accounturi` (RFC 8657) pinned to the hub's ACME account closes it, because the DNS zone is not on the VPS. The hub prints its account URL for that record.
- **Enrollment secrets protect the relay, not the data:** without one, a stranger cannot register a name. The relay stores only their hashes. A person still needs the hub token.
- **Limits live on the relay:** connections per visitor address, streams per hub, ClientHello size, time to receive a data connection, and idle timeouts.

## Consequences

- One more process to run on the VPS, and a wildcard DNS record. The relay may sit behind an existing nginx using `ssl_preread`.
- The hub's login limit uses the visitor address the relay reports in the stream request, which a hostile relay could lie about; a hostile relay can only deny service anyway.
- Clients need nothing new: a relay address is an ordinary https hub address, so the PWA, microphone, and push work through it.
