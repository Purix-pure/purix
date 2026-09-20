// src/entrypoints/scaffold.test.ts
//
// Previously zero test coverage on this file (GAPS-REPORT-2 §4), despite
// writeScaffold being the write path every brand-new component goes
// through. Covers detectScaffoldLanguage's extension-based dispatch
// directly, and an end-to-end regression for the false-positive bug it
// fixes: a scaffold plan whose FIRST file isn't the representative one.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, symlinkSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeScaffold, buildManifestEntry, detectScaffoldLanguage } from "./scaffold";
import type { TopologyPlan } from "../manifest/schema";

const thisDir = dirname(fileURLToPath(import.meta.url));

describe("detectScaffoldLanguage", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "purix-scaffold-lang-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("detects python from any file's extension, not just the first", () => {
    const lang = detectScaffoldLanguage(
      [{ path: "README.md" }, { path: "src/main.py" }],
      "comp-x",
      tmpDir
    );
    expect(lang).toBe("python");
  });

  it("detects rust, go, and ruby by extension", () => {
    expect(detectScaffoldLanguage([{ path: "main.rs" }], "comp-x", tmpDir)).toBe("rust");
    expect(detectScaffoldLanguage([{ path: "main.go" }], "comp-x", tmpDir)).toBe("go");
    expect(detectScaffoldLanguage([{ path: "main.rb" }], "comp-x", tmpDir)).toBe("ruby");
  });

  it("falls back to resolveLanguage() (whole-repo detection) when no file has a recognized non-TS/JS extension", () => {
    writeFileSync(join(tmpDir, "tsconfig.json"), "{}");
    const lang = detectScaffoldLanguage([{ path: "index.ts" }], "comp-x", tmpDir);
    expect(lang).toBe("typescript");
  });
});

describe("writeScaffold", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "purix-scaffold-test-"));
    writeFileSync(
      join(tmpDir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true, target: "ES2022" }, include: ["**/*.ts"] })
    );
    // verifyComponent() only looks for TypeScript under baseDir's own
    // node_modules (no global/npx fallback — see verify.ts) — symlink
    // this package's real, already-installed typescript in so the
    // happy-path test below actually exercises a real tsc run instead
    // of unconditionally hitting "not_installed".
    mkdirSync(join(tmpDir, "node_modules"));
    const tsDir = resolve(thisDir, "../../node_modules/typescript");
    if (process.platform === "win32") {
      cpSync(tsDir, join(tmpDir, "node_modules", "typescript"), { recursive: true, dereference: true });
    } else {
      symlinkSync(tsDir, join(tmpDir, "node_modules", "typescript"));
    }
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes and verifies a valid TypeScript component", async () => {
    const plan: TopologyPlan = {
      component_id: "comp-ts",
      component_type: "module",
      files: [{ path: "index.ts", purpose: "entry", starter_content: "export const x: number = 1;\n" }],
      depends_on: [],
    };
    const paths = await writeScaffold(plan, tmpDir);
    expect(paths.length).toBe(1);
    expect(existsSync(join(tmpDir, "index.ts"))).toBe(true);
  });

  it("rolls back every written file when verification fails", async () => {
    const plan: TopologyPlan = {
      component_id: "comp-broken",
      component_type: "module",
      files: [
        { path: "ok.ts", purpose: "entry", starter_content: "export const x = 1;\n" },
        { path: "broken.ts", purpose: "entry", starter_content: "export const y: number = 'not a number';\n" },
      ],
      depends_on: [],
    };
    await expect(writeScaffold(plan, tmpDir)).rejects.toThrow(/failed verification/);
    expect(existsSync(join(tmpDir, "ok.ts"))).toBe(false);
    expect(existsSync(join(tmpDir, "broken.ts"))).toBe(false);
  });

  it("regression (GAPS-REPORT-2 §4): a plan whose FIRST file isn't representative no longer falls through to tsc and false-passes a broken non-TS file", async () => {
    // Before the fix: plan.files[0] is "README.md" (doesn't end in
    // ".py"), so language defaulted to "typescript" — tsc -p only
    // checks files matching the tsconfig's "**/*.ts" include glob,
    // never touches main.py at all, and reports a trivial pass
    // regardless of what's inside it.
    const plan: TopologyPlan = {
      component_id: "comp-py",
      component_type: "module",
      files: [
        { path: "README.md", purpose: "docs", starter_content: "# A python component\n" },
        { path: "main.py", purpose: "entry", starter_content: "def broken(:\n    pass\n" },
      ],
      depends_on: [],
    };

    // Whether this environment has a Python type-checker installed or
    // not, the one outcome that must NEVER happen is a silent "pass"
    // that never actually looked at main.py — that's exactly what the
    // pre-fix "typescript" default produced.
    let caught: unknown;
    try {
      await writeScaffold(plan, tmpDir);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeTruthy();
    expect((caught as Error).message).not.toMatch(/^Scaffold failed — could not determine a language/);
    // Rolled back either way.
    expect(existsSync(join(tmpDir, "README.md"))).toBe(false);
    expect(existsSync(join(tmpDir, "main.py"))).toBe(false);
  });
});

describe("buildManifestEntry", () => {
  it("builds a version-1 manifest entry with instruction provenance", () => {
    const plan: TopologyPlan = {
      component_id: "comp-x",
      component_type: "module",
      files: [{ path: "index.ts", purpose: "entry", starter_content: "" }],
      depends_on: ["comp-y"],
    };
    const entry = buildManifestEntry(plan);
    expect(entry.component_id).toBe("comp-x");
    expect(entry.current_version).toBe(1);
    expect(entry.files).toEqual(["index.ts"]);
    expect(entry.depends_on).toEqual(["comp-y"]);
    expect(entry.version_history[0]?.provenance.source_type).toBe("instruction");
    expect(entry.version_history[0]?.provenance.source_agent).toBe(null);
  });

  it("passes through an explicit source_agent when given", () => {
    const plan: TopologyPlan = {
      component_id: "comp-x",
      component_type: "module",
      files: [],
      depends_on: [],
    };
    const entry = buildManifestEntry(plan, "agent-42");
    expect(entry.version_history[0]?.provenance.source_agent).toBe("agent-42");
  });
});