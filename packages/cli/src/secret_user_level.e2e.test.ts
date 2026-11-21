// End to end, through the real CLI: a key stored in one folder is found from another, the environment variable wins, an old per-folder
// store is found from a subfolder and reported, and `purix secret migrate` refuses to run without a person at a terminal.
// Spawns the CLI the way cli.integration.test.ts does. The keyring is not touched: PURIX_USER_DIR holds Purix on the encrypted file.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeRmSync } from "@purix/core/platform/fs_retry";
import { createSecretsStore } from "@purix/core/security/secrets_manager";

const tsxLoader = createRequire(import.meta.url).resolve("tsx");

describe("purix secret / provider status with a user-level store", () => {
  let root: string;
  let userDir: string;
  let a: string;
  let b: string;

  const run = (args: string[], cwd: string, extraEnv: Record<string, string> = {}, input?: string) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: join(root, "home"), USERPROFILE: join(root, "home"), PURIX_USER_DIR: userDir, PURIX_SECRET_BACKEND: "file", PURIX_LLM_PROVIDER: "openai", ...extraEnv };
    delete env.OPENAI_API_KEY;
    if (extraEnv.OPENAI_API_KEY) env.OPENAI_API_KEY = extraEnv.OPENAI_API_KEY;
    const r = spawnSync(process.execPath, ["--import", pathToFileURL(tsxLoader).href, join(import.meta.dirname, "cli.ts"), ...args], { cwd, env, encoding: "utf-8", input, timeout: 60_000 });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "purix-secret-e2e-"));
    userDir = join(root, "userdir");
    a = join(root, "a");
    b = join(root, "b", "nested");
    mkdirSync(join(root, "home"), { recursive: true });
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
  });
  afterEach(() => safeRmSync(root));

  it("a key stored in folder A is found from folder B", () => {
    const set = run(["secret", "set", "OPENAI_API_KEY"], a, {}, "sk-e2e-test-key-1234567890\n");
    expect(set.out).toContain("Stored");
    expect(set.out).toContain("It is found from any folder");
    const status = run(["provider", "status"], b);
    expect(status.out).toContain("API key (OPENAI_API_KEY): found in your user-level Purix store");
    expect(status.out).not.toContain("NOT FOUND");
    expect(status.out).not.toContain("sk-e2e-test-key");
  });

  it("the environment variable is used first, and the status says a different stored key is not used", () => {
    run(["secret", "set", "OPENAI_API_KEY"], a, {}, "sk-e2e-stored-key-1234567890\n");
    const status = run(["provider", "status"], a, { OPENAI_API_KEY: "sk-e2e-env-key-0987654321" });
    expect(status.out).toContain("found in the environment (used before stored keys)");
    expect(status.out).toContain("DIFFERENT value that is not used");
  });

  it("an old per-folder store is found from a subfolder of the folder it was saved in, and reported", () => {
    createSecretsStore(join(a, ".purix")).setSecret("OPENAI_API_KEY", "sk-e2e-old-folder-key-1234");
    const sub = join(a, "src", "deep");
    mkdirSync(sub, { recursive: true });
    const fromSub = run(["provider", "status"], sub);
    expect(fromSub.out).toContain("found only in an OLD per-folder key store");
    expect(fromSub.out).toContain("purix secret migrate");
    expect(fromSub.out).not.toContain("sk-e2e-old-folder-key");
    const elsewhere = run(["provider", "status"], b);
    expect(elsewhere.out).toContain("NOT FOUND");
  });

  it("`purix secret migrate` will not run without a person at a terminal, and changes nothing", () => {
    createSecretsStore(join(a, ".purix")).setSecret("OPENAI_API_KEY", "sk-e2e-old-folder-key-1234");
    const moved = run(["secret", "migrate"], a);
    expect(moved.out).toContain("needs a person at a terminal");
    const after = run(["provider", "status"], b);
    expect(after.out).toContain("NOT FOUND");
  });
});
