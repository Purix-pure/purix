// src/mcp_no_override_args.test.ts
//
// C3 item 7 (plan v4): the CLI split `--override` into three flags (F03-09). The question was whether any MCP tool takes an override
// argument that would need the same split. Searched 2026-11-08: none does, and nothing in this package calls setBudgetOverride,
// setSecurityOverride or setTrustOverride. This test keeps it that way: an agent must not be able to skip a gate through a tool argument.
import { test } from "node:test";
import { expect } from "expect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createPurixMcpServer } from "./server";

function propertyNames(schema: unknown, out: string[] = []): string[] {
  if (schema && typeof schema === "object") {
    for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
      if (k === "properties" && v && typeof v === "object") out.push(...Object.keys(v));
      propertyNames(v, out);
    }
  }
  return out;
}

test("no MCP tool takes an override, skip-gate or force argument", async () => {
  const server = createPurixMcpServer();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" }, { capabilities: {} });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const { tools } = await client.listTools();
  expect(tools.length).toBeGreaterThan(10);
  const offenders = tools.flatMap((t) => propertyNames(t.inputSchema).filter((n) => /override|bypass|skipGate|skip_gate|force/i.test(n)).map((n) => `${t.name}.${n}`));
  expect(offenders).toEqual([]);
});
