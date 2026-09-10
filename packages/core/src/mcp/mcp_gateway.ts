// src/mcp/mcp_gateway.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { getServer } from "./mcp_registry.js";

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/**
 * A short-lived client per call, not a persistent daemon — Purix is a
 * CLI, each invocation is its own process, so there's nothing to leak
 * or manage between runs. Tries modern Streamable HTTP first, falls
 * back to legacy SSE, since you'll hit both kinds of servers in the wild
 * and shouldn't need to know which up front.
 */
async function connect(name: string): Promise<Client> {
  const server = getServer(name);
  if (!server) {
    throw new Error(
      `No MCP server registered as "${name}". Run "purix mcp-add ${name} <url>" first, or "purix mcp-list" to see what's registered.`
    );
  }

  const baseUrl = new URL(server.url);
  try {
    const client = new Client({ name: "purix", version: "0.1.0" });
    await client.connect(new StreamableHTTPClientTransport(baseUrl));
    return client;
  } catch {
    const client = new Client({ name: "purix", version: "0.1.0" });
    await client.connect(new SSEClientTransport(baseUrl));
    return client;
  }
}

export async function listServerTools(name: string): Promise<McpToolInfo[]> {
  const client = await connect(name);
  try {
    const result = await client.listTools();
    return result.tools.map((t: { name: string; description?: string; inputSchema?: unknown }) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  } finally {
    await client.close();
  }
}

export interface McpCallResult {
  ok: boolean;
  content?: unknown;
  reason?: string;
}

/**
 * Section 20 applies here exactly like a first-time external tool use.
 * This function never decides to fire on its own — every call is gated
 * behind a human confirmation at the CLI layer, every time, not just
 * the first, since there's no "trusted once" cache for MCP tools built
 * yet (that would be its own separate design decision, not a given).
 */
export async function callServerTool(
  serverName: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<McpCallResult> {
  const client = await connect(serverName);
  try {
    const result = await client.callTool({ name: toolName, arguments: args });
    if (result.isError) {
      return { ok: false, reason: typeof result.content === "string" ? result.content : JSON.stringify(result.content) };
    }
    return { ok: true, content: result.content };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    await client.close();
  }
}