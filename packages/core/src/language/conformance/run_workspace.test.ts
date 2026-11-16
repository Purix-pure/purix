// packages/core/src/language/conformance/run_workspace.test.ts
import { describe, it } from "node:test";
import { expect } from "expect";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareRuntimeWorkspace } from "./run.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("conformance scratch workspace", () => {
  it("is created under the folder it is given, not where the module lives", () => {
    const root = mkdtempSync(join(tmpdir(), "purix-conf-ws-"));
    try {
      const dir = prepareRuntimeWorkspace(root, "python", resolve(here, "fixtures", "python"));
      expect(dir).toBe(join(root, ".purix", "tmp", "conformance", "python"));
      expect(existsSync(join(dir, "passing.py"))).toBe(true);
      // nothing but .purix appeared in the project folder
      expect(readdirSync(root)).toEqual([".purix"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
