// The user's default provider (`purix start`): kept in the user's own folder so one setup covers every folder, and a project's own
// choice, and the environment variable, still win over it.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activeProviderId, activeProviderSource, persistProviderChoice, persistCustomProvider, persistUserDefaultProvider, readUserDefaultProvider,
} from "./providers";
import { safeRmSync } from "../platform/fs_retry.js";

describe("user default provider", () => {
  let tmp: string;
  let userFolder: string;
  let a: string;
  let b: string;
  let oldCwd: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "purix-userdefault-"));
    userFolder = join(tmp, "user");
    a = join(tmp, "a");
    b = join(tmp, "b");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    oldCwd = process.cwd();
    delete process.env.PURIX_LLM_PROVIDER;
    process.env.PURIX_USER_DIR = userFolder;
  });
  afterEach(() => {
    process.chdir(oldCwd);
    delete process.env.PURIX_USER_DIR;
    delete process.env.PURIX_LLM_PROVIDER;
    safeRmSync(tmp);
  });

  it("with nothing set, no provider is configured and the error names `purix start`", () => {
    process.chdir(a);
    expect(() => activeProviderId()).toThrow(/No LLM provider is configured/);
    expect(() => activeProviderId()).toThrow(/purix start/);
    expect(activeProviderSource()).toBeNull();
  });

  it("a default saved once is found from any folder", () => {
    persistUserDefaultProvider("anthropic");
    process.chdir(a);
    expect(activeProviderId()).toBe("anthropic");
    expect(activeProviderSource()).toBe("user_default");
    process.chdir(b);
    expect(activeProviderId()).toBe("anthropic");
    expect(readUserDefaultProvider()).toBe("anthropic");
  });

  it("a project's own choice beats the default, but only in that project", () => {
    persistUserDefaultProvider("anthropic");
    process.chdir(a);
    persistProviderChoice("openai", a);
    expect(activeProviderId()).toBe("openai");
    expect(activeProviderSource()).toBe("project");
    process.chdir(b);
    expect(activeProviderId()).toBe("anthropic");
  });

  it("PURIX_LLM_PROVIDER beats both", () => {
    persistUserDefaultProvider("anthropic");
    process.chdir(a);
    persistProviderChoice("openai", a);
    process.env.PURIX_LLM_PROVIDER = "gemini";
    expect(activeProviderId()).toBe("gemini");
    expect(activeProviderSource()).toBe("environment");
  });

  it("refuses an unknown id and refuses custom, so this file can never name a URL", () => {
    expect(() => persistUserDefaultProvider("nope")).toThrow(/cannot be a user default/);
    expect(() => persistUserDefaultProvider("custom")).toThrow(/per project/);
    expect(existsSync(userFolder)).toBe(false);
  });

  it("a file that names custom, an unknown provider or is not an object is ignored", () => {
    mkdirSync(userFolder, { recursive: true });
    const path = join(userFolder, "provider-default.json");
    for (const text of [JSON.stringify({ provider: "custom" }), JSON.stringify({ provider: "nope" }), JSON.stringify([1]), "not json", JSON.stringify({ provider: 5 })]) {
      writeFileSync(path, text);
      expect(readUserDefaultProvider()).toBeNull();
    }
  });

  it("a project's custom endpoint is untouched by a user default, and the default is not used for it", () => {
    persistUserDefaultProvider("anthropic");
    process.chdir(a);
    persistCustomProvider({ baseUrl: "https://api.example.ai/v1", keyEnvVar: "EXAMPLE_API_KEY", modelLow: "s", modelHigh: "l" }, a);
    expect(activeProviderId()).toBe("custom");
    expect(readUserDefaultProvider()).toBe("anthropic");
  });

  it("replacing the default keeps one file, and a damaged file is set aside, not overwritten silently", () => {
    persistUserDefaultProvider("anthropic");
    persistUserDefaultProvider("openai");
    expect(readUserDefaultProvider()).toBe("openai");
    expect(readdirSync(userFolder)).toEqual(["provider-default.json"]);
    writeFileSync(join(userFolder, "provider-default.json"), "{ broken");
    persistUserDefaultProvider("gemini");
    expect(readUserDefaultProvider()).toBe("gemini");
    expect(readdirSync(userFolder).length).toBeGreaterThanOrEqual(2); // the damaged copy was quarantined beside it
  });

  it("is written readable by the owner only (not checked on Windows)", { skip: process.platform === "win32" }, () => {
    persistUserDefaultProvider("openai");
    expect(statSync(join(userFolder, "provider-default.json")).mode & 0o077).toBe(0);
    expect(JSON.parse(readFileSync(join(userFolder, "provider-default.json"), "utf8"))).toEqual({ provider: "openai" });
  });
});
