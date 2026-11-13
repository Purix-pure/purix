// src/error_to_model.test.ts
//
// H3 remainder: an error thrown inside a tool reaches the model. It must arrive as a normal tool error result (isError), with
// paths of the person's machine and known secret formats removed. Purix's own sentences stay readable.
import { test } from "node:test";
import { expect } from "expect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createPurixMcpServer, toolErrorResult } from "./server";

test("toolErrorResult hides the project root and home directory, redacts a secret, and marks the result as an error", () => {
  const err = new Error("ENOENT: no such file or directory, open '/work/app/.purix/x.json' (key AKIAIOSFODNN7EXAMPLE, home /home/alice/.cfg)");
  const r = toolErrorResult(err, ["/work/app"]);
  expect(r.isError).toBe(true);
  const text = r.content[0]!.text;
  expect(text).toContain("<project>/.purix/x.json");
  expect(text).not.toContain("/work/app");
  expect(text).not.toContain("alice");
  expect(text).not.toContain("AKIAIOSFODNN7EXAMPLE");
});

test("toolErrorResult handles a thrown string and a thrown object without a message", () => {
  expect(toolErrorResult("plain failure", []).content[0]!.text).toBe("plain failure");
  expect(toolErrorResult({ code: 7 }, []).content[0]!.text).toMatch(/failed/i);
  expect(toolErrorResult(undefined, []).isError).toBe(true);
});

test("a tool that throws returns an error result with the Purix sentence instead of rejecting", async () => {
  const server = createPurixMcpServer();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" }, { capabilities: {} });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const res = await client.callTool({ name: "purix_approval_status", arguments: {} });
  expect(res.isError).toBe(true);
  expect((res.content as { text: string }[])[0]!.text).toContain("id is required");
});
