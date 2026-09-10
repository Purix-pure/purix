// packages/core/src/llm/budget_worktree.test.ts
//
// ADR-041's Consequences section explicitly calls for: "a specific stress
// test... two concurrent runs on two worktrees of the same repository,
// both near the burn-guard ceiling at once, confirming the
// conditional-update form holds and neither run observes a stale 'under
// ceiling' read." budget.test.ts's "concurrency reservation" test makes
// two SEQUENTIAL in-process calls — real, but not what this ADR asked
// for. This file is that test: two genuinely separate OS processes
// (via child_process.spawn, not Promise.all in one process), each
// running from its own real `git worktree`, racing to reserve budget
// against the SAME shared ledger at (as close as Node allows) the same
// instant.
//
// This also incidentally verifies the OTHER half of ADR-041: that the two
// worktrees' shared state actually resolves to the same file. If
// git_common_dir.ts were wrong, each worktree would silently get its own
// ceiling and BOTH spawns would report "success" — this test would only
// catch that bug because it checks that outcome explicitly.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSharedStateDir } from "../state/git_common_dir";
import { resolveTsxCommand } from "../test-support/real_node_modules";

// A worker's cwd is a bare git worktree with no node_modules of its own,
// so it can't resolve a bare "tsx" import itself — run tsx's own binary
// from THIS package's node_modules directly instead of relying on
// module resolution to find it from the worktree.
const tsxCommand = resolveTsxCommand();

let repoDir: string;
let worktreeA: string;
let worktreeB: string;

function git(args: string[], cwd: string) {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), "purix-worktree-main-"));
  git(["init", "-q"], repoDir);
  git(["config", "user.email", "test@purix.local"], repoDir);
  git(["config", "user.name", "Purix Test"], repoDir);
  // Need at least one commit before `git worktree add` can create a branch off it.
  writeFileSync(join(repoDir, "seed.txt"), "x\n");
  git(["add", "seed.txt"], repoDir);
  git(["commit", "-q", "-m", "seed"], repoDir);

  worktreeA = mkdtempSync(join(tmpdir(), "purix-worktree-a-"));
  worktreeB = mkdtempSync(join(tmpdir(), "purix-worktree-b-"));
  rmSync(worktreeA, { recursive: true, force: true });
  rmSync(worktreeB, { recursive: true, force: true });
  git(["worktree", "add", "-q", "-b", "branch-a", worktreeA], repoDir);
  git(["worktree", "add", "-q", "-b", "branch-b", worktreeB], repoDir);
});

afterEach(() => {
  try {
    git(["worktree", "remove", "--force", worktreeA], repoDir);
  } catch {}
  try {
    git(["worktree", "remove", "--force", worktreeB], repoDir);
  } catch {}
  rmSync(repoDir, { recursive: true, force: true });
  rmSync(worktreeA, { recursive: true, force: true });
  rmSync(worktreeB, { recursive: true, force: true });
});

function spawnWorker(cwd: string, estimatedCost: string, ceiling: string): Promise<{ result: string; message?: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      tsxCommand[0]!,
      [...tsxCommand.slice(1), join(import.meta.dirname, "budget_race_worker.ts"), estimatedCost],
      {
        cwd,
        env: { ...process.env, PURIX_COST_CEILING_USD: ceiling },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      const line = stdout.trim().split("\n").filter(Boolean).pop();
      if (!line) return reject(new Error(`worker produced no output (exit ${code}). stderr: ${stderr}`));
      try {
        resolvePromise(JSON.parse(line));
      } catch {
        reject(new Error(`worker produced non-JSON output: ${line}. stderr: ${stderr}`));
      }
    });
  });
}

describe("ADR-041: real multi-process worktree concurrency", () => {
  it("two worktrees of the same repo share the same resolved state directory", () => {
    // Called explicitly with each worktree's path (rather than relying on
    // process.cwd()), since this test doesn't chdir.
    const dirA = resolveSharedStateDir(worktreeA);
    const dirB = resolveSharedStateDir(worktreeB);
    expect(dirA).toBe(dirB);
    expect(dirA).not.toContain(worktreeA);
    expect(dirA).not.toContain(worktreeB);
  });

  it("two concurrent OS processes on two worktrees, racing near the ceiling, ensure only one succeeds", async () => {
    // Ceiling fits exactly one $0.08 reservation, not two.
    const [resultA, resultB] = await Promise.all([
      spawnWorker(worktreeA, "0.08", "0.10"),
      spawnWorker(worktreeB, "0.08", "0.10"),
    ]);

    const results = [resultA.result, resultB.result].sort();
    // The critical assertion: exactly one success and one failure. If the
    // shared-state resolution were broken (each worktree silently got its
    // own ledger), both would report "success" — that failure mode is
    // exactly what this test exists to catch. If the atomic UPDATE were
    // wrong (a stale read-then-write race), both could ALSO report
    // "success" despite sharing state, which this assertion catches too.
    expect(results).toEqual(["fail", "success"]);

    // The failing one must fail for the RIGHT reason: either a genuine
    // ceiling trip, or (under real contention) an honest "couldn't
    // confirm budget, refusing rather than risk an unchecked spend" —
    // never a raw, uncaught SQLite driver error escaping as a crash.
    const failed = resultA.result === "fail" ? resultA : resultB;
    expect(failed.message).toMatch(/Cost guardrail tripped|temporarily unavailable due to high concurrent load/);

    // Confirm the shared ledger file actually landed at the common dir,
    // not under either worktree.
    const sharedDir = resolveSharedStateDir(worktreeA);
    expect(existsSync(join(sharedDir, "manifest.db"))).toBe(true);
    expect(existsSync(join(worktreeA, ".purix", "manifest.db"))).toBe(false);
    expect(existsSync(join(worktreeB, ".purix", "manifest.db"))).toBe(false);
  });

  it("ten concurrent worker processes across two worktrees never jointly exceed the ceiling", async () => {
    // Broader stress version: 10 workers total (5 per worktree), ceiling
    // fits exactly 3 of the $0.10 reservations. Confirms the invariant
    // holds under higher contention, not just a two-process race.
    const ceiling = "0.30";
    const cost = "0.10";
    const workers = [
      ...Array(5).fill(worktreeA),
      ...Array(5).fill(worktreeB),
    ].map((dir) => spawnWorker(dir, cost, ceiling));

    const results = await Promise.all(workers);
    const successCount = results.filter((r) => r.result === "success").length;

    // The safety property ADR-041 exists for: successes must NEVER exceed
    // what the ceiling allows (0.30 / 0.10 = 3). Under contention it's
    // safe (if conservative) for a legitimate reservation to be refused
    // defensively rather than succeed — that's not a violation — but it
    // must never let MORE than 3 through.
    expect(successCount).toBeLessThanOrEqual(3);
    expect(successCount).toBeGreaterThan(0); // sanity: not everything failed

    for (const r of results.filter((r) => r.result === "fail")) {
      // Every denial must be an honest, typed refusal — a real ceiling
      // trip or an honest contention refusal — never a raw, uncaught
      // SQLite driver error escaping as a crash.
      expect(r.message).toMatch(/Cost guardrail tripped|temporarily unavailable due to high concurrent load/);
    }
  });
});