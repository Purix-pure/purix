// packages/cli/src/cli/commands/connect_agent.ts
//
// Split out of connect.ts so that registering the `connect` command (i.e.
// loading connect.ts, which happens for `purix connect --help` too, not
// just an actual run) never pays to load the `add-mcp` package. connect.ts
// now imports this module lazily, only inside its .action() handler, when
// the command is genuinely about to run. connectAgent() itself stays a
// plain synchronous export — connect.test.ts and
// connect.global-fallback.test.ts call it directly and destructure its
// return value without awaiting, so its signature can't change here.
import {
  agents,
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