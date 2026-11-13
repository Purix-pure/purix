// src/tools/installer.test.ts
import { describe, it } from "node:test";
import { expect } from "expect";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { binRelPath, installEntry, preflight, type InstallContext } from "./installer.js";
import { hashLockFiles } from "./catalog.js";
import { toolDir } from "./state.js";
import { fakeRunner, npmEntry, pipEntry, tempProject } from "./test_helpers.js";

const NOW = new Date("2026-10-03T00:00:00Z");
function ctx(dir: string, over: Partial<InstallContext> = {}): InstallContext {
  return { baseDir: dir, platform: "linux", now: NOW, runner: fakeRunner(), minReleaseAgeDays: 7, ...over };
}

describe("preflight", () => {
  it("refuses a version released inside the release-age window", () => {
    const e = pipEntry({ releasedAt: "2026-10-01T00:00:00.000Z" });
    const r = preflight(e, { platform: "linux", now: NOW, minReleaseAgeDays: 7 });
    expect(r && !r.ok && r.reason).toBe("too-new");
  });
  it("accepts exactly-old-enough and a zero-day policy", () => {
    expect(preflight(pipEntry({ releasedAt: "2026-09-26T00:00:00.000Z" }), { platform: "linux", now: NOW, minReleaseAgeDays: 7 })).toBeNull();
    expect(preflight(pipEntry({ releasedAt: "2026-10-02T23:00:00.000Z" }), { platform: "linux", now: NOW, minReleaseAgeDays: 0 })).toBeNull();
  });
  it("refuses an unsupported platform", () => {
    const r = preflight(pipEntry({ platforms: ["linux"] }), { platform: "win32", now: NOW, minReleaseAgeDays: 7 });
    expect(r && !r.ok && r.reason).toBe("unsupported-platform");
  });
  it("refuses a lock whose text no longer matches its hash", () => {
    const e = pipEntry();
    e.files["requirements.txt"] += "\n";
    const r = preflight(e, { platform: "linux", now: NOW, minReleaseAgeDays: 7 });
    expect(r && !r.ok && r.reason).toBe("lock-hash-mismatch");
  });
  it("refuses an unhashed lock even when its sha256 is self-consistent", () => {
    const files = { "requirements.txt": "demo==1.2.3\n" };
    const r = preflight(pipEntry({ files, lockSha256: hashLockFiles(files) }), { platform: "linux", now: NOW, minReleaseAgeDays: 7 });
    expect(r && !r.ok && r.reason).toBe("lock-invalid");
  });
});

describe("installEntry (pip-venv)", () => {
  it("creates a venv, installs with hash checking and no scripts or dependency resolution, records the install", () => {
    const p = tempProject();
    try {
      const runner = fakeRunner();
      const out = installEntry(pipEntry(), ctx(p.dir, { runner }));
      expect(out.ok).toBe(true);
      const pipCall = runner.calls.find((c) => c.includes("pip"))!;
      for (const flag of ["--require-hashes", "--only-binary", ":all:", "--no-deps", "--no-input"]) expect(pipCall).toContain(flag);
      expect(pipCall[0]).toContain(join(toolDir(p.dir, "demo"), "venv"));
      expect(readFileSync(join(toolDir(p.dir, "demo"), "requirements.txt"), "utf-8")).toContain("--hash=sha256:");
      expect(existsSync(join(toolDir(p.dir, "demo"), ".gitignore"))).toBe(true);
      expect(out.ok && out.record.binRelPath).toBe("venv/bin/demo");
    } finally { p.cleanup(); }
  });
  it("runtime-missing with a hint when Python is absent", () => {
    const p = tempProject();
    try {
      const out = installEntry(pipEntry(), ctx(p.dir, { runner: fakeRunner({ python: false }) }));
      expect(!out.ok && out.reason).toBe("runtime-missing");
      expect(!out.ok && out.hint).toMatch(/python.org/);
    } finally { p.cleanup(); }
  });
  it("command-failed carries the tool's own error text", () => {
    const p = tempProject();
    try {
      const out = installEntry(pipEntry(), ctx(p.dir, { runner: fakeRunner({ failOn: "--require-hashes" }) }));
      expect(!out.ok && out.reason).toBe("command-failed");
      expect(!out.ok && out.message).toMatch(/boom/);
    } finally { p.cleanup(); }
  });
  it("uses Windows paths on win32", () => {
    expect(binRelPath(pipEntry(), "win32")).toBe("venv/Scripts/demo.exe");
    expect(binRelPath(npmEntry(), "win32")).toBe("node_modules/.bin/demojs.cmd");
  });
});

describe("installEntry (npm-ci)", () => {
  it("runs npm ci with --ignore-scripts from the shipped package.json and lock", () => {
    const p = tempProject();
    try {
      const runner = fakeRunner();
      const out = installEntry(npmEntry(), ctx(p.dir, { runner }));
      expect(out.ok).toBe(true);
      expect(runner.calls[0]).toEqual(["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
      expect(existsSync(join(toolDir(p.dir, "demojs"), "package-lock.json"))).toBe(true);
    } finally { p.cleanup(); }
  });
  it("runtime-missing when npm cannot start", () => {
    const p = tempProject();
    try {
      const out = installEntry(npmEntry(), ctx(p.dir, { runner: fakeRunner({ npmMissing: true }) }));
      expect(!out.ok && out.reason).toBe("runtime-missing");
    } finally { p.cleanup(); }
  });
  it("bin-missing when the install reports success but the binary is not there", () => {
    const p = tempProject();
    try {
      const noop = { calls: [] as string[][], run: () => ({ exitCode: 0, stdout: "", stderr: "" }) };
      const out = installEntry(npmEntry(), ctx(p.dir, { runner: noop }));
      expect(!out.ok && out.reason).toBe("bin-missing");
    } finally { p.cleanup(); }
  });
});
