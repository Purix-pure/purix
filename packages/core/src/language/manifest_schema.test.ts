// packages/core/src/language/manifest_schema.test.ts
import { describe, it } from "node:test";
import { expect } from "expect";
import { parseLanguageManifest } from "./manifest_schema";

const VALID = {
  id: "python",
  minSupportedVersion: "3.10.0",
  tier: "pro",
  scaffoldExtensions: [".py"],
  capabilities: {
    compileOrTypeCheck: true,
    testExecution: true,
    testIntegrityCheck: true,
    idiomCheck: true,
    dependencyVulnScan: true,
  },
};

describe("parseLanguageManifest", () => {
  it("accepts a fully valid manifest", () => {
    const result = parseLanguageManifest(VALID, "test");
    expect(result.id).toBe("python");
    expect(result.tier).toBe("pro");
    expect(result.scaffoldExtensions).toEqual([".py"]);
    expect(result.capabilities.compileOrTypeCheck).toBe(true);
  });

  it("rejects a non-object", () => {
    expect(() => parseLanguageManifest("not an object", "test")).toThrow(/not a JSON object/);
    expect(() => parseLanguageManifest(null, "test")).toThrow(/not a JSON object/);
  });

  it("rejects a missing id", () => {
    const { id, ...rest } = VALID;
    expect(() => parseLanguageManifest(rest, "test")).toThrow(/"id"/);
  });

  it("rejects an empty id", () => {
    expect(() => parseLanguageManifest({ ...VALID, id: "" }, "test")).toThrow(/"id"/);
  });

  it("rejects a missing minSupportedVersion", () => {
    const { minSupportedVersion, ...rest } = VALID;
    expect(() => parseLanguageManifest(rest, "test")).toThrow(/minSupportedVersion/);
  });

  it("rejects an invalid tier", () => {
    expect(() => parseLanguageManifest({ ...VALID, tier: "ultra" }, "test")).toThrow(/"tier"/);
  });

  it("rejects a missing tier", () => {
    const { tier, ...rest } = VALID;
    expect(() => parseLanguageManifest(rest, "test")).toThrow(/"tier"/);
  });

  it("rejects a non-array scaffoldExtensions", () => {
    expect(() => parseLanguageManifest({ ...VALID, scaffoldExtensions: ".py" }, "test")).toThrow(/scaffoldExtensions/);
  });

  it("rejects a scaffoldExtensions array with a non-string entry", () => {
    expect(() => parseLanguageManifest({ ...VALID, scaffoldExtensions: [".py", 5] }, "test")).toThrow(/scaffoldExtensions/);
  });

  it("rejects missing capabilities", () => {
    const { capabilities, ...rest } = VALID;
    expect(() => parseLanguageManifest(rest, "test")).toThrow(/capabilities/);
  });

  it("rejects capabilities missing one required key", () => {
    const { dependencyVulnScan, ...restCaps } = VALID.capabilities;
    expect(() => parseLanguageManifest({ ...VALID, capabilities: restCaps }, "test")).toThrow(/capabilities/);
  });

  it("rejects capabilities with a non-boolean value", () => {
    expect(() =>
      parseLanguageManifest({ ...VALID, capabilities: { ...VALID.capabilities, idiomCheck: "yes" } }, "test")
    ).toThrow(/capabilities/);
  });

  it("includes the source description in the thrown error for debuggability", () => {
    expect(() => parseLanguageManifest(null, "@purix/lang-bogus/purix.language.json")).toThrow(
      /@purix\/lang-bogus\/purix\.language\.json/
    );
  });
});
