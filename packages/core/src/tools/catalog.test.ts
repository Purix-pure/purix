// src/tools/catalog.test.ts
import { describe, it } from "node:test";
import { expect } from "expect";
import { hashLockFiles, shippedCatalog, validateCatalog, validateEntry, filterCatalog } from "./catalog.js";
import { npmEntry, pipEntry } from "./test_helpers.js";

describe("shipped catalog", () => {
  it("has zero validation problems", () => {
    expect(validateCatalog(shippedCatalog())).toEqual([]);
  });
  it("contains exactly the tools Purix already uses (v1)", () => {
    expect(shippedCatalog().map((e) => e.id).sort()).toEqual(["eslint", "jest", "mocha", "pip-audit", "pyright", "pytest", "ruff", "tsx", "typescript", "vitest"]);
  });
  it("every entry was released at least 7 days ago (the release-age gate would pass today)", () => {
    for (const e of shippedCatalog()) expect(Date.now() - Date.parse(e.releasedAt)).toBeGreaterThan(7 * 86_400_000);
  });
  it("the pytest lock keeps its Windows-only dependency, so a Windows install under --require-hashes is complete", () => {
    const pytest = shippedCatalog().find((e) => e.id === "pytest")!;
    expect(pytest.files["requirements.txt"]).toMatch(/colorama==\S+ ; sys_platform == 'win32'/);
  });
  it("every pip lock line carries a sha256 hash and every npm package has sha512 integrity", () => {
    for (const e of shippedCatalog()) {
      if (e.method === "pip-venv") expect(e.files["requirements.txt"]).not.toMatch(/--hash=(?!sha256:)/);
      else expect(e.files["package-lock.json"]).toMatch(/"integrity": "sha512-/);
    }
  });
});

describe("validateEntry", () => {
  it("accepts well-formed entries", () => {
    expect(validateEntry(pipEntry())).toEqual([]);
    expect(validateEntry(npmEntry())).toEqual([]);
  });
  it("rejects a range version", () => {
    expect(validateEntry(pipEntry({ version: "^1.2.3" })).join(" ")).toMatch(/exact version/);
  });
  it("rejects an unhashed requirement", () => {
    const files = { "requirements.txt": "demo==1.2.3\n" };
    expect(validateEntry(pipEntry({ files, lockSha256: hashLockFiles(files) })).join(" ")).toMatch(/--hash/);
  });
  it("rejects an unpinned requirement", () => {
    const files = { "requirements.txt": `demo>=1 \\\n    --hash=sha256:${"a".repeat(64)}\n` };
    expect(validateEntry(pipEntry({ files, lockSha256: hashLockFiles(files) })).length).toBeGreaterThan(0);
  });
  it("rejects a non-sha256 hash", () => {
    const files = { "requirements.txt": `demo==1.2.3 \\\n    --hash=md5:${"a".repeat(32)}\n` };
    expect(validateEntry(pipEntry({ files, lockSha256: hashLockFiles(files) })).length).toBeGreaterThan(0);
  });
  it("rejects option lines such as an extra index URL", () => {
    const files = { "requirements.txt": `--extra-index-url https://evil.example/simple\ndemo==1.2.3 \\\n    --hash=sha256:${"a".repeat(64)}\n` };
    expect(validateEntry(pipEntry({ files, lockSha256: hashLockFiles(files) })).join(" ")).toMatch(/option line/);
  });
  it("rejects a lock whose text was edited after hashing", () => {
    const e = pipEntry();
    e.files["requirements.txt"] += "# edited\n";
    expect(validateEntry(e).join(" ")).toMatch(/lockSha256/);
  });
  it("rejects an npm lock package without integrity", () => {
    const e = npmEntry();
    const lock = JSON.parse(e.files["package-lock.json"]!);
    delete lock.packages["node_modules/demojs"].integrity;
    const files = { ...e.files, "package-lock.json": JSON.stringify(lock) };
    expect(validateEntry({ ...e, files, lockSha256: hashLockFiles(files) }).join(" ")).toMatch(/integrity/);
  });
  it("rejects npm package.json that depends on something else", () => {
    const e = npmEntry();
    const files = { ...e.files, "package.json": JSON.stringify({ dependencies: { demojs: "^2.0.0" } }) };
    expect(validateEntry({ ...e, files, lockSha256: hashLockFiles(files) }).join(" ")).toMatch(/exactly/);
  });
});

describe("catalog data and generator agree", () => {
  it("every committed lockSha256 equals a fresh hash of its files", () => {
    for (const e of shippedCatalog()) expect(e.lockSha256).toBe(hashLockFiles(e.files));
  });
});

describe("filterCatalog", () => {
  it("filters by group, capability and language, sorted by group then id", () => {
    const all = shippedCatalog();
    expect(filterCatalog(all, { group: "testing" }).map((e) => e.id)).toEqual(["jest", "mocha", "pytest", "tsx", "vitest"]);
    expect(filterCatalog(all, { language: "python", capability: "lint" }).map((e) => e.id)).toEqual(["ruff"]);
  });
});
