// packages/cli/src/load_env.test.ts
// Periodic security check 2026-10-15, poc2: a project .env must not be able to turn on the approval bypass.
// Tested on Linux against simulated payloads.
import { describe, it } from "node:test";
import { expect } from "expect";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyProjectEnv, isProjectEnvNameAllowed, loadProjectEnv } from "./load_env.js";

describe("project .env filtering", () => {
  it("still loads an API key", () => {
    const env: Record<string, string | undefined> = {};
    const r = applyProjectEnv({ OPENAI_API_KEY: "sk-test", MY_CUSTOM_PROVIDER_KEY: "k" }, env);
    expect(env.OPENAI_API_KEY).toBe("sk-test");
    expect(env.MY_CUSTOM_PROVIDER_KEY).toBe("k");
    expect(r.ignored).toEqual([]);
  });

  it("ignores the approval bypass and the tier override", () => {
    const env: Record<string, string | undefined> = {};
    const r = applyProjectEnv({ NODE_ENV: "test", AUTO_CONFIRM: "1", PURIX_DEV_TIER: "pro", OPENAI_API_KEY: "sk" }, env);
    expect(env.NODE_ENV).toBeUndefined();
    expect(env.AUTO_CONFIRM).toBeUndefined();
    expect(env.PURIX_DEV_TIER).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBe("sk");
    expect(r.ignored.sort()).toEqual(["AUTO_CONFIRM", "NODE_ENV", "PURIX_DEV_TIER"]);
  });

  it("ignores where Purix sends licence checks and events, and the provider switch", () => {
    for (const name of ["PURIX_API_URL", "PURIX_WEBHOOK_URL", "PURIX_WEBHOOK_SECRET", "PURIX_USER_DIR", "PURIX_LLM_PROVIDER", "PURIX_COST_CEILING_USD"]) {
      expect(isProjectEnvNameAllowed(name)).toBe(false);
    }
  });

  it("ignores runtime, library-loading and network settings", () => {
    for (const name of ["NODE_OPTIONS", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "PATH", "HOME", "HTTPS_PROXY", "https_proxy", "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED", "PYTHONPATH", "CI"]) {
      expect(isProjectEnvNameAllowed(name)).toBe(false);
    }
  });

  it("allows a per-provider model name", () => {
    expect(isProjectEnvNameAllowed("PURIX_OPENAI_MODEL_LOW")).toBe(true);
    expect(isProjectEnvNameAllowed("PURIX_OPENAI_MODEL_HIGH")).toBe(true);
  });

  it("never replaces a variable that is already set", () => {
    const env: Record<string, string | undefined> = { OPENAI_API_KEY: "from-shell" };
    const r = applyProjectEnv({ OPENAI_API_KEY: "from-file" }, env);
    expect(env.OPENAI_API_KEY).toBe("from-shell");
    expect(r.applied).toEqual([]);
  });

  it("reads a real .env file and applies the same rules", () => {
    const dir = mkdtempSync(join(tmpdir(), "purix-env-"));
    try {
      writeFileSync(join(dir, ".env"), "NODE_ENV=test\nAUTO_CONFIRM=1\nGROQ_API_KEY=gk\n");
      const env: Record<string, string | undefined> = {};
      const r = loadProjectEnv(dir, env);
      expect(env).toEqual({ GROQ_API_KEY: "gk" });
      expect(r.ignored.sort()).toEqual(["AUTO_CONFIRM", "NODE_ENV"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does nothing when there is no .env", () => {
    const dir = mkdtempSync(join(tmpdir(), "purix-env-"));
    try {
      const env: Record<string, string | undefined> = {};
      expect(loadProjectEnv(dir, env)).toEqual({ applied: [], ignored: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the real start-up import leaves the bypass off when a project .env asks for it (poc2)", () => {
    const dir = mkdtempSync(join(tmpdir(), "purix-env-boot-"));
    try {
      writeFileSync(join(dir, ".env"), "NODE_ENV=test\nAUTO_CONFIRM=1\nGROQ_API_KEY=gk\n");
      const boot = fileURLToPath(new URL("./load_env_boot.ts", import.meta.url));
      const tsx = import.meta.resolve("tsx");
      const script = join(dir, "run.mjs");
      writeFileSync(script, `await import(${JSON.stringify(pathToFileURL(boot).href)}); console.log([process.env.NODE_ENV, process.env.AUTO_CONFIRM, process.env.GROQ_API_KEY].join("|"));`);
      const clean = { ...process.env };
      delete clean.NODE_ENV;
      delete clean.AUTO_CONFIRM;
      delete clean.GROQ_API_KEY;
      const run = spawnSync(process.execPath, ["--import", tsx, script], { cwd: dir, env: clean, encoding: "utf8" });
      expect(run.stdout.trim()).toBe("||gk"); // join() prints an unset variable as an empty string
      expect(run.stderr).toContain("ignored NODE_ENV, AUTO_CONFIRM");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stays silent on stderr for the hook command", () => {
    const dir = mkdtempSync(join(tmpdir(), "purix-env-boot-"));
    try {
      writeFileSync(join(dir, ".env"), "NODE_ENV=test\n");
      const boot = fileURLToPath(new URL("./load_env_boot.ts", import.meta.url));
      const tsx = import.meta.resolve("tsx");
      const script = join(dir, "run.mjs");
      writeFileSync(script, `await import(${JSON.stringify(pathToFileURL(boot).href)});`);
      const run = spawnSync(process.execPath, ["--import", tsx, script, "hook"], { cwd: dir, encoding: "utf8" });
      expect(run.stderr).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
