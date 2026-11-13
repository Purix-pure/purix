import { describe, it } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ensureNodeTestReporter, reporterSpecifier, parseReporterOutput } from "./node_test_reporter";


describe("reporterSpecifier (Windows: an absolute path is not a valid module specifier)", () => {
  it("returns a file:// URL, with spaces and non-ASCII characters encoded", () => {
    const u = reporterSpecifier(process.platform === "win32" ? "C:\\Users\\Zoë Test\\my proj\\.purix\\tmp\\r.mjs" : "/tmp/Zoë Test/my proj/.purix/tmp/r.mjs");
    expect(u.startsWith("file:///")).toBe(true);
    expect(u).not.toContain(" ");
    expect(u.endsWith("/r.mjs")).toBe(true);
    expect(decodeURIComponent(u)).toContain("Zoë Test/my proj");
  });
  it("node --test really runs a custom reporter given as that URL, from a folder with a space in its name", () => {
    const dir = mkdtempSync(join(tmpdir(), "purix rep "));
    try {
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "src", "a.test.mjs"), 'import { test } from "node:test"; import assert from "node:assert"; test("adds", () => assert.equal(1 + 1, 2)); test("bad", () => assert.equal(1, 2));');
      const spec = reporterSpecifier(ensureNodeTestReporter(dir));
      const r = spawnSync(process.execPath, ["--test", `--test-reporter=${spec}`, "--test-reporter-destination=stdout", "src/a.test.mjs"], { cwd: dir, encoding: "utf8", env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "NODE_TEST_CONTEXT")) });
      const tests = parseReporterOutput(r.stdout);
      expect(tests.map((t) => `${t.name}:${t.passed}`).sort()).toEqual(["adds:true", "bad:false"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
