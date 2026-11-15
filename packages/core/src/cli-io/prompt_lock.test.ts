import { describe, test, afterEach } from "node:test";
import { expect } from "expect";
import { confirm, promptLine, readInputLine, lockPrompts, promptsLocked, promptLockedBecause, unlockPromptsForTests } from "./confirm.js";

// A host whose stdin/stdout carry a protocol (the MCP server) locks prompts once. After that nothing may touch either stream.
afterEach(() => unlockPromptsForTests());

describe("prompt lock", () => {
  test("starts unlocked", () => {
    expect(promptsLocked()).toBe(false);
    expect(promptLockedBecause()).toBe(null);
  });

  test("keeps the first reason and stays locked", () => {
    lockPrompts("first");
    lockPrompts("second");
    expect(promptsLocked()).toBe(true);
    expect(promptLockedBecause()).toBe("first");
  });

  test("confirm answers no and writes nothing to stdout", async () => {
    lockPrompts("mcp");
    const writes: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => { writes.push(String(chunk)); return true; }) as typeof process.stdout.write;
    const errs: string[] = [];
    const origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => { errs.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try {
      expect(await confirm("Register you as the sole approver?")).toBe(false);
    } finally {
      process.stdout.write = orig;
      process.stderr.write = origErr;
    }
    expect(writes.join("")).toBe("");
    expect(errs.join("")).toContain("Treated as \"no\"");
  });

  test("promptLine and readInputLine return null without reading stdin", async () => {
    lockPrompts("mcp");
    expect(await promptLine("anything? ")).toBe(null);
    expect(await readInputLine()).toBe(null);
  });
});
