// src/security/deps_audit.real_output.test.ts
//
// N1 (plan 2026-11-07, finding F03-01): a security scan that could not run must never read as "no known vulnerabilities".
//
// The fixtures in ./fixtures/audit are the REAL stdout and exit code of each tool, recorded on 2026-11-07 on Linux against the live
// npm registry (see each *.meta.json for the tool version and command). Nothing in them is written by hand. The tests run
// the real runVulnScan against fake `pnpm`, `yarn` and `npm` executables that replay a recorded output and exit code, so the child
// process, the PATH lookup and the exit code are all real; only the registry call inside the package manager is replayed.
//
// Not covered, because it was not recorded: a real timeout of each tool, Windows, and the registry returning HTTP 410 (see
// research 03 section on JFrog's notice; not reproduced here).
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runVulnScan, formatVulnScan } from "./deps_audit.js";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "audit");
const fixture = (name: string) => join(FIX, `${name}.stdout`);
const meta = (name: string): { exitCode: number; version: string } => JSON.parse(readFileSync(join(FIX, `${name}.meta.json`), "utf-8"));

const FAKE = `#!/bin/sh
if [ -n "$FAKE_SLEEP" ]; then sleep "$FAKE_SLEEP"; fi
if [ -n "$FAKE_ARGS" ] && [ "$*" != "$FAKE_ARGS" ]; then cat "$FAKE_OTHER_STDOUT"; exit "$FAKE_OTHER_EXIT"; fi
cat "$FAKE_STDOUT"
exit "$FAKE_EXIT"
`;

const posix = process.platform !== "win32";
const d = posix ? describe : describe.skip;

