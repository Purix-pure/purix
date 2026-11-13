// What a first-time user hits in a folder with no project in it (IDEA-090): commands that fail must say what to do
// next and must not leave a store behind, and `create` / `change` settle provider, language and compiler before
// they spend a model call.
import { describe, it } from "node:test";
import { expect } from "expect";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { mkdtempSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeRmSync } from "@purix/core/platform/fs_retry";

const require = createRequire(import.meta.url);
const tsxLoader = require.resolve("tsx");
const cliEntry = join(import.meta.dirname, "cli.ts");

const NO_PROVIDER_ENV = { GEMINI_API_KEY: "", ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", PURIX_LLM_PROVIDER: "" };
const WITH_KEY_ENV = { ...NO_PROVIDER_ENV, PURIX_LLM_PROVIDER: "gemini", GEMINI_API_KEY: "test-key-never-used" };

function run(args: string[], cwd: string, env: Record<string, string> = NO_PROVIDER_ENV): { status: number | null; output: string } {
  const home = mkdtempSync(join(tmpdir(), "purix-fr-home-"));
  try {
    const r = spawnSync(process.execPath, ["--import", pathToFileURL(tsxLoader).href, cliEntry, ...args], {
      cwd,
      env: { ...process.env, HOME: home, USERPROFILE: home, PURIX_USER_DIR: join(home, ".purix"), APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"), ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"], // no terminal
      timeout: 60_000,
    });
    return { status: r.status, output: `${r.stdout}${r.stderr}` };
  } finally {
    safeRmSync(home);
  }
}

function inFreshFolder(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "purix-fr-"));
  try {
    fn(dir);
  } finally {
    safeRmSync(dir);
  }
}

describe("orientation for a new user", () => {
  it("default help starts with where to begin, and lists `create`", () => {
    inFreshFolder((dir) => {
      const r = run(["--help"], dir);
      expect(r.output).toContain("Start here:");
      expect(r.output).toContain("First steps:");
      expect(r.output).toMatch(/purix create "what you want to build"/);
      expect(r.output).toMatch(/^\s{2}create\b/m);
      expect(r.output).not.toContain("--all");
    });
  });

  it("`purix init` is not a command, and the error says where to start instead", () => {
    inFreshFolder((dir) => {
      const r = run(["init"], dir);
      expect(r.status).toBe(1);
      expect(r.output).toContain("unknown command 'init'");
      expect(r.output).toContain('purix create "what you want to build"');
      expect(r.output).toContain("purix connect");
      expect(readdirSync(dir)).toEqual([]);
    });
  });

  it("any other unknown command points at the help page", () => {
    inFreshFolder((dir) => {
      const r = run(["frobnicate"], dir);
      expect(r.status).toBe(1);
      expect(r.output).toContain('Run "purix --help" to see every command.');
    });
  });
});

describe("commands that fail in a folder with no project leave no store behind", () => {
  const cases: string[][] = [["delete", "nothing"], ["adopt", "src/a.ts"], ["ingest", "nothing", "x.diff"], ["login"], ["reconcile"]];
  for (const args of cases) {
    it(`purix ${args.join(" ")}`, () => {
      inFreshFolder((dir) => {
        run(args, dir);
        expect(existsSync(join(dir, ".purix", "manifest.db"))).toBe(false);
        expect(existsSync(join(dir, ".purix", "usage-ledger.jsonl"))).toBe(false);
      });
    });
  }

  it("`purix login` without a terminal says it needs one", () => {
    inFreshFolder((dir) => {
      const r = run(["login"], dir);
      expect(r.status).toBe(1);
      expect(r.output).toContain("needs a terminal");
    });
  });

  it("`purix reconcile` says there is nothing to reconcile", () => {
    inFreshFolder((dir) => {
      const r = run(["reconcile"], dir);
      expect(r.status).toBe(0);
      expect(r.output).toContain("nothing to reconcile");
    });
  });

  it("`purix tier-status` names the number as a limit", () => {
    inFreshFolder((dir) => {
      const r = run(["tier-status"], dir);
      expect(r.output).toContain("Component limit");
      expect(r.output).not.toContain("Tracked components");
    });
  });
});

describe("create settles its prerequisites before any model call or write", () => {
  it("no provider: says so, before it says it is planning", () => {
    inFreshFolder((dir) => {
      const r = run(["create", "a csv to json converter"], dir);
      expect(r.status).toBe(1);
      expect(r.output).toContain("No LLM provider is configured");
      expect(r.output).toContain("Nothing was sent to the model and nothing was written.");
      expect(r.output).not.toContain("Planning");
      expect(readdirSync(dir).filter((f) => f !== ".purix")).toEqual([]);
      expect(existsSync(join(dir, ".purix", "manifest.db"))).toBe(false);
    });
  });

  it("provider set, key missing: names the variable and the command to store it", () => {
    inFreshFolder((dir) => {
      const r = run(["create", "a csv to json converter"], dir, { ...NO_PROVIDER_ENV, PURIX_LLM_PROVIDER: "gemini" });
      expect(r.status).toBe(1);
      expect(r.output).toContain("GEMINI_API_KEY");
      expect(r.output).toContain("purix secret set GEMINI_API_KEY");
      expect(r.output).not.toContain("Planning");
    });
  });

  it("empty folder, nobody to ask: does not pick TypeScript for you", () => {
    inFreshFolder((dir) => {
      const r = run(["create", "a csv to json converter"], dir, WITH_KEY_ENV);
      expect(r.status).toBe(1);
      expect(r.output).toContain("no language to follow");
      expect(r.output).toContain("purix config set language typescript");
      expect(r.output).not.toContain("Planning");
      expect(existsSync(join(dir, ".purix", "manifest.db"))).toBe(false);
    });
  });

  it("language chosen, compiler missing: names the install command and does not plan", () => {
    inFreshFolder((dir) => {
      expect(run(["config", "set", "language", "typescript"], dir, WITH_KEY_ENV).status).toBe(0);
      const r = run(["create", "a csv to json converter"], dir, WITH_KEY_ENV);
      expect(r.status).toBe(1);
      expect(r.output).toContain("typescript 5.7.2 (not installed)");
      expect(r.output).toContain("purix tools install typescript");
      expect(r.output).not.toContain("Planning");
    });
  });

  it("a sentence is treated as the request, not as an id", () => {
    inFreshFolder((dir) => {
      const r = run(["create", "a csv to json converter", "--dry-run"], dir);
      expect(r.output).not.toContain("invalid component");
      expect(r.output).toContain("No LLM provider is configured");
    });
  });
});

describe("change in a folder with nothing tracked", () => {
  it("goes straight to the new-component path: no model call to match components that do not exist", () => {
    inFreshFolder((dir) => {
      const r = run(["change", "add a login page"], dir, WITH_KEY_ENV);
      expect(r.status).toBe(1);
      expect(r.output).toContain("Nothing is tracked here yet");
      expect(r.output).toContain("no language to follow");
      expect(r.output).not.toContain("Transient error");
      expect(r.output).not.toContain("LLM-assisted matching");
    });
  });
});
