import { describe, it } from "node:test";
import { expect } from "expect";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeRmSync } from "@purix/core/platform/fs_retry";
import { appendPayloadLog, truncatePayload } from "./hook_payload_log.js";

describe("hook payload log (opt-in)", () => {
  it("writes nothing and creates nothing when no file is named", () => {
    const dir = mkdtempSync(join(tmpdir(), "purix-plog-"));
    try {
      appendPayloadLog(undefined, { agent: "cursor", event: "pre-tool-use", raw: "{}", exitCode: 0, stdout: "", stderr: "" });
      expect(existsSync(join(dir, "log.jsonl"))).toBe(false);
    } finally { safeRmSync(dir); }
  });

  it("appends one JSON line per call, with long strings cut so a file body is not copied", () => {
    const dir = mkdtempSync(join(tmpdir(), "purix-plog-"));
    const file = join(dir, "nested", "log.jsonl");
    try {
      const body = "x".repeat(5000);
      appendPayloadLog(file, { agent: "codex", event: "pre-tool-use", raw: JSON.stringify({ tool_name: "apply_patch", tool_input: { command: body } }), exitCode: 2, stdout: "", stderr: "blocked" });
      appendPayloadLog(file, { agent: "codex", event: "stop", raw: "not json", exitCode: 0, stdout: "", stderr: "" });
      const lines = readFileSync(file, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
      expect(lines).toHaveLength(2);
      expect(lines[0].agent).toBe("codex");
      expect(lines[0].exitCode).toBe(2);
      expect(lines[0].payload.tool_name).toBe("apply_patch");
      expect(lines[0].payload.tool_input.command.length).toBeLessThan(300);
      expect(lines[0].payload.tool_input.command).toContain("[+4800 chars]");
      expect(lines[1].payload).toBe("not json");
    } finally { safeRmSync(dir); }
  });

  it("never throws, even when the log path cannot be written", () => {
    expect(() => appendPayloadLog(join(tmpdir(), "purix-no-such-dir-\0bad", "x.jsonl"), { agent: "a", event: "e", raw: "{}", exitCode: 0, stdout: "", stderr: "" })).not.toThrow();
  });

  it("truncatePayload keeps structure and shortens only strings", () => {
    expect(truncatePayload(JSON.stringify({ a: 1, b: [true, "s"], c: { d: "y".repeat(300) } }))).toEqual({ a: 1, b: [true, "s"], c: { d: `${"y".repeat(200)}…[+100 chars]` } });
  });
});
