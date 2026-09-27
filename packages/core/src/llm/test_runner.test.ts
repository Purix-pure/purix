// TEST-REPORT F10: the create prompt used to hard-code Bun's test runner for every project.
import { describe, it } from "node:test";
import { expect } from "expect";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectTestRunner, testRunnerGuidance } from "./test_runner";

function withProject(files: Record<string, string>, fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "purix-runner-"));
  try {
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("detectTestRunner", () => {
  it("defaults to node when there is no package.json", () => {
    withProject({}, (dir) => expect(detectTestRunner(dir)).toBe("node"));
  });
  it("detects node:test from a --test script (this repo's own style)", () => {
    withProject({ "package.json": JSON.stringify({ scripts: { test: "tsx --test src/**/*.test.ts" } }) }, (dir) => expect(detectTestRunner(dir)).toBe("node"));
  });
  it("detects bun, vitest, jest and mocha from the test script", () => {
    for (const [script, want] of [["bun test", "bun"], ["vitest run", "vitest"], ["jest --ci", "jest"], ["mocha spec/", "mocha"]] as const) {
      withProject({ "package.json": JSON.stringify({ scripts: { test: script } }) }, (dir) => expect(detectTestRunner(dir)).toBe(want));
    }
  });
  it("reads jest/mocha/bun from dependencies and tolerates an unparseable package.json", () => {
    withProject({ "package.json": JSON.stringify({ dependencies: { "@jest/globals": "^29" } }) }, (dir) => expect(detectTestRunner(dir)).toBe("jest"));
    withProject({ "package.json": JSON.stringify({ devDependencies: { mocha: "^10" } }) }, (dir) => expect(detectTestRunner(dir)).toBe("mocha"));
    withProject({ "package.json": JSON.stringify({ devDependencies: { "@types/bun": "*" } }) }, (dir) => expect(detectTestRunner(dir)).toBe("bun"));
    withProject({ "package.json": "{ broken", "bun.lockb": "" }, (dir) => expect(detectTestRunner(dir)).toBe("bun"));
    withProject({ "package.json": "{ broken" }, (dir) => expect(detectTestRunner(dir)).toBe("node"));
    withProject({ "package.json": JSON.stringify({ scripts: { test: "echo no tests" } }) }, (dir) => expect(detectTestRunner(dir)).toBe("node"));
  });
  it("falls back to declared dependencies, then to a bun lockfile", () => {
    withProject({ "package.json": JSON.stringify({ devDependencies: { vitest: "^2" } }) }, (dir) => expect(detectTestRunner(dir)).toBe("vitest"));
    withProject({ "package.json": "{}", "bun.lock": "" }, (dir) => expect(detectTestRunner(dir)).toBe("bun"));
  });
});

describe("testRunnerGuidance", () => {
  it("never mentions bun:test for a node project", () => {
    const text = testRunnerGuidance("node");
    expect(text).toContain("node:test");
    expect(text).not.toContain("bun:test");
  });
  it("gives vitest, jest and mocha their own imports", () => {
    expect(testRunnerGuidance("vitest")).toContain('from "vitest"');
    expect(testRunnerGuidance("jest")).toContain('from "@jest/globals"');
    expect(testRunnerGuidance("mocha")).toContain('from "mocha"');
  });
  it("still tells a bun project to import from bun:test", () => {
    expect(testRunnerGuidance("bun")).toContain('from "bun:test"');
  });
});
