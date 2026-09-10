// packages/cli/src/cli/commands/connect.ts
//
// Registers Purix's MCP server (`purix mcp-serve`) with a coding agent's
// own config, via the `add-mcp` library. Writes project-scoped config
// (e.g. .mcp.json, .cursor/mcp.json) for agents that support it, and
// falls back to that agent's global config path for agents that don't
// (e.g. Antigravity — see connect.global-fallback.test.ts for why that
// fallback has to be exercised in a separate child process).
import type { Command } from "commander";
import {
  agents,
  detectProjectAgents,
  upsertServer,
  type AgentInput,
  type InstallResult,
} from "add-mcp";

/**
 * Writes (or merges into) `agentType`'s MCP config so it launches Purix's
 * MCP server via `purix mcp-serve`, tagging actions from this agent with
 * `agentId` in the audit trail (PURIX_MCP_AGENT_ID).
 *
 * Project-scoped when the agent supports it (falls back to that agent's
 * global config otherwise) — this mirrors add-mcp's own local-vs-global
 * resolution, not a Purix-specific rule.
 */
export function connectAgent(
  agentType: AgentInput,
  cwd: string,
  agentId: string,
): { result: InstallResult } {
  const known = agents[agentType as keyof typeof agents];
  const local = known?.localConfigPath !== undefined;

  const result = upsertServer(
    agentType,
    "purix",
    {
      command: "purix",
      args: ["mcp-serve"],
      env: { PURIX_MCP_AGENT_ID: agentId },
    },
    { local, cwd },
  );

  return { result };
}

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
    .action((agent: string | undefined, options: { agentId?: string }) => {
      const cwd = process.cwd();
      const targets = agent ? [agent] : detectProjectAgents(cwd);

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