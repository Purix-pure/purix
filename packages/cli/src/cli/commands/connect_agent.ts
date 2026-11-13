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
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  agents,
  getAgentTypes,
  upsertServer,
  type AgentInput,
  type InstallResult,
} from "add-mcp";

/**
 * The command an agent runs to start Purix's MCP server. On native Windows `purix` is an npm `.cmd` shim, not an executable,
 * and an agent that spawns it directly gets "Connection closed" (Claude Code's own docs and many server READMEs prescribe
 * `cmd /c` for exactly this). `cmd` is a real executable on every Windows, and `cmd /c purix mcp-serve` works for every agent.
 */
export function mcpLauncher(platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  return platform === "win32" ? { command: "cmd", args: ["/c", "purix", "mcp-serve"] } : { command: "purix", args: ["mcp-serve"] };
}

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
  scope: "project" | "user" = "project",
): { result: InstallResult } {
  const known = agents[agentType as keyof typeof agents];
  const local = known?.localConfigPath !== undefined && scope !== "user";

  const result = upsertServer(
    agentType,
    "purix",
    {
      ...mcpLauncher(),
      env: { PURIX_MCP_AGENT_ID: agentId },
    },
    { local, cwd },
  );

  return { result };
}

/**
 * The audit identity already recorded for `agentType`'s Purix entry, or
 * undefined when there is none. Reads the agent's own config as text and
 * looks for the PURIX_MCP_AGENT_ID value, so it works for the JSON and TOML
 * formats add-mcp writes without depending on either format's structure.
 *
 * Exists so a plain `purix connect <agent>` re-run does not silently reset an
 * identity chosen earlier with --agent-id (beta test report 2026-09-30,
 * problem 6). An audit trail whose actor names change on a routine re-run is
 * not a trustworthy trail (ADR-037).
 */
export function readRecordedAgentId(agentType: AgentInput, cwd: string, scope: "project" | "user" = "project"): string | undefined {
  const path = configPathFor(agentType, cwd, scope);
  if (!path || !existsSync(path)) return undefined;
  try {
    const text = readFileSync(path, "utf-8");
    const found = /PURIX_MCP_AGENT_ID["']?\s*[:=]\s*["']([^"'\r\n]+)["']/.exec(text);
    return found?.[1];
  } catch {
    return undefined;
  }
}

/**
 * The file `connectAgent` writes for `agentType`: the project's own file when the agent has one, else its global file.
 * Mirrors add-mcp's own rule (its getConfigPath2): an agent's `resolveConfigPath`, when it has one, wins over the fixed
 * `localConfigPath` / `configPath`. Seven agents have one (opencode, github-copilot-cli, mcporter, grok-build, kimi-code,
 * pi, kilo-code). Ignoring it made this function name `opencode.jsonc` while the library had written the project's
 * existing `opencode.json`, so `readRecordedAgentId` found nothing and a plain re-run reset a chosen audit identity.
 */
export function configPathFor(agentType: AgentInput, cwd: string, scope: "project" | "user" = "project"): string | undefined {
  const known = agents[agentType as keyof typeof agents];
  if (!known) return undefined;
  const local = known.localConfigPath !== undefined && scope !== "user";
  if (known.resolveConfigPath) return known.resolveConfigPath(known, { local, cwd });
  return local ? join(cwd, known.localConfigPath!) : known.configPath;
}

export interface SupportedAgent {
  id: string;
  displayName: string;
  /** "project": written inside this project. "global": the agent only has a per-user file, which applies to every project. */
  scope: "project" | "global";
  /** Path relative to the project (project scope) or the absolute per-user file (global scope). */
  config: string;
}

/** Every coding agent `purix connect` can write to, in the library's order. */
export function supportedAgents(): SupportedAgent[] {
  return getAgentTypes().map((id) => {
    const known = agents[id];
    const project = known.localConfigPath !== undefined;
    return {
      id,
      displayName: known.displayName ?? id,
      scope: project ? "project" : "global",
      config: project ? known.localConfigPath! : known.configPath,
    };
  });
}

/** The agents most people mean, shown first when someone has to choose. */
export const COMMON_AGENTS: readonly string[] = [
  "claude-code",
  "cursor",
  "codex",
  "opencode",
  "gemini-cli",
  "github-copilot-cli",
  "vscode",
  "windsurf",
];

// What people actually type. Anything not listed must match an id exactly (after lower-casing and turning spaces into hyphens).
const ALIASES: Record<string, string> = {
  claude: "claude-code",
  claudecode: "claude-code",
  "open-code": "opencode",
  gemini: "gemini-cli",
  copilot: "github-copilot-cli",
  "copilot-cli": "github-copilot-cli",
  "vs-code": "vscode",
  "visual-studio-code": "vscode",
  "claude-app": "claude-desktop",
};

/** Maps what a person typed to an agent id this build knows, or undefined. Case and spaces do not matter. */
export function resolveAgentId(input: string): string | undefined {
  const key = input.trim().toLowerCase().replace(/[\s_]+/g, "-");
  const known = new Set<string>(getAgentTypes());
  if (known.has(key)) return key;
  const aliased = ALIASES[key];
  return aliased !== undefined && known.has(aliased) ? aliased : undefined;
}

/**
 * Turns the agents detected in a project into the ones to write. Two agents can share one config file (Claude Code
 * and GitHub Copilot CLI both read `.mcp.json`); writing both made the second overwrite the first's entry and its
 * audit identity, so only the first is written and the rest are reported as covered by it.
 */
export function planConnectTargets(detected: readonly string[], cwd: string): { targets: string[]; sharedWith: { agent: string; covered: string }[] } {
  const targets: string[] = [];
  const byPath = new Map<string, string>();
  const sharedWith: { agent: string; covered: string }[] = [];
  for (const agent of detected) {
    const path = configPathFor(agent, cwd);
    const owner = path !== undefined ? byPath.get(path) : undefined;
    if (owner !== undefined) {
      sharedWith.push({ agent, covered: owner });
      continue;
    }
    if (path !== undefined) byPath.set(path, agent);
    targets.push(agent);
  }
  return { targets, sharedWith };
}
