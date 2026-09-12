// packages/cli/src/cli/commands/connect.ts
//
// Registers Purix's MCP server (`purix mcp-serve`) with a coding agent's
// own config, via the `add-mcp` library. Writes project-scoped config
// (e.g. .mcp.json, .cursor/mcp.json) for agents that support it, and
// falls back to that agent's global config path for agents that don't
// (e.g. Antigravity — see connect.global-fallback.test.ts for why that
// fallback has to be exercised in a separate child process).
//
// connectAgent() itself (and the `add-mcp` import it needs) lives in
// ./connect_agent.js, imported lazily below — see that file's header
// comment for why. This file only imports `add-mcp`'s types, which are
// erased at compile time and cost nothing at runtime, so registering this
// command (loading this file, which happens for `purix connect --help`
// too) no longer pays to load `add-mcp` itself.
import type { Command } from "commander";
import type { AgentInput } from "add-mcp";

export function registerConnectCommand(program: Command) {
  program
    .command("connect [agent]")
    .description(
      "Register Purix's MCP server with a coding agent (Claude Code, Cursor, Codex, etc.) — auto-detects the agent(s) in this project if none is given",
    )
    .option(
      "--agent-id <id>",
      "Identity recorded in the audit trail for actions from this agent (defaults to the agent type)",
    )
    .action(async (agent: string | undefined, options: { agentId?: string }) => {
      const [{ connectAgent }, { detectProjectAgents }] = await Promise.all([
        import("./connect_agent.js"),
        import("add-mcp"),
      ]);

      const cwd = process.cwd();
      const targets: AgentInput[] = agent ? [agent as AgentInput] : detectProjectAgents(cwd);

      if (targets.length === 0) {
        console.log(
          "No supported coding agent detected in this project. Pass one explicitly, e.g. `purix connect claude-code`.",
        );
        return;
      }

      for (const target of targets) {
        const agentId = options.agentId ?? target;
        const { result } = connectAgent(target, cwd, agentId);
        if (result.success) {
          console.log(`✅ Connected purix to ${target} — wrote ${result.path}`);
        } else {
          console.log(`❌ Failed to connect purix to ${target}: ${result.error ?? "unknown error"}`);
        }
      }
    });
}