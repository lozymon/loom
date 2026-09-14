# Hub in TypeScript on Node; Rust only for sidecars

**Status:** Accepted (2026-09-12). Changes v1's golden split, where Rust owned the engine and TS owned product logic in the webview.

The Claude Agent SDK is a TypeScript and Python library. Driving it from Rust would mean re-implementing its control protocol over a subprocess. v1's product logic already lived in TypeScript. v1's Rust earned its keep in two places: the coalescing PTY reader and the whisper.cpp voice helper.

## Decision

- **The hub is TypeScript on Node 24**, one package, importing `@loom/protocol` and the Agent SDK directly.
- **Rust stays for sidecars** the hub spawns and talks to over a local socket:
  - `sidecars/pty` — `portable-pty` (ConPTY on Windows) with v1's coalescing reader and back-pressure.
  - `sidecars/voce` — v1's `loom-voce`, whisper.cpp speech to text.
- **No product logic in sidecars.** They do OS work and stream bytes.
- **Development runs `.ts` directly** with Node's type stripping, so the codebase uses erasable syntax only: no enums, no parameter properties, no namespaces. Imports use `.ts` extensions. Release builds bundle the hub into a single executable (ADR-0010).

## Rejected

- **Rust hub.** Loses the SDK, doubles the protocol work.
- **Python hub.** The client and protocol are TypeScript; sharing types matters more.
- **Bun.** Not needed; Node 24 covers type stripping and single-executable builds.
- **Effect** (T3 Code's choice). Too much to learn during a rewrite; a small hand-written reducer is enough.
