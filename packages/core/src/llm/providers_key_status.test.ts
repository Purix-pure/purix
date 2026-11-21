// PURIX-21 G11: `purix provider status` must say where the key comes from (stored, environment or
// missing) without ever returning the key. This pins the lookup order and the shape.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerKeyStatus, persistProviderChoice, persistCustomProvider } from "./providers";
import { setSecret, deleteSecret } from "../security/secrets_manager";
import { safeRmSync } from "../platform/fs_retry.js";

describe("providerKeyStatus", () => {
  let tmpDir: string;
  let oldCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "purix-keystatus-"));
    oldCwd = process.cwd();
    process.chdir(tmpDir);
    delete process.env.PURIX_LLM_PROVIDER;
    delete process.env.OPENAI_API_KEY;
    delete process.env.MY_CUSTOM_KEY;
  });

  afterEach(() => {
    process.chdir(oldCwd);
    safeRmSync(tmpDir);
    delete process.env.OPENAI_API_KEY;
    delete process.env.MY_CUSTOM_KEY;
    deleteSecret("OPENAI_API_KEY");
    deleteSecret("MY_CUSTOM_KEY");
  });

  it("reports missing when neither the store nor the environment has the key", () => {
    expect(providerKeyStatus("openai")).toEqual({ envVar: "OPENAI_API_KEY", source: "missing", conflict: false });
  });

  it("reports environment when only the environment has it", () => {
    process.env.OPENAI_API_KEY = "sk-env";
    expect(providerKeyStatus("openai")).toEqual({ envVar: "OPENAI_API_KEY", source: "environment", conflict: false });
  });

  it("reports stored, and the store wins over the environment, like the real call (and flags the difference)", () => {
    process.env.OPENAI_API_KEY = "sk-env";
    setSecret("OPENAI_API_KEY", "sk-stored");
    expect(providerKeyStatus("openai")).toEqual({ envVar: "OPENAI_API_KEY", source: "stored", conflict: true });
  });

  it("never exposes the key value", () => {
    setSecret("OPENAI_API_KEY", "sk-super-secret");
    expect(JSON.stringify(providerKeyStatus("openai"))).not.toContain("sk-super-secret");
  });

  it("uses the active provider when no id is given", () => {
    persistProviderChoice("openai", tmpDir);
    process.env.OPENAI_API_KEY = "sk-env";
    expect(providerKeyStatus()?.envVar).toBe("OPENAI_API_KEY");
  });

  it("returns undefined for an unknown provider and for custom with no custom block", () => {
    expect(providerKeyStatus("no-such-provider")).toBeUndefined();
    expect(providerKeyStatus("custom")).toBeUndefined();
  });

  it("follows the custom provider's own key variable", () => {
    persistCustomProvider({ baseUrl: "http://localhost:11434/v1", keyEnvVar: "MY_CUSTOM_KEY", modelLow: "a", modelHigh: "b" }, tmpDir);
    process.env.MY_CUSTOM_KEY = "k";
    expect(providerKeyStatus("custom")).toEqual({ envVar: "MY_CUSTOM_KEY", source: "environment", conflict: false });
  });

  it("flags a conflict when the stored key differs from the environment key (the stored one is used)", () => {
    process.env.OPENAI_API_KEY = "sk-env";
    setSecret("OPENAI_API_KEY", "sk-stored");
    expect(providerKeyStatus("openai")).toEqual({ envVar: "OPENAI_API_KEY", source: "stored", conflict: true });
  });
});

import { keyRefusedNote } from "./providers";
describe("keyRefusedNote", () => {
  let tmp: string;
  let prev: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "purix-refused-"));
    prev = process.cwd();
    process.chdir(tmp);
  });
  afterEach(() => {
    process.chdir(prev);
    safeRmSync(tmp);
  });
  it("names the stored copy and the unused environment copy on a refused key", () => {
    process.env.OPENAI_API_KEY = "sk-env";
    setSecret("OPENAI_API_KEY", "sk-stored");
    try {
      const note = keyRefusedNote(400, '{"error":{"message":"API key not valid"}}', "OPENAI_API_KEY");
      expect(note).toContain("stored in Purix");
      expect(note).toContain("NOT used");
      expect(note).not.toContain("sk-stored");
    } finally {
      delete process.env.OPENAI_API_KEY;
      deleteSecret("OPENAI_API_KEY");
    }
  });
  it("adds nothing for an unrelated failure", () => {
    expect(keyRefusedNote(500, "boom", "OPENAI_API_KEY")).toBe("");
    expect(keyRefusedNote(400, "bad request: missing field", "OPENAI_API_KEY")).toBe("");
  });
});
