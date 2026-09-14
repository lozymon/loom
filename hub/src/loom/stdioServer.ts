#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { HubClient } from "./hubClient.ts";
import { LOOM_INSTRUCTIONS, loomTools, runTool } from "./tools.ts";

/**
 * The `loom` MCP server over stdio, for engines that launch their own MCP servers (Claude terminals).
 * Identity and authority come from LOOM_SESSION_TOKEN; the hub checks every call.
 */
async function main(): Promise<void> {
  const url = process.env.LOOM_HUB_URL;
  const token = process.env.LOOM_SESSION_TOKEN;
  if (!url || !token) throw new Error("LOOM_HUB_URL and LOOM_SESSION_TOKEN must be set");
  const hub = await HubClient.connect(url, token, "mcp");
  const me = await hub.request({ cmd: "hub.whoami" });
  if (me.kind !== "session") throw new Error("the stdio server needs a session token");

  const server = new McpServer({ name: "loom", version: "0.0.0" }, { instructions: LOOM_INSTRUCTIONS });
  for (const tool of loomTools(me)) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.shape }, async (args: Record<string, unknown>) => {
      const result = await runTool(tool, args, hub);
      return { content: [{ type: "text" as const, text: result.text }], ...(result.isError ? { isError: true } : {}) };
    });
  }
  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  process.stderr.write(`loom mcp: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
