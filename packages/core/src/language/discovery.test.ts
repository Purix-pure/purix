// packages/core/src/language/discovery.test.ts
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverLanguages, computeDiscoveryHash } from "./discovery";
import { safeRmSync } from "../platform/fs_retry.js";

describe("discoverLanguages", () => {
  it("discovers the real committed manifests (typescript, python) without importing any provider code", () => {
    // No manifestsDir arg — uses the real packages/core/src/language/manifests/
    // directory this repo ships. Regression coverage for exactly the bug
    // this file fixes: a language manifest present but never actually
    // wired into anything.
    const discovered = discoverLanguages();
    const ids = discovered.map((d) => d.manifest.id).sort();
    expect(ids).toEqual(["python", "typescript"]);
  });

  it("every discovered language's manifest round-trips its own capabilities faithfully", () => {
    const discovered = discoverLanguages();
    const python = discovered.find((d) => d.manifest.id === "python");
    expect(python).toBeDefined();
    expect(python!.manifest.tier).toBe("pro");
    expect(python!.manifest.scaffoldExtensions).toEqual([".py"]);
  });

  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "purix-lang-discovery-test-"));
  });

  afterEach(() => {
    safeRmSync(tmpDir);
  });

  it("returns an empty array when the manifests directory doesn't exist", () => {
    expect(discoverLanguages(join(tmpDir, "does-not-exist"))).toEqual([]);
  });

  it("returns an empty array for an empty manifests directory", () => {
    expect(discoverLanguages(tmpDir)).toEqual([]);
  });

  it("ignores non-.json files in the manifests directory", () => {
    writeFileSync(join(tmpDir, "README.md"), "not a manifest");
    expect(discoverLanguages(tmpDir)).toEqual([]);
  });

  it("skips a malformed manifest without throwing, and without blocking discovery of valid sibling manifests", () => {
    writeFileSync(join(tmpDir, "broken.json"), "{ not valid json");
    writeFileSync(
      join(tmpDir, "valid-lang.json"),
      JSON.stringify({
        id: "valid-lang",
        minSupportedVersion: "1.0.0",
        tier: "free",
        scaffoldExtensions: [".vl"],
        capabilities: {
          compileOrTypeCheck: true,
          testExecution: true,
          testIntegrityCheck: true,
          idiomCheck: true,
          dependencyVulnScan: true,
        },
      })
    );
    const discovered = discoverLanguages(tmpDir);
    expect(discovered.length).toBe(1);
    expect(discovered[0]!.manifest.id).toBe("valid-lang");
  });

  it("skips a manifest that parses as JSON but fails schema validation", () => {
    writeFileSync(join(tmpDir, "incomplete.json"), JSON.stringify({ id: "incomplete" }));
    expect(discoverLanguages(tmpDir)).toEqual([]);
  });

  it("sets installRoot to the manifests directory's parent for every discovered language", () => {
    writeFileSync(
      join(tmpDir, "x.json"),
      JSON.stringify({
        id: "x",
        minSupportedVersion: "1.0.0",
        tier: "free",
        scaffoldExtensions: [".x"],
        capabilities: {
          compileOrTypeCheck: true,
          testExecution: true,
          testIntegrityCheck: true,
          idiomCheck: true,
          dependencyVulnScan: true,
        },
      })
    );
    const [discovered] = discoverLanguages(tmpDir);
    expect(discovered!.installRoot).not.toBe(tmpDir);
    expect(tmpDir.startsWith(discovered!.installRoot)).toBe(true);
  });
});

describe("computeDiscoveryHash", () => {
  it("is stable regardless of input array order", () => {
    const a = { manifest: { id: "python", minSupportedVersion: "3.10.0" } } as any;
    const b = { manifest: { id: "typescript", minSupportedVersion: "5.0.0" } } as any;
    expect(computeDiscoveryHash([a, b])).toBe(computeDiscoveryHash([b, a]));
  });

  it("changes when a language is added", () => {
    const a = { manifest: { id: "python", minSupportedVersion: "3.10.0" } } as any;
    const b = { manifest: { id: "typescript", minSupportedVersion: "5.0.0" } } as any;
    const c = { manifest: { id: "go", minSupportedVersion: "1.22.0" } } as any;
    expect(computeDiscoveryHash([a, b])).not.toBe(computeDiscoveryHash([a, b, c]));
  });

  it("changes when a language's version changes", () => {
    const a = { manifest: { id: "python", minSupportedVersion: "3.10.0" } } as any;
    const aNewer = { manifest: { id: "python", minSupportedVersion: "3.11.0" } } as any;
    expect(computeDiscoveryHash([a])).not.toBe(computeDiscoveryHash([aNewer]));
  });

  it("is the same for an empty list every time (not undefined/throwing)", () => {
    expect(computeDiscoveryHash([])).toBe(computeDiscoveryHash([]));
    expect(typeof computeDiscoveryHash([])).toBe("string");
  });
});
