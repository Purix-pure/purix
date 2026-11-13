// PURIX-21 D12: the extension table is built from language manifests, fails closed on unclaimed and
// ambiguous extensions, and the shipped manifests reproduce the table registry.ts used to hardcode.
import { describe, it } from "node:test";
import { expect } from "expect";
import { buildExtensionTable, extensionOf, languageForExtensionTable } from "./extension_table";
import { discoverLanguages, type DiscoveredLanguage } from "./discovery";
import { languageForFile } from "./registry";
import { parseLanguageManifest } from "./manifest_schema";

const caps = { compileOrTypeCheck: true, testExecution: true, testIntegrityCheck: true, idiomCheck: true, dependencyVulnScan: true };
function lang(id: string, scaffold: string[], file?: string[]): DiscoveredLanguage {
  return {
    manifest: { id, minSupportedVersion: "1.0.0", tier: "free", scaffoldExtensions: scaffold, ...(file ? { fileExtensions: file } : {}), capabilities: caps },
    manifestPath: `/m/${id}.json`,
    installRoot: "/m",
  };
}

describe("extensionOf", () => {
  it("lower-cases, ignores dotfiles and dots in directory names", () => {
    expect(extensionOf("src/A.TSX")).toBe(".tsx");
    expect(extensionOf(".gitignore")).toBeUndefined();
    expect(extensionOf("dir.v2/Makefile")).toBeUndefined();
    expect(extensionOf("C:\\proj\\mod.py")).toBe(".py");
    expect(extensionOf("noext")).toBeUndefined();
  });
});

describe("buildExtensionTable", () => {
  it("uses fileExtensions when present and scaffoldExtensions otherwise", () => {
    const t = buildExtensionTable([lang("a", [".a"], [".a", ".aa"]), lang("b", [".b"])]);
    expect(languageForExtensionTable("x.aa", t)).toBe("a");
    expect(languageForExtensionTable("x.b", t)).toBe("b");
  });

  it("treats an extension two languages claim as unclaimed, never first-wins", () => {
    const t = buildExtensionTable([lang("a", [".h"]), lang("b", [".h"])]);
    expect(languageForExtensionTable("x.h", t)).toBeUndefined();
    expect(t.ambiguous.get(".h")).toEqual(["a", "b"]);
  });

  it("returns undefined for an extension nobody claims", () => {
    expect(languageForExtensionTable("main.go", buildExtensionTable([lang("a", [".a"])]))).toBeUndefined();
  });
});

describe("shipped manifests", () => {
  it("reproduce the extension table registry.ts used to hardcode", () => {
    for (const f of ["a.ts", "a.tsx", "a.mts", "a.cts", "a.js", "a.jsx", "a.mjs", "a.cjs"]) expect(languageForFile(f)).toBe("typescript");
    expect(languageForFile("a.py")).toBe("python");
    for (const f of ["a.go", "a.rs", "a.rb", "a.json", "README.md", "Makefile", ".gitignore"]) expect(languageForFile(f)).toBeUndefined();
  });

  it("claim no extension twice", () => {
    expect(buildExtensionTable(discoverLanguages()).ambiguous.size).toBe(0);
  });
});

describe("manifest schema: fileExtensions", () => {
  const base = { id: "x", minSupportedVersion: "1.0.0", tier: "free", scaffoldExtensions: [".x"], capabilities: caps };
  it("accepts a valid list and keeps it", () => {
    expect(parseLanguageManifest({ ...base, fileExtensions: [".x", ".xx"] }, "t").fileExtensions).toEqual([".x", ".xx"]);
  });
  it("is optional", () => {
    expect(parseLanguageManifest(base, "t").fileExtensions).toBeUndefined();
  });
  it("rejects entries without a dot or with upper case", () => {
    expect(() => parseLanguageManifest({ ...base, fileExtensions: ["x"] }, "t")).toThrow(/fileExtensions/);
    expect(() => parseLanguageManifest({ ...base, fileExtensions: [".X"] }, "t")).toThrow(/fileExtensions/);
    expect(() => parseLanguageManifest({ ...base, fileExtensions: ".x" }, "t")).toThrow(/fileExtensions/);
  });
});
