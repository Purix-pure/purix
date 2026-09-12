// src/cli/commands/mcp_serve.ts
import type { Command } from "commander";

export function registerMcpServeCommand(program: Command) {
  program
    .command("mcp-serve")
    .description("Start the local Purix MCP server over stdio transport")
    .action(async () => {
      const { runMcpServer } = await import("@purix/mcp-server");
      try {
        await runMcpServer();
      } catch (err) {
        console.error(`🛑 MCP server error: ${err instanceof Error ? err.message : err}`);
        process.exitCode = 1;
      }
    });
}
