// packages/cli/src/mcp_stdout_purity.test.ts
//
// PURIX-21 exit gate 7 / D11 (a): in MCP mode nothing but valid MCP messages may reach stdout (MCP stdio
// transport spec; logging to stderr is allowed). This starts the REAL built server (`purix mcp-serve`) and
// reads its raw stdout, including while tool calls overlap, which is what broke the old console swap.
// It does not use the SDK client, because the client would hide a stray line by ignoring it.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeRmSync } from "@purix/core/platform/fs_retry";

const CLI = join(import.meta.dirname, "..", "dist", "cli.js");

interface Run {
  stdoutLines: string[];
  stderr: string;
  responses: Map<number, any>;
}

function runServer(cwd: string, requests: object[], expectedIds: number[]): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, "mcp-serve"], {
      cwd,
      env: { ...process.env, AUTO_CONFIRM: "1", PURIX_MCP_AGENT_ID: "stdout-purity-test" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const responses = new Map<number, any>();
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`server did not answer ids ${expectedIds.join(",")} in time.\nstdout so far: ${out}\nstderr: ${err}`));
    }, 30_000);
    const check = (): void => {
      for (const line of out.split("\n")) {
        if (!line.trim()) continue;
        try {
          const m = JSON.parse(line);
          if (typeof m.id === "number") responses.set(m.id, m);
        } catch {
          // judged by the test itself
        }
      }
      if (expectedIds.every((id) => responses.has(id))) {
        clearTimeout(timer);
        child.kill();
      }
    };
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
      check();
    });
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", () => {
      clearTimeout(timer);
      resolve({ stdoutLines: out.split("\n").filter((l) => l.trim() !== ""), stderr: err, responses });
    });
    for (const r of requests) child.stdin.write(JSON.stringify(r) + "\n");
  });
}

const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "purity-test", version: "1" } } };
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };
const call = (id: number, name: string, args: object = {}) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

describe("MCP server stdout carries only protocol messages", { timeout: 60_000 }, () => {
  it("every stdout line is a JSON-RPC 2.0 message: startup, tool listing, and overlapping tool calls", async () => {
    assert.ok(existsSync(CLI), `build first: ${CLI} is missing (the test drives the built artifact, not the sources)`);
    const dir = mkdtempSync(join(tmpdir(), "purix-mcp-purity-"));
    try {
      const run = await runServer(
        dir,
        [
          init,
          initialized,
          { jsonrpc: "2.0", id: 2, method: "tools/list" },
          // three calls sent back to back, so they overlap inside the server
          call(3, "purix_status"),
          call(4, "purix_audit_verify"),
          call(5, "purix_status"),
        ],
        [1, 2, 3, 4, 5],
      );
      assert.ok(run.stdoutLines.length >= 5, `expected at least 5 messages, got ${run.stdoutLines.length}\nstderr: ${run.stderr}`);
      for (const line of run.stdoutLines) {
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          assert.fail(`non-JSON line on stdout: ${JSON.stringify(line.slice(0, 200))}`);
        }
        assert.equal(msg.jsonrpc, "2.0", `stdout line is not a JSON-RPC message: ${line.slice(0, 200)}`);
      }
      for (const id of [3, 4, 5]) {
        assert.ok(run.responses.get(id)?.result, `call ${id} returned no result: ${JSON.stringify(run.responses.get(id))}`);
      }
    } finally {
      safeRmSync(dir);
    }
  });
});
