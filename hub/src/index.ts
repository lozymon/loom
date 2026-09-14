// Public surface of @loom/hub, for the desktop shell and future CLI/MCP clients.
export { claudeSdkFactory } from "./adapters/claude-sdk/claudeSdkAdapter.ts";
export type { AdapterFactory, AdapterHost, SessionAdapter } from "./core/adapter.ts";
export { SessionManager } from "./core/sessionManager.ts";
export { EventLog } from "./log/eventLog.ts";
export { resolvePaths } from "./paths.ts";
export { startHubServer } from "./server/wsServer.ts";
