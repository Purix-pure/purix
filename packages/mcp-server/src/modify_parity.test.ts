// P5 (parity): `purix modify` and `purix_modify` take the same first step, and the model is shown the same context.
// The CLI calls prepareModifyIntent directly (through its runtime deps); the MCP tool calls it too. A stand-in model records every
// request body, so this checks what the model was actually sent, not which function was called.
import { describe, test, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import http from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createPurixMcpServer } from "./server";
import { closeDb, writeManifest } from "@purix/core/manifest/store";
import type { ManifestEntry } from "@purix/core/manifest/schema";
import { rememberNote } from "@purix/core/manifest/memory";
import { prepareModifyIntent } from "@purix/core/entrypoints/modify_intent";
import { trustCustomProvider } from "@purix/core/llm/providers";
import { safeRmSync } from "@purix/core/platform/fs_retry";

const KEY_VAR = "PURIX_PARITY_FAKE_KEY";
const NOTE = "Money is stored as integer cents, never floats.";
const INSTRUCTION = "add a refund function";

let tmpDir: string, userDir: string, oldCwd: string;
let saved: Record<string, string | undefined>;
let model: http.Server;
let bodies: string[];

beforeEach(async () => {
  bodies = [];
  model = http.createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      bodies.push(b);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "x", object: "chat.completion", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ explicit_instruction: "Add a refund(amountCents) function to billing.", assumptions: [] }) } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
    });
  });
  await new Promise<void>((r) => model.listen(0, "127.0.0.1", r));
  const port = (model.address() as { port: number }).port;

  tmpDir = mkdtempSync(join(tmpdir(), "purix-parity-"));
  userDir = mkdtempSync(join(tmpdir(), "purix-parity-user-"));
  saved = { PURIX_USER_DIR: process.env.PURIX_USER_DIR, [KEY_VAR]: process.env[KEY_VAR], NO_PROXY: process.env.NO_PROXY };
  process.env.PURIX_USER_DIR = userDir;
  process.env[KEY_VAR] = "k";
  process.env.NO_PROXY = "127.0.0.1,localhost";
  oldCwd = process.cwd();
  process.chdir(tmpDir);

  mkdirSync(join(tmpDir, ".purix"), { recursive: true });
  mkdirSync(join(tmpDir, "src"), { recursive: true });
  writeFileSync(join(tmpDir, ".purix", "config.json"), JSON.stringify({ language: "typescript" }));
  const custom = { baseUrl: `http://127.0.0.1:${port}/v1`, keyEnvVar: KEY_VAR, modelLow: "m", modelHigh: "m" };
  writeFileSync(join(tmpDir, ".purix", "provider-config.json"), JSON.stringify({ provider: "custom", custom }));
  trustCustomProvider({ baseUrl: custom.baseUrl, keyEnvVar: KEY_VAR });
  writeFileSync(join(tmpDir, "src", "billing.ts"), "export function charge(amountCents: number) { return amountCents; }\n");
  // Preflight refuses a change it could not verify. Give the project the TypeScript this repository already has.
  mkdirSync(join(tmpDir, "node_modules"), { recursive: true });
  symlinkSync(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), join(tmpDir, "node_modules", "typescript"), "junction");
  writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "p", version: "1.0.0" }));
  writeFileSync(join(tmpDir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, target: "es2022", module: "esnext" } }));
  writeManifest(comp("billing"));
  rememberNote({ note: NOTE, source: "person" });
});
afterEach(async () => {
  closeDb();
  process.chdir(oldCwd);
  await new Promise<void>((r) => model.close(() => r()));
  safeRmSync(tmpDir);
  safeRmSync(userDir);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function comp(id: string): ManifestEntry {
  return {
    component_id: id, component_type: "module", current_version: 1, schema_version: 4,
    parts: { tools: [], config: {} }, files: [`src/${id}.ts`], depends_on: [], depended_on_by: [],
    version_history: [{ version: 1, operation: "create", patch_ref: "p", contract_changed: false, timestamp: "2026-11-01T10:00:00.000Z", provenance: { source_type: "instruction", source_agent: "x" } }],
    verification_status: "pass", last_synced_hash: null, language: "typescript",
  };
}

describe("modify parity: CLI and MCP show the model the same context", () => {
  test("the shared step puts a recorded repo-wide convention in the refine request (the CLI's path)", async () => {
    const files = [{ path: "src/billing.ts", content: "export function charge(amountCents: number) { return amountCents; }\n" }];
    const { memoryLines } = await prepareModifyIntent("billing", INSTRUCTION, files);
    expect(memoryLines.join("\n")).toContain(NOTE);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain(NOTE);
    expect(bodies[0]).toContain(INSTRUCTION);
  });

  test("purix_modify sends the model the same refine request as the CLI's step, before any classification", async () => {
    const files = [{ path: "src/billing.ts", content: "export function charge(amountCents: number) { return amountCents; }\n" }];
    await prepareModifyIntent("billing", INSTRUCTION, files);
    const cliBody = bodies[0]!;
    bodies.length = 0;

    const server = createPurixMcpServer();
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(s), client.connect(c)]);
    const reply = await client.callTool({ name: "purix_modify", arguments: { componentId: "billing", instruction: INSTRUCTION, dryRun: true } });
    void reply;

    expect(bodies.length).toBeGreaterThan(0);
    // Same prompt text, so the model sees the same convention and the same instruction on both doors.
    // Each request carries random delimiter tags (PURIX_FILES_<random>), so compare with the random part masked.
    const mask = (body: string) => JSON.stringify(JSON.parse(body).messages).replace(/PURIX_([A-Z]+)_[0-9A-F]+/g, "PURIX_$1_TAG");
    expect(mask(bodies[0]!)).toEqual(mask(cliBody));
    expect(bodies[0]).toContain(NOTE);
  });
});
