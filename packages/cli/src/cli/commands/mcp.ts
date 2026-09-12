// src/cli/commands/mcp.ts
//
// NOTE: This module is dormant and intentionally unwired in cli.ts per ADR-057
// ("MCP Client Commands Governance Deferral"). Client-side MCP tool execution
// is deferred until identity-backed provenance, DLP scrubbing, and escalation
// budget caps are integrated. Do not wire this in without fulfilling ADR-057.
import type { Command } from "commander";

export function registerMcpCommands(program: Command) {
  // ---------------------------------------------------------------------------
  // MCP Gateway
  // ---------------------------------------------------------------------------
  program.command("mcp-add <n> <url>").description("Register an MCP server").action(async (name: string, url: string) => {
    const { addServer } = await import("@purix/core/mcp/mcp_registry");
    addServer(name, url);
    console.log(`✅ Registered MCP server "${name}" -> ${url}`);
  });

  program.command("mcp-remove <n>").description("Remove a registered MCP server").action(async (name: string) => {
    const { removeServer } = await import("@purix/core/mcp/mcp_registry");
    console.log(removeServer(name) ? `✅ Removed "${name}".` : `No server registered as "${name}".`);
  });

  program.command("mcp-list").description("List registered MCP servers").action(async () => {
    const { listServers } = await import("@purix/core/mcp/mcp_registry");
    const servers = listServers();
    if (servers.length === 0) { console.log(`No MCP servers registered. Run "purix mcp-add <n> <url>".`); return; }
    for (const s of servers) console.log(`${s.name}  ${s.url}  (added ${s.added_at})`);
  });

  program.command("mcp-tools <n>").description("List tools on a registered MCP server").action(async (name: string) => {
    try {
      const { listServerTools } = await import("@purix/core/mcp/mcp_gateway");
      const tools = await listServerTools(name);
      if (tools.length === 0) { console.log(`"${name}" exposes no tools.`); return; }
      for (const t of tools) console.log(`  ${t.name}${t.description ? ` — ${t.description}` : ""}`);
    } catch (err) {
      console.error(`🛑 ${err instanceof Error ? err.message : err}`);
      process.exitCode = 1;
    }
  });

  program
    .command("mcp-call <n> <toolName> [jsonArgs]")
    .description("Call a tool on a registered MCP server ( always confirms)")
    .action(async (name: string, toolName: string, jsonArgs?: string) => {
      try {
        const { confirmGated } = await import("@purix/core/cli-io/gated-confirm");
        const { callServerTool } = await import("@purix/core/mcp/mcp_gateway");
        let args: Record<string, unknown> = {};
        if (jsonArgs) {
          try { args = JSON.parse(jsonArgs); } catch { console.error(`🛑 args must be valid JSON.`); process.exitCode = 1; return; }
        }
        console.log(`About to call "${toolName}" on "${name}" with:`, args);
        const proceed = await confirmGated(`Run this external tool call now?`, "mcp_call", null);
        if (!proceed) { console.log("Cancelled."); return; }
        const result = await callServerTool(name, toolName, args);
        if (result.ok) console.log(`✅ Result:`, JSON.stringify(result.content, null, 2));
        else { console.error(`🛑 Call failed: ${result.reason}`); process.exitCode = 1; }
      } catch (err) {
        console.error(`\n🛑 MCP call failed: ${err instanceof Error ? err.message : err}`);
        process.exitCode = 1;
      }
    });
}