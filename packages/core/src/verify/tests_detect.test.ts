// detectTestFramework(): every signal it reads (dependency, config file, test-file content, tsconfig).
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectTestFramework } from "./tests";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "purix-detect-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const pkg = (o: object) => writeFileSync(join(dir, "package.json"), JSON.stringify(o));

describe("detectTestFramework", () => {
  it("detects jest, vitest and mocha from dependencies, in that priority order", () => {
    pkg({ devDependencies: { jest: "1", vitest: "1", mocha: "1" } });
    expect(detectTestFramework(dir, [])).toBe("jest");
    pkg({ devDependencies: { vitest: "1", mocha: "1" } });
    expect(detectTestFramework(dir, [])).toBe("vitest");
    pkg({ dependencies: { mocha: "1" } });
    expect(detectTestFramework(dir, [])).toBe("mocha");
  });
  it("detects each from its config file when there is no dependency", () => {
    for (const [file, want] of [["jest.config.js", "jest"], ["jest.config.ts", "jest"], ["vitest.config.js", "vitest"], ["vitest.config.ts", "vitest"], [".mocharc.json", "mocha"], [".mocharc.yml", "mocha"]] as const) {
      const d = mkdtempSync(join(tmpdir(), "purix-detect-cfg-"));
      try {
        writeFileSync(join(d, file), "");
        expect(detectTestFramework(d, [])).toBe(want);
      } finally {
        rmSync(d, { recursive: true, force: true });
      }
    }
  });
  it("chooses node:test from @types/node, or from a test file that imports node:test", () => {
    pkg({ devDependencies: { "@types/node": "*" } });
    expect(detectTestFramework(dir, [])).toBe("node:test");
    pkg({});
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "a.test.ts"), 'import { test } from "node:test";');
    expect(detectTestFramework(dir, ["src/a.test.ts"])).toBe("node:test");
  });
  it("falls back to node:test when a tsconfig exists, and returns null when there is no signal at all", () => {
    pkg({});
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "b.test.ts"), "console.log('plain')");
    expect(detectTestFramework(dir, ["src/b.test.ts", "src/missing.test.ts"])).toBeNull();
    writeFileSync(join(dir, "tsconfig.json"), "{}");
    expect(detectTestFramework(dir, ["src/b.test.ts"])).toBe("node:test");
  });
  it("tolerates a corrupt package.json", () => {
    writeFileSync(join(dir, "package.json"), "{ nope");
    expect(detectTestFramework(dir, [])).toBeNull();
  });
});
