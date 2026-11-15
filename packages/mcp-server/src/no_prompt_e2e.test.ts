// src/no_prompt_e2e.test.ts
//
// End to end, over real stdio: a fresh project with no registered approver. The first `purix_create` used to reach the one-time
// "register you as the sole approver?" question, which cannot be asked inside an MCP session (the question went into the reply
// stream and the agent's next request was read as the answer, so every later call timed out with -32001).
// What must hold now:
//   (a) the reply comes back within seconds,
//   (b) it names `purix approve --register`,
//   (c) a following call still answers,
//   (d) nothing was registered,
//   (e) no model call was made: a call that cannot land must not cost one.
import { test } from "node:test";
import { expect } from "expect";
import http from "node:http";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { trustCustomProvider } from "@purix/core/llm/providers";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const entry = join(dirname(fileURLToPath(import.meta.url)), "no_prompt_e2e_server.ts");
const REPLY_WITHIN_MS = 8000;
// The server runs with the temp project as its cwd, where tsx cannot be found by name: hand it over by absolute URL.
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? "").join("\n");
}

test("purix_create with no approver answers fast, names purix approve --register, spends no model call, writes nothing", async () => {
  // A stand-in model on a local port. If the server calls it, the count goes up.
  let modelCalls = 0;
  const plan = { component_id: "team-board", component_type: "module", files: [{ path: "src/team-board.ts", purpose: "board", starter_content: "export const board = [];\n" }], depends_on: [] };
  const model = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      modelCalls++;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "x", object: "chat.completion", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(plan) } }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }));
    });
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  const port = (model.address() as { port: number }).port;

  const project = mkdtempSync(join(tmpdir(), "purix-noprompt-"));
  const home = mkdtempSync(join(tmpdir(), "purix-noprompt-home-"));
  spawnSync("git", ["init", "-q"], { cwd: project });
  mkdirSync(join(project, ".purix"), { recursive: true });
  writeFileSync(join(project, ".purix", "config.json"), JSON.stringify({ language: "typescript" }));
  writeFileSync(join(project, ".purix", "provider-config.json"), JSON.stringify({ provider: "custom", custom: { baseUrl: `http://127.0.0.1:${port}/v1`, keyEnvVar: "PURIX_E2E_FAKE_KEY", modelLow: "m", modelHigh: "m" } }));

  // Accept the stand-in endpoint the way `purix provider set` does, in the throwaway home. Without this the provider gate would
  // stop the model call by itself, and "no model call was made" would hold whether or not the approver check ran first.
  const realHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    trustCustomProvider({ baseUrl: `http://127.0.0.1:${port}/v1`, keyEnvVar: "PURIX_E2E_FAKE_KEY" });
  } finally {
    for (const [k, v] of Object.entries(realHome)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /API_KEY|^PURIX_|^NODE_ENV$|^AUTO_CONFIRM$|proxy/i.test(k)) continue;
    env[k] = v;
  }
  Object.assign(env, { HOME: home, USERPROFILE: home, PURIX_E2E_FAKE_KEY: "k", NO_PROXY: "127.0.0.1,localhost" });

  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", tsxLoader, entry], cwd: project, env, stderr: "pipe" });
  const client = new Client({ name: "no-prompt-e2e", version: "1" }, { capabilities: {} });
  try {
    await client.connect(transport);

    const started = Date.now();
    const created = await client.callTool({ name: "purix_create", arguments: { name: "team-board", intent: "a small team board" } }, undefined, { timeout: REPLY_WITHIN_MS });
    expect(Date.now() - started).toBeLessThan(REPLY_WITHIN_MS);
    expect(textOf(created)).toContain("purix approve --register");

    const status = await client.callTool({ name: "purix_status", arguments: {} }, undefined, { timeout: REPLY_WITHIN_MS });
    expect(textOf(status).length).toBeGreaterThan(0);

    expect(existsSync(join(project, ".purix", "authorized_operators.json"))).toBe(false);
    expect(modelCalls).toBe(0);
  } finally {
    await client.close().catch(() => undefined);
    await new Promise<void>((resolve) => model.close(() => resolve()));
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