d("runVulnScan against recorded real output (N1, F03-01)", () => {
  let work: string;
  let bin: string;
  let savedPath: string | undefined;
  const savedEnv: Record<string, string | undefined> = {};
  const SET = ["FAKE_STDOUT", "FAKE_EXIT", "FAKE_ARGS", "FAKE_OTHER_STDOUT", "FAKE_OTHER_EXIT", "FAKE_SLEEP"];

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "purix-audit-real-"));
    bin = join(work, "bin");
    mkdirSync(bin);
    for (const tool of ["pnpm", "yarn", "npm"]) {
      writeFileSync(join(bin, tool), FAKE);
      chmodSync(join(bin, tool), 0o755);
    }
    savedPath = process.env.PATH;
    for (const k of SET) savedEnv[k] = process.env[k];
    process.env.PATH = `${bin}:${savedPath ?? ""}`;
  });

  afterEach(() => {
    process.env.PATH = savedPath;
    for (const k of SET) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    rmSync(work, { recursive: true, force: true });
  });

  /** A project of the given kind; the tool prints `recorded` and exits with its recorded code. */
  function project(kind: "pnpm" | "npm" | "yarn1" | "yarn4"): string {
    const dir = join(work, `proj-${kind}`);
    mkdirSync(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fx", version: "1.0.0" }));
    if (kind === "pnpm") writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    if (kind === "npm") writeFileSync(join(dir, "package-lock.json"), "{}");
    if (kind === "yarn1") writeFileSync(join(dir, "yarn.lock"), readFileSync(join(FIX, "yarn1.lock.txt")));
    if (kind === "yarn4") writeFileSync(join(dir, "yarn.lock"), readFileSync(join(FIX, "yarn4.lock.txt")));
    return dir;
  }
  function replay(recorded: string, opts: { args?: string; other?: string } = {}) {
    process.env.FAKE_STDOUT = fixture(recorded);
    process.env.FAKE_EXIT = String(meta(recorded).exitCode);
    if (opts.args) {
      process.env.FAKE_ARGS = opts.args;
      process.env.FAKE_OTHER_STDOUT = fixture(opts.other ?? "yarn4_old_command");
      process.env.FAKE_OTHER_EXIT = String(meta(opts.other ?? "yarn4_old_command").exitCode);
    }
  }
  const advisoryCount = (recorded: string) => Object.keys(JSON.parse(readFileSync(fixture(recorded), "utf-8")).advisories).length;
  const yarn4Count = (recorded: string) => readFileSync(fixture(recorded), "utf-8").split("\n").filter((l) => l.trim()).length;

  // ---- a report with advisories must be read as advisories -------------------------------------------------------------
  for (const rec of ["pnpm10_vulnerable", "pnpm11_vulnerable"]) {
    it(`${rec}: every advisory in the real report becomes a finding (it read 0 before the fix)`, () => {
      replay(rec);
      const r = runVulnScan(project("pnpm"));
      expect(r.ran).toBe(true);
      expect(r.findings.length).toBe(advisoryCount(rec));
      expect(r.findings.length).toBeGreaterThan(0);
      const f = r.findings[0]!;
      expect(f.module).toBe("lodash");
      expect(["low", "moderate", "high", "critical"]).toContain(f.severity);
      expect(f.url).toMatch(/^https:\/\/github\.com\/advisories\/GHSA-/);
      expect(f.range).toMatch(/4\.17/);
      expect(formatVulnScan(r)).not.toMatch(/no known vulnerabilities/);
    });
  }

  it("npm10_vulnerable and yarn1_vulnerable still read correctly (controls: these worked before the fix)", () => {
    replay("npm10_vulnerable");
    const a = runVulnScan(project("npm"));
    expect(a.ran).toBe(true);
    expect(a.findings.length).toBeGreaterThan(0);
    replay("yarn1_vulnerable");
    const b = runVulnScan(project("yarn1"));
    expect(b.ran).toBe(true);
    expect(b.findings.length).toBeGreaterThan(0);
  });

  it("yarn 4 (lockfile has __metadata): asks `yarn npm audit`, because `yarn audit` is a usage error there", () => {
    replay("yarn4_vulnerable", { args: "npm audit --json --no-deprecations" });
    const r = runVulnScan(project("yarn4"));
    expect(r.ran).toBe(true);
    expect(r.findings.length).toBe(yarn4Count("yarn4_vulnerable"));
    expect(r.findings[0]!.module).toBe("lodash");
    expect(["low", "moderate", "high", "critical"]).toContain(r.findings[0]!.severity);
  });

  // ---- a report that says "nothing found" is the only thing that may read as clean ---------------------------------------------
  for (const [rec, kind] of [
    ["pnpm10_clean", "pnpm"],
    ["pnpm11_clean", "pnpm"],
    ["npm10_clean", "npm"],
    ["yarn1_clean", "yarn1"],
  ] as const) {
    it(`${rec}: a real clean report reads as clean`, () => {
      replay(rec);
      const r = runVulnScan(project(kind));
      expect(r.ran).toBe(true);
      expect(r.findings).toEqual([]);
      expect(formatVulnScan(r)).toMatch(/no known vulnerabilities/);
    });
  }

  it("yarn4_clean: empty output with exit 0 is how Yarn 4 says clean", () => {
    replay("yarn4_clean", { args: "npm audit --json --no-deprecations" });
    const r = runVulnScan(project("yarn4"));
    expect(r.ran).toBe(true);
    expect(r.findings).toEqual([]);
  });

  // ---- anything else is "could not check", never clean --------------------------------------------------------------------------
  for (const [rec, kind] of [
    ["pnpm10_registry_unreachable", "pnpm"],
    ["npm10_registry_unreachable", "npm"],
  ] as const) {
    it(`${rec}: the tool's error object is not a report (it read as clean before the fix)`, () => {
      replay(rec);
      const r = runVulnScan(project(kind));
      expect(r.ran).toBe(false);
      expect(r.reason).toMatch(/ECONNREFUSED/);
      expect(formatVulnScan(r)).toMatch(/vuln scan skipped/);
      expect(formatVulnScan(r)).not.toMatch(/no known vulnerabilities/);
    });
  }

  it("yarn4_registry_unreachable: text on stdout and exit 1 is not a report", () => {
    replay("yarn4_registry_unreachable", { args: "npm audit --json --no-deprecations" });
    const r = runVulnScan(project("yarn4"));
    expect(r.ran).toBe(false);
    expect(formatVulnScan(r)).not.toMatch(/no known vulnerabilities/);
  });

  it("yarn 4 project where the old `yarn audit` command is what runs: the usage error is not a clean scan", () => {
    // Fake yarn that answers every call with the recorded Yarn 4 usage error, whatever arguments it gets.
    replay("yarn4_old_command");
    const r = runVulnScan(project("yarn4"));
    expect(r.ran).toBe(false);
    expect(formatVulnScan(r)).not.toMatch(/no known vulnerabilities/);
  });

  it("output that is valid JSON but not an audit report is not a clean scan", () => {
    writeFileSync(join(work, "empty.json"), "{}");
    process.env.FAKE_STDOUT = join(work, "empty.json");
    process.env.FAKE_EXIT = "0";
    const r = runVulnScan(project("pnpm"));
    expect(r.ran).toBe(false);
  });

  it("the tool is not installed (yarn project, no yarn on PATH): not a clean scan", () => {
    const empty = join(work, "empty-bin");
    mkdirSync(empty);
    process.env.PATH = empty;
    const r = runVulnScan(project("yarn1"));
    expect(r.ran).toBe(false);
    expect(formatVulnScan(r)).not.toMatch(/no known vulnerabilities/);
  });

  // Independent read 2026-11-10: the code only calls empty output clean "with exit code 0", but no test pinned the exit-code half.
  // With the check removed, a Yarn 4 run that printed nothing and exited 1 (a failed run) read as "no known vulnerabilities".
  it("yarn 4: empty output with a non-zero exit is a failed run, not a clean scan", () => {
    writeFileSync(join(work, "nothing.txt"), "");
    process.env.FAKE_STDOUT = join(work, "nothing.txt");
    process.env.FAKE_EXIT = "1";
    const r = runVulnScan(project("yarn4"));
    expect(r.ran).toBe(false);
    expect(r.reason).toMatch(/exit code 1/);
    expect(formatVulnScan(r)).not.toMatch(/no known vulnerabilities/);
  });

  it("a scan that is stopped by its time limit says so and is not a clean scan", () => {
    replay("pnpm10_clean");
    process.env.FAKE_SLEEP = "5";
    const started = Date.now();
    const r = runVulnScan(project("pnpm"), { deadlineMs: 300 });
    expect(Date.now() - started).toBeLessThan(4000);
    expect(r.ran).toBe(false);
    expect(r.reason).toMatch(/time limit|timed out|timeout/i);
  });
});
