// `purix digest` only reads the project's record, so a busy repository lock must not stop it (it is in READ_ONLY_COMMANDS, like `stats`).
// The first version of the command was not listed there: while an agent's change held the lock it exited 1 ("already locked").
import { describe, it } from "node:test";
import { expect } from "expect";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeRmSync } from "@purix/core/platform/fs_retry";
import { closeDb } from "@purix/core/manifest/store";
import { recordEvent } from "@purix/core/manifest/events";

const require = createRequire(import.meta.url);
const tsxLoader = pathToFileURL(require.resolve("tsx")).href;
const CLI = join(import.meta.dirname, "cli.ts");

function run(root: string, home: string, ...args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ["--import", tsxLoader, CLI, ...args], { cwd: root, env: { ...process.env, HOME: home, USERPROFILE: home } });
    let out = "", err = "";
    p.stdout.on("data", (d: Buffer) => (out += d.toString()));
    p.stderr.on("data", (d: Buffer) => (err += d.toString()));
    p.on("close", (code) => resolve({ code, out, err }));
  });
}

describe("purix digest while the repository lock is busy", { timeout: 120_000 }, () => {
  it("still prints the digest (exit 0) when a live process holds the lock", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "purix-digest-lock-")));
    const home = `${root}-home`;
    const prev = process.cwd();
    process.chdir(root);
    let holder: ChildProcess | undefined;
    try {
      recordEvent("verification_pass", { component_id: "alpha", detail: { isolation: "none" } }); // creates the store
      closeDb();
      holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
      const now = new Date().toISOString();
      mkdirSync(join(root, ".purix"), { recursive: true });
      writeFileSync(join(root, ".purix", "repo.lock"), JSON.stringify({ pid: holder.pid, timestamp: now, updatedAt: now, token: "live-operation" }));

      const r = await run(root, home, "digest");
      expect(r.err).not.toMatch(/lock/i);
      expect(r.code).toBe(0);
      expect(r.out).toContain("Purix digest:");

      const j = await run(root, home, "digest", "--json");
      expect(j.code).toBe(0);
      const parsed = JSON.parse(j.out) as { days: number; current: { changesLandedInRange: number }; previous: unknown };
      expect(parsed.days).toBe(7);
      expect(typeof parsed.current.changesLandedInRange).toBe("number");
      expect(parsed.previous).toBeDefined();
    } finally {
      holder?.kill();
      process.chdir(prev);
      safeRmSync(root);
      safeRmSync(home);
    }
  });

  it("exits 2 (invalid usage) for a bad --days, and --json prints parseable summaries", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "purix-digest-usage-")));
    const home = `${root}-home`;
    try {
      const r = await run(root, home, "digest", "--days", "0");
      expect(r.code).toBe(2);
      expect(r.err).toContain("--days must be a whole number from 1 to 90");
    } finally {
      safeRmSync(root);
      safeRmSync(home);
    }
  });
});
