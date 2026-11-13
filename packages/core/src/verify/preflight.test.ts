// src/verify/preflight.test.ts
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeRmSync } from "../platform/fs_retry.js";
import { preflightVerification, formatPreflight } from "./preflight";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "purix-preflight-"));
});
afterEach(() => safeRmSync(dir));

/** A project-local binary under node_modules/.bin is how locateTool finds the project's own tool. */
function projectTool(name: string): void {
  mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(dir, "node_modules", ".bin", name), "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(join(dir, "node_modules", ".bin", `${name}.cmd`), "@echo off\n");
}

describe("preflightVerification", () => {
  it("a TypeScript component with no compiler is blocked, with the install command", () => {
    const p = preflightVerification(["src/a.ts"], dir);
    expect(p.map((x) => x.tool)).toEqual(["typescript"]);
    expect(formatPreflight(p)).toMatch(/Nothing was sent to the model/);
    expect(formatPreflight(p)).toMatch(/purix tools install typescript/);
  });

  it("a component with no TypeScript files is never blocked on the compiler", () => {
    expect(preflightVerification(["a.py", "README.md"], dir)).toEqual([]);
  });

  it("a test file with a detected framework and no runner is blocked; with the runner present it is not", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ devDependencies: { "@types/node": "22" } }));
    projectTool("tsc");
    const blocked = preflightVerification(["src/a.ts", "src/a.test.ts"], dir);
    expect(blocked.map((x) => x.tool)).toEqual(["tsx"]);
    projectTool("tsx");
    expect(preflightVerification(["src/a.ts", "src/a.test.ts"], dir)).toEqual([]);
  });

  it("no test files in the component: the runner is not required", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ devDependencies: { "@types/node": "22" } }));
    projectTool("tsc");
    expect(preflightVerification(["src/a.ts"], dir)).toEqual([]);
  });

  it("formatPreflight returns null when nothing is missing", () => {
    expect(formatPreflight([])).toBeNull();
  });
});
