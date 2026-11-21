// `purix start` through the real CLI. With no terminal it must refuse and change nothing; the provider default it saves must be seen
// from other folders; the front door must point to it. (The question-and-answer part is tested in cli/start_flow.test.ts.)
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { mkdtempSync, mkdirSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeRmSync } from "@purix/core/platform/fs_retry";

const tsxLoader = createRequire(import.meta.url).resolve("tsx");

describe("purix start (real CLI, no terminal)", () => {
  let root: string;
  let userDir: string;
  let work: string;
  const run = (args: string[], cwd: string, extraEnv: Record<string, string> = {}) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env, HOME: join(root, "home"), USERPROFILE: join(root, "home"), PURIX_USER_DIR: userDir, PURIX_SECRET_BACKEND: "file",
      PURIX_LLM_PROVIDER: "", GEMINI_API_KEY: "", ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", ...extraEnv,
    };
    const r = spawnSync(process.execPath, ["--import", pathToFileURL(tsxLoader).href, join(import.meta.dirname, "cli.ts"), ...args], { cwd, env, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "purix-start-e2e-"));
    userDir = join(root, "userdir");
    work = join(root, "work");
    mkdirSync(join(root, "home"), { recursive: true });
    mkdirSync(work, { recursive: true });
  });
  afterEach(() => safeRmSync(root));

  it("refuses without a terminal, names the manual steps, and creates nothing", () => {
    const r = run(["start"], work);
    expect(r.status).toBe(1);
    expect(r.out).toContain("needs a person at a terminal");
    expect(r.out).toContain("purix secret set <KEY_NAME>");
    expect(readdirSync(work)).toEqual([]); // no .purix in the folder
    // Nothing saved in the user folder either: no provider default, no key store (the local usage ledger every command writes is not ours).
    const saved = existsSync(userDir) ? readdirSync(userDir) : [];
    expect(saved.filter((f) => f !== "usage-ledger.jsonl")).toEqual([]);
  });

  it("is listed first under 'Start here' in help", () => {
    const r = run(["--help"], work);
    const startHere = r.out.slice(r.out.indexOf("Start here"));
    expect(startHere.indexOf("start ")).toBeGreaterThan(-1);
    expect(startHere.indexOf("start ")).toBeLessThan(startHere.indexOf("connect "));
    expect(r.out).toContain("purix start");
  });

  it("the 'init'-style guesses now point to it", () => {
    const r = run(["init"], work);
    expect(r.out).toContain("First-time setup is: purix start");
    expect(r.out).not.toContain("Purix sets itself up the first time");
  });

  it("a saved default provider is seen from a different folder", () => {
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, "provider-default.json"), JSON.stringify({ provider: "anthropic" }));
    const other = join(root, "elsewhere", "deep");
    mkdirSync(other, { recursive: true });
    const r = run(["provider", "status"], other);
    expect(r.out).toContain("Active provider: anthropic");
    expect(r.out).toContain("NOT FOUND");
    expect(r.out).toContain("ANTHROPIC_API_KEY");
  });

  it("with no provider anywhere, `create` says to run purix start", () => {
    const r = run(["create", "a csv to json converter"], work);
    expect(r.out).toContain("No LLM provider is configured");
    expect(r.out).toContain("purix start");
  });
});
