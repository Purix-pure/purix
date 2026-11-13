// scripts/check-tool-boundary.test.ts
import { describe, it } from "node:test";
import { expect } from "expect";
import { findViolations } from "./check-tool-boundary.ts";

const scan = (rel, text) => findViolations([{ rel, text }]).map((f) => f.rule);

describe("check-tool-boundary", () => {
  it("flags each way of installing or running a tool by hand outside tools/", () => {
    expect(scan("verify/x.ts", 'spawnSync(["npx", "jest"])')).toEqual(["B2"]);
    expect(scan("language/x.ts", 'spawnSync([pip, "install", "pytest"])')).toEqual([]); // variable first arg: not matched, stated limit
    expect(scan("language/x.ts", 'run(["pip", "install", "pytest==8"])')).toEqual(["B1"]);
    expect(scan("language/x.ts", 'const cmd = "pip install ruff";')).toEqual(["B1"]);
    expect(scan("language/x.ts", 'spawnSync(["npm", "install", "typescript"])')).toEqual(["B3"]);
    expect(scan("language/x.ts", 'spawnSync(["npm", "ci"])')).toEqual(["B3"]);
    expect(scan("language/x.ts", 'spawnSync(["python", "-m", "venv", dir])')).toEqual(["B4"]);
    expect(scan("language/x.ts", 'spawnSync(["pytest", "tests/"])')).toEqual(["B5"]);
    expect(scan("language/x.ts", 'spawnSync(["ruff"])')).toEqual(["B5"]);
    expect(scan("language/x.ts", 'runIsolated( [ "eslint", "--format", "json" ] )')).toEqual(["B5"]);
  });
  it("allows the broker itself", () => {
    expect(scan("tools/installer.ts", 'run(["npm", "ci"]); run(["python", "-m", "venv", v]); run([pip, "install"])')).toEqual([]);
  });
  it("ignores comments and test files", () => {
    expect(scan("verify/x.ts", "// never use npx here\n/* pip install is gone */\nconst a = 1;")).toEqual([]);
    expect(findViolations([{ rel: "verify/x.test.ts", text: 'run(["npx","jest"])' }])).toEqual([]);
    expect(findViolations([{ rel: "tools/test_helpers.ts", text: 'run(["npx"])' }])).toEqual([]);
  });
  it("does not mistake the project's own package-manager audit, or a tool NAME in data, for an install", () => {
    expect(scan("security/deps_audit.ts", 'spawnSync(["npm", "audit", "--json"])')).toEqual([]);
    expect(scan("verify/tests.ts", 'const framework = "jest"; if (framework === "vitest") {}')).toEqual([]);
  });
  it("does not mistake a list of tool ids, or a dependency lookup, for a spawn", () => {
    expect(scan("language/x.ts", 'const IDS = { python: ["pyright", "pytest", "ruff"] };')).toEqual([]);
    expect(scan("language/x.ts", 'if (deps["tsx"] || deps["jest"]) return true;')).toEqual([]);
  });
  it("reports the line number", () => {
    const f = findViolations([{ rel: "verify/x.ts", text: "a\nb\nspawn([\"npx\"])\n" }])[0];
    expect(f.line).toBe(3);
  });
});
