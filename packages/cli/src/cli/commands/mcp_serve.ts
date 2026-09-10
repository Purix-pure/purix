// src/cli/commands/mcp_serve.ts
import type { Command } from "commander";
import { runMcpServer } from "@purix/mcp-server";

export function registerMcpServeCommand(program: Command) {
  program
    .command("mcp-serve")
    .description("Start the local Purix MCP server over stdio transport")
    .action(async () => {
      try {
        await runMcpServer();
      } catch (err) {
        console.error(`🛑 MCP server error: ${err instanceof Error ? err.message : err}`);
        process.exitCode = 1;
      }
    });
}
